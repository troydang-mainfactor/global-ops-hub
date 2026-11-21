// Regex parser for the two inbound PO email formats (reference/po-email-formats.md).
// Pure functions: no DB, no network. The AI fallback lives in ai-fallback.ts.

import { baseSku, normalizeSku, normalizeWarehouseCode } from "../sku";
import { isoDate, parseLooseDate } from "./dates";

export type EmailKind = "issued" | "shipped";

export interface ParsedEmail {
  kind: EmailKind;
  orderNo: string; // PO094330 | SO0058136
  orderKind: "PO" | "SO";
  sku: string; // base SKU
  skuRaw: string; // SKU as written (may be a variant)
  componentLabel: string | null; // "Hand Cuffs (Component)"
  warehouseCode: string; // normalized, e.g. "MAINF MI"
  designName: string | null;
  orderType: string | null; // issued only
  tracking: string[]; // shipped only
  deliveryDate: string | null; // YYYY-MM-DD, shipped only
  deliveryDateRaw: string | null;
  bodyWarehouseCode: string | null; // shipped body "Warehouse:" line, for cross-checking
  productionTaskUrl: string | null;
  /** Fields we expected but could not read. Non-empty → candidate for AI fill-in. */
  missing: string[];
}

export interface EmailInput {
  subject: string;
  body: string; // plain text (use htmlToText() first if only HTML exists)
  receivedAt?: Date;
}

export type ParseResult =
  | { ok: true; data: ParsedEmail }
  | { ok: false; reason: string };

const ORDER = String.raw`((?:PO|SO)\d+)`;
const PREFIX = String.raw`^\s*(?:(?:re|fwd?|fw)\s*:\s*)*`;

// New Order {SKU}/ {ORDER_NO}/ {WAREHOUSE}
const ISSUED_SUBJECT = new RegExp(`${PREFIX}New\\s+Order\\s+(.+?)\\s*\\/\\s*${ORDER}\\s*\\/\\s*(.+?)\\s*$`, "i");
// {ORDER_NO} /{SKU}[ - suffix] / {WAREHOUSE}
const SHIPPED_SUBJECT = new RegExp(`${PREFIX}${ORDER}\\s*\\/\\s*(.+?)\\s*\\/\\s*([^/]+?)\\s*$`, "i");

const ASANA_LINK = /Sent from Asana:\s*(https:\/\/app\.asana\.com\/\S+)/i;
const ANY_ASANA_LINK = /(https:\/\/app\.asana\.com\/\S+\/task\/\d+\S*)/i;

export function classifySubject(subject: string): EmailKind | null {
  if (ISSUED_SUBJECT.test(subject)) return "issued";
  if (SHIPPED_SUBJECT.test(subject)) return "shipped";
  return null;
}

function splitSkuAndLabel(raw: string): { skuRaw: string; componentLabel: string | null } {
  const m = raw.trim().match(/^(\S+)(?:\s+-\s+(.+))?$/);
  if (!m) return { skuRaw: normalizeSku(raw), componentLabel: null };
  return { skuRaw: normalizeSku(m[1]), componentLabel: m[2]?.trim() || null };
}

function lines(body: string): string[] {
  return body.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
}

function labelled(body: string, label: string): string | null {
  const m = body.match(new RegExp(`^\\s*${label}\\s*:[ \\t]*(.*)$`, "im"));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

function asanaLink(body: string): string | null {
  const m = body.match(ASANA_LINK) ?? body.match(ANY_ASANA_LINK);
  return m ? m[1].replace(/[>)\].,]+$/, "") : null;
}

/** Splits "1Z…/1Z… , 1Z…" into unique tracking numbers. */
export function splitTracking(raw: string | null): string[] {
  if (!raw) return [];
  const out = raw
    .replace(/\[?\s*no value\s*\]?/gi, " ")
    .split(/[\/,;\s]+/)
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z0-9]{6,}$/.test(t));
  return [...new Set(out)];
}

/** Value on the line(s) after a heading line like "Tracking:" up to the next heading. */
function blockAfter(ls: string[], heading: string, stops: string[]): string | null {
  const i = ls.findIndex((l) => new RegExp(`^${heading}\\s*:`, "i").test(l));
  if (i === -1) return null;
  const sameLine = ls[i].replace(new RegExp(`^${heading}\\s*:\\s*`, "i"), "").trim();
  const vals: string[] = sameLine ? [sameLine] : [];
  for (let j = i + 1; j < ls.length; j++) {
    const l = ls[j];
    if (stops.some((s) => new RegExp(`^${s}\\s*:`, "i").test(l)) || /^Sent from Asana/i.test(l)) break;
    if (l) vals.push(l);
  }
  const v = vals.join(" ").trim();
  return v || null;
}

