// Regex parser for the two inbound PO email formats (reference/po-email-formats.md).
// Pure functions: no DB, no network. The AI fallback lives in ai-fallback.ts.

import { baseSku, normalizeSku, normalizeWarehouseCode } from "../sku";
import { isoDate, parseLooseDate } from "./dates";

export type EmailKind = "issued" | "shipped";

export interface ParsedEmail {
  kind: EmailKind;
  orderNo: string; // PO094330 | SO0058136
  orderKind: "PO" | "SO" | "TO"; // TO = transfer order
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

// Order number, or "[no value]" (happens now and then; the PO number is then taken from the PDF).
const ORDER = String.raw`((?:PO|SO|TO)\d+|\[\s*no value\s*\])`;
// Re:/Fwd: and bracket tags added by mail rules, e.g. "[Shipped] " or "[New Order] " (but not "[no value]").
const PREFIX = String.raw`^\s*(?:(?:re|fwd?|fw)\s*:\s*|\[(?!\s*no value)[^\]]{1,30}\]\s*)*`;
const NO_VALUE = /^\[\s*no value\s*\]$/i;

// New Order {SKU}/ {ORDER_NO}/ {WAREHOUSE}
const ISSUED_SUBJECT = new RegExp(`${PREFIX}New\\s+Order\\s+(.+?)\\s*\\/\\s*${ORDER}\\s*\\/\\s*(.+?)\\s*$`, "i");
// {ORDER_NO} /{SKU}[ - suffix] / {WAREHOUSE}
const SHIPPED_SUBJECT = new RegExp(`${PREFIX}${ORDER}\\s*\\/\\s*(.+?)\\s*\\/\\s*([^/]+?)\\s*$`, "i");

const ASANA_LINK = /Sent from Asana:\s*(https:\/\/app\.asana\.com\/\S+)/i;
const ANY_ASANA_LINK = /(https:\/\/app\.asana\.com\/\S+\/task\/\d+\S*)/i;

export function orderKindOf(orderNo: string): "PO" | "SO" | "TO" {
  return orderNo.startsWith("SO") ? "SO" : orderNo.startsWith("TO") ? "TO" : "PO";
}

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

function parseIssued(subjectMatch: RegExpMatchArray, body: string): ParsedEmail {
  const { skuRaw, componentLabel } = splitSkuAndLabel(subjectMatch[1]);
  const orderNo = NO_VALUE.test(subjectMatch[2]) ? "" : subjectMatch[2].toUpperCase();
  const warehouseCode = NO_VALUE.test(subjectMatch[3].trim()) ? "" : normalizeWarehouseCode(subjectMatch[3]);
  const bodySku = labelled(body, "SKU");
  const designName = labelled(body, "Design Name");
  const orderType = labelled(body, "Order Type");
  const productionTaskUrl = asanaLink(body);
  const missing: string[] = [];
  if (!designName) missing.push("designName");
  if (!productionTaskUrl) missing.push("productionTaskUrl");
  if (bodySku && baseSku(bodySku) !== baseSku(skuRaw)) missing.push("skuMismatch");
  if (!orderNo) missing.push("orderNo");
  return {
    kind: "issued",
    orderNo,
    orderKind: orderKindOf(orderNo),
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
  const orderNo = NO_VALUE.test(subjectMatch[1]) ? "" : subjectMatch[1].toUpperCase();
  const { skuRaw, componentLabel } = splitSkuAndLabel(subjectMatch[2]);
  const warehouseCode = NO_VALUE.test(subjectMatch[3].trim()) ? "" : normalizeWarehouseCode(subjectMatch[3]);
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

  // Fields are read from the whole text, not line by line: some emails arrive with the
  // signature on the same line as "Warehouse: MAINF MI", or with no line breaks at all.
  const flat = body.replace(/\s+/g, " ");
  if (!designName) {
    const m = flat.match(/has shipped from the vendor\..*?documents\.?\s+(\S+)\s+(.*?)\s+Tracking\s*:/i);
    if (m) designName = (baseSku(m[1]) === baseSku(skuRaw) ? m[2] : `${m[1]} ${m[2]}`).trim() || null;
  }
  const trackingRaw = flat.match(/Tracking\s*:\s*(.*?)\s*(?=Delivery Date\s*:|Warehouse\s*:|$)/i)?.[1] ?? null;
  const deliveryField = flat.match(/Delivery Date\s*:\s*(.*?)\s*(?=Warehouse\s*:|Tracking\s*:|$)/i)?.[1] ?? null;
  const deliveryRaw = deliveryField ? leadingDate(deliveryField) : null;
  const bodyWarehouse = warehouseCodeFrom(flat.match(/Warehouse\s*:\s*(.*)$/i)?.[1] ?? null);
  const tracking = splitTracking(trackingRaw);
  const deliveryDate = isoDate(parseLooseDate(deliveryRaw, ref));
  const productionTaskUrl = asanaLink(body);

  const missing: string[] = [];
  if (!designName) missing.push("designName");
  if (tracking.length === 0) missing.push("tracking");
  if (deliveryRaw && !deliveryDate && !/no value/i.test(deliveryRaw)) missing.push("deliveryDate");
  if (!productionTaskUrl) missing.push("productionTaskUrl");
  if (!orderNo) missing.push("orderNo");

  return {
    kind: "shipped",
    orderNo,
    orderKind: orderKindOf(orderNo),
    sku: baseSku(skuRaw),
    skuRaw,
    componentLabel,
    warehouseCode: warehouseCode || bodyWarehouse || "", // subject "[no value]": use the body's Warehouse line
    designName,
    orderType: null,
    tracking,
    deliveryDate,
    deliveryDateRaw: deliveryRaw,
    bodyWarehouseCode: bodyWarehouse,
    productionTaskUrl,
    missing,
  };
}

/** "MAINF MI Thanks Jonathan…" → "MAINF MI"; "BSI UK" → "BSI UK"; "[no value]" → null. Codes are a word plus an optional 2-letter region. */
export function warehouseCodeFrom(raw: string | null): string | null {
  if (!raw || /^\s*\[?\s*no value/i.test(raw)) return null;
  const t = raw.trim().toUpperCase().split(/\s+/);
  if (!t[0] || !/^[A-Z0-9]+$/.test(t[0])) return null;
  return t[1] && /^[A-Z]{2}$/.test(t[1]) ? `${t[0]} ${t[1]}` : t[0];
}

/** The date at the start of a field value, ignoring anything after it (e.g. a signature). */
export function leadingDate(raw: string): string {
  const v = raw.trim();
  const m = v.match(
    /^(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+)?(\[?\s*no value\s*\]?|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?(?:,?\s+\d{4})?)/i,
  );
  return m ? m[0] : v;
}

/** PO/SO/TO number in an attachment name such as "Purchase Order PO094330.pdf". */
export function orderNoFromText(text: string | null | undefined): string | null {
  const m = text?.toUpperCase().match(/(?:^|[^A-Z0-9])(PO|SO|TO)[\s#:-]?(\d{5,})(?![0-9])/);
  return m ? `${m[1]}${m[2]}` : null;
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

export interface ForwardedHeader {
  subject: string | null;
  date: Date | null;
  from: string | null;
}

/**
 * Reads the original headers from a forwarded message body (Gmail "---------- Forwarded message ---------"
 * or Outlook "From: / Sent: / Subject:" blocks). Returns null if the body has no forwarded block.
 */
export function forwardedOriginal(body: string): ForwardedHeader | null {
  const text = body.replace(/\r\n?/g, "\n");
  const start = text.search(/^-{5,}\s*Forwarded message\s*-{5,}|^Begin forwarded message:|^From:.+\n(?:.*\n)?(?:Sent|Date):/im);
  if (start === -1) return null;
  const block = text.slice(start, start + 1500);
  const get = (label: string) => block.match(new RegExp(`^\\s*${label}:[ \\t]*(.+)$`, "im"))?.[1]?.trim() ?? null;
  const rawDate = get("Date") ?? get("Sent");
  return { subject: get("Subject"), date: rawDate ? parseHeaderDate(rawDate) : null, from: get("From") };
}

/** "Mon, Nov 10, 2026 at 3:04 PM" or "Monday, November 10, 2026 3:04 PM" → Date (server local time). */
export function parseHeaderDate(raw: string): Date | null {
  const cleaned = raw
    .replace(/\s+at\s+/i, " ")
    .replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t)) return new Date(t);
  return parseLooseDate(cleaned.replace(/\s+\d{1,2}:\d{2}.*$/, ""));
}