function parseIssued(subjectMatch: RegExpMatchArray, body: string): ParsedEmail {
  const { skuRaw, componentLabel } = splitSkuAndLabel(subjectMatch[1]);
  const orderNo = subjectMatch[2].toUpperCase();
  const warehouseCode = normalizeWarehouseCode(subjectMatch[3]);
  const bodySku = labelled(body, "SKU");
  const designName = labelled(body, "Design Name");
  const orderType = labelled(body, "Order Type");
  const productionTaskUrl = asanaLink(body);
  const missing: string[] = [];
  if (!designName) missing.push("designName");
  if (!productionTaskUrl) missing.push("productionTaskUrl");
  if (bodySku && baseSku(bodySku) !== baseSku(skuRaw)) missing.push("skuMismatch");
  return {
    kind: "issued",
    orderNo,
    orderKind: orderNo.startsWith("SO") ? "SO" : "PO",
    sku: baseSku(skuRaw),
    skuRaw,
    componentLabel,
    warehouseCode,
    designName,
    orderType,
    tracking: [],
    deliveryDate: null,
    deliveryDateRaw: null,
    bodyWarehouseCode: null,
    productionTaskUrl,
    missing,
  };
}

function parseShipped(subjectMatch: RegExpMatchArray, body: string, ref: Date): ParsedEmail {
  const orderNo = subjectMatch[1].toUpperCase();
  const { skuRaw, componentLabel } = splitSkuAndLabel(subjectMatch[2]);
  const warehouseCode = normalizeWarehouseCode(subjectMatch[3]);
  const ls = lines(body);

  // Design name: the line(s) between the SKU line and "Tracking:".
  let designName: string | null = null;
  const trackIdx = ls.findIndex((l) => /^Tracking\s*:/i.test(l));
  if (trackIdx > 0) {
    const introIdx = ls.findIndex((l) => /has shipped from the vendor/i.test(l));
    const between = ls.slice(introIdx + 1, trackIdx).filter(Boolean);
    const skuLine = between.findIndex((l) => baseSku(l) === baseSku(skuRaw));
    const rest = skuLine === -1 ? between.slice(1) : between.slice(skuLine + 1);
    designName = rest.join(" ").trim() || null;
  }

  const trackingRaw = blockAfter(ls, "Tracking", ["Delivery Date", "Warehouse"]);
  const deliveryRaw = blockAfter(ls, "Delivery Date", ["Warehouse", "Tracking"]);
  const bodyWarehouse = blockAfter(ls, "Warehouse", ["Tracking", "Delivery Date"]);
  const tracking = splitTracking(trackingRaw);
  const deliveryDate = isoDate(parseLooseDate(deliveryRaw, ref));
  const productionTaskUrl = asanaLink(body);

  const missing: string[] = [];
  if (!designName) missing.push("designName");
  if (tracking.length === 0) missing.push("tracking");
  if (deliveryRaw && !deliveryDate && !/no value/i.test(deliveryRaw)) missing.push("deliveryDate");
  if (!productionTaskUrl) missing.push("productionTaskUrl");

  return {
    kind: "shipped",
    orderNo,
    orderKind: orderNo.startsWith("SO") ? "SO" : "PO",
    sku: baseSku(skuRaw),
    skuRaw,
    componentLabel,
    warehouseCode,
    designName,
    orderType: null,
    tracking,
    deliveryDate,
    deliveryDateRaw: deliveryRaw,
    bodyWarehouseCode: bodyWarehouse ? normalizeWarehouseCode(bodyWarehouse) : null,
    productionTaskUrl,
    missing,
  };
}

export function parseEmail(input: EmailInput): ParseResult {
  const subject = input.subject.replace(/\s+/g, " ").trim();
  const body = input.body ?? "";
  const ref = input.receivedAt ?? new Date();

  const issued = subject.match(ISSUED_SUBJECT);
  if (issued) return { ok: true, data: parseIssued(issued, body) };

  const shipped = subject.match(SHIPPED_SUBJECT);
  if (shipped && /has shipped|tracking\s*:/i.test(body)) return { ok: true, data: parseShipped(shipped, body, ref) };
  if (shipped) return { ok: false, reason: "subject looks like a shipped email but the body does not" };

  return { ok: false, reason: "subject matches neither known format" };
}

/** Minimal HTML → text for messages that have no text/plain part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => `${text} ${href}`)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}
