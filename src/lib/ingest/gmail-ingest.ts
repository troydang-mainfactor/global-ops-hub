// Phase 1 step 1: Gmail ingest + PO PDF parsing → PurchaseOrder, PoLine, Event, Issue.
// Idempotent by Gmail message ID. Dependencies are injected so tests run against a fake mailbox.

import { Prisma, type PurchaseOrder, type Store } from "@prisma/client";
import type { Db } from "../db";
import type { AiParser } from "../ai/types";
import type { GmailAttachmentRef, GmailClient, GmailMessage } from "../gmail/types";
import { gmailViewUrl } from "../gmail/client";
import { forwardedOriginal, htmlToText, orderKindOf, orderNoFromText, parseEmail, type ParsedEmail } from "../email/parse";
import { parseLooseDate } from "../email/dates";
import { baseSku, normalizeSku, normalizeWarehouseCode, storeForSku, variantSku } from "../sku";
import { laterStage } from "../stages";
import { raiseIssue } from "../issues";
import { getSettings, type Settings } from "../settings";
import { runInboundRules } from "../rules/inbound";
import { rematchFromCache } from "../shiphero/sync";

export const LABEL_PROCESSED = "ops-hub/processed";
export const LABEL_UNKNOWN = "ops-hub/unknown-format";
const MAX_ATTEMPTS = 3;

export interface IngestDeps {
  db: Db;
  gmail: GmailClient;
  ai: AiParser | null; // null = Claude not configured: regex only, PDFs wait
  now?: () => Date;
  budgetMs?: number; // stop starting new work after this long; the next run continues
}

export interface IngestStats {
  listed: number;
  alreadySeen: number;
  fetched: number;
  processed: number;
  reapplied: number;
  skippedUnknownStore: number;
  skippedStoreDisabled: number;
  unknownFormat: number;
  aiFallbacks: number;
  errors: number;
  pdfParsed: number;
  pdfFailed: number;
  pdfPending: number;
  errorSamples: string[];
  incomplete: boolean; // stopped at the time budget: run again to continue
}

/** What we keep per message in EmailMessage.parsed, so skipped messages can be re-applied without Gmail. */
interface StoredParse {
  email: ParsedEmail;
  attachments: GmailAttachmentRef[];
  ai?: { promptVersion: string; model: string; confidence: number } | null;
}

type Ctx = {
  deadline: number;
  deps: IngestDeps;
  settings: Settings;
  stores: Store[];
  stats: IngestStats;
  now: Date;
};

function emptyStats(): IngestStats {
  return {
    listed: 0, alreadySeen: 0, fetched: 0, processed: 0, reapplied: 0, skippedUnknownStore: 0, skippedStoreDisabled: 0,
    unknownFormat: 0, aiFallbacks: 0, errors: 0, pdfParsed: 0, pdfFailed: 0, pdfPending: 0, errorSamples: [], incomplete: false,
  };
}

function noteError(stats: IngestStats, msg: string) {
  stats.errors++;
  if (stats.errorSamples.length < 10) stats.errorSamples.push(msg.slice(0, 300));
}

export async function runGmailIngest(deps: IngestDeps, opts: { mode: "incremental" | "backfill" }): Promise<IngestStats> {
  const now = deps.now?.() ?? new Date();
  const ctx: Ctx = { deadline: Date.now() + (deps.budgetMs ?? Number.POSITIVE_INFINITY), deps, settings: await getSettings(deps.db), stores: await deps.db.store.findMany(), stats: emptyStats(), now };

  await reapplySkipped(ctx);

  const days = opts.mode === "backfill" ? ctx.settings.backfillDays : ctx.settings.incrementalDays;
  const filter = String(ctx.settings.gmailQuery ?? "").trim();
  // Never scan a whole mailbox: without a filter every email would be parsed (and sent to Claude).
  if (!filter) throw new Error("Gmail search filter is empty. Set it in Settings → Thresholds (e.g. label:ops-hub-inbound).");
  const ids = await deps.gmail.listMessageIds(`(${filter}) newer_than:${days}d`);
  ctx.stats.listed = ids.length;

  const seen = await deps.db.emailMessage.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, attempts: true } });
  const done = new Set(seen.filter((s) => s.status !== "error" || s.attempts >= MAX_ATTEMPTS).map((s) => s.id));
  const todo = ids.filter((id) => !done.has(id));
  ctx.stats.alreadySeen = ids.length - todo.length;

  const messages: GmailMessage[] = [];
  for (const batch of chunk(todo, 5)) {
    // Leave time to process what was fetched; the rest is picked up by the next run.
    if (Date.now() > ctx.deadline - 60_000) {
      ctx.stats.incomplete = true;
      break;
    }
    const got = await Promise.allSettled(batch.map((id) => deps.gmail.getMessage(id)));
    got.forEach((g, i) => (g.status === "fulfilled" ? messages.push(g.value) : noteError(ctx.stats, `fetch ${batch[i]}: ${String(g.reason)}`)));
  }
  ctx.stats.fetched = messages.length;
  messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime()); // oldest first so the timeline reads in order

  for (const m of messages) {
    if (Date.now() > ctx.deadline) {
      ctx.stats.incomplete = true;
      break;
    }
    try {
      await processMessage(ctx, m);
    } catch (e) {
      noteError(ctx.stats, `message ${m.id} "${m.subject}": ${errText(e)}`);
      await deps.db.emailMessage.upsert({
        where: { id: m.id },
        create: { id: m.id, threadId: m.threadId, subject: m.subject, from: m.from, receivedAt: m.internalDate, kind: "unknown", status: "error", error: errText(e), attempts: 1 },
        update: { status: "error", error: errText(e), attempts: { increment: 1 } },
      });
    }
  }

  await parsePendingPdfs(ctx);
  await rematchFromCache(deps.db, now);
  await runInboundRules(deps.db, now);
  return ctx.stats;
}

// ---------------------------------------------------------------- messages

async function processMessage(ctx: Ctx, m: GmailMessage) {
  const { db, ai } = ctx.deps;
  const body = m.textBody ?? (m.htmlBody ? htmlToText(m.htmlBody) : "");
  // Forwarded copies: use the original subject and send time, not the forward's.
  const fwd = /^\s*(fwd?|fw)\s*:/i.test(m.subject) ? forwardedOriginal(body) : null;
  const subject = fwd?.subject ?? m.subject;
  const receivedAt = fwd?.date ?? m.internalDate;
  const regex = parseEmail({ subject, body, receivedAt });

  let email: ParsedEmail | null = regex.ok ? regex.data : null;
  let parsedBy: string | null = regex.ok ? "regex" : null;
  let aiInfo: StoredParse["ai"] = null;
  let reason = regex.ok ? null : regex.reason;

  const needsAi = !email || email.missing.some((f) => f !== "skuMismatch" && f !== "orderNo");
  if (needsAi && ai) {
    ctx.stats.aiFallbacks++;
    const r = await ai.parseEmail({ subject, body });
    aiInfo = { promptVersion: r.promptVersion, model: r.model, confidence: r.confidence };
    if (email) {
      email = mergeAi(email, r, receivedAt);
      parsedBy = "regex+ai";
    } else if (r.kind !== "unknown" && r.order_no && r.sku && r.warehouse) {
      email = fromAi(r, receivedAt);
      parsedBy = "ai";
    } else {
      reason = `AI could not classify (${r.kind}, confidence ${r.confidence.toFixed(2)})`;
    }
  }

  // "[no value]" order number: take it from the PDF's file name, else from the PDF itself.
  if (email && !email.orderNo) {
    const found = await orderNoFromAttachments(ctx, m);
    if (found) {
      email = { ...email, orderNo: found.orderNo, orderKind: orderKindOf(found.orderNo), missing: email.missing.filter((f) => f !== "orderNo") };
      parsedBy = `${parsedBy}+${found.source}`;
    } else {
      reason = "No order number in the subject ([no value]) and none found in the PDF";
      email = null;
    }
  }

  const base = {
    id: m.id, threadId: m.threadId, subject, from: fwd?.from ?? m.from, receivedAt,
  };

  if (!email) {
    ctx.stats.unknownFormat++;
    await db.emailMessage.upsert({
      where: { id: m.id },
      create: { ...base, kind: "unknown", status: "unknown_format", error: reason, processedAt: ctx.now },
      update: { kind: "unknown", status: "unknown_format", error: reason, processedAt: ctx.now },
    });
    await raiseIssue(db, {
      ruleId: "ING-FORMAT", severity: "info",
      title: `Unknown email format: "${m.subject.slice(0, 80)}"`,
      detail: `Kept for review so the format can be added later. ${reason ?? ""}`.trim(),
      fingerprint: `ING-FORMAT:${m.id}`,
      evidence: { gmail: gmailViewUrl(ctx.deps.gmail.mailbox, m.threadId, m.id), subject: m.subject, from: m.from },
    }, ctx.now);
    await safeLabel(ctx, m.id, LABEL_UNKNOWN);
    return;
  }

  const stored: StoredParse = { email, attachments: m.attachments, ai: aiInfo };
  const match = storeForSku(email.sku, ctx.stores);
  const store = match?.store ?? null;
  const storeCode = match?.prefix ?? null;
  const skipReason = !store ? "unknown_store" : !store.enabled ? "store_disabled" : null;

  await db.emailMessage.upsert({
    where: { id: m.id },
    create: { ...base, kind: email.kind, status: skipReason ? "skipped" : "processing", skipReason, parsedBy, confidence: aiInfo?.confidence ?? null, parsed: stored as unknown as Prisma.InputJsonValue, baseSku: email.sku, storeCode },
    update: { kind: email.kind, status: skipReason ? "skipped" : "processing", skipReason, parsedBy, confidence: aiInfo?.confidence ?? null, parsed: stored as unknown as Prisma.InputJsonValue, baseSku: email.sku, storeCode, error: null },
  });

  if (skipReason) {
    if (skipReason === "unknown_store") ctx.stats.skippedUnknownStore++;
    else ctx.stats.skippedStoreDisabled++;
    return;
  }

  await applyParsed(ctx, store!, { id: m.id, threadId: m.threadId, receivedAt }, stored, parsedBy!);
  ctx.stats.processed++;
}

async function orderNoFromAttachments(ctx: Ctx, m: GmailMessage): Promise<{ orderNo: string; source: string } | null> {
  const pdfs = m.attachments.filter((a) => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename));
  for (const a of pdfs) {
    const no = orderNoFromText(a.filename);
    if (no) return { orderNo: no, source: "pdf-name" };
  }
  const ai = ctx.deps.ai;
  const pdf = pdfs.find((a) => /purchase\s*order/i.test(a.filename)) ?? pdfs[0];
  if (!ai || !pdf) return null;
  try {
    const buf = await ctx.deps.gmail.getAttachment(m.id, pdf.attachmentId);
    const r = await ai.parsePoPdf(buf, { orderNo: "(unknown: read it from the document)", sku: "" });
    const no = orderNoFromText(r.po_number ? ` ${r.po_number}` : null);
    return no ? { orderNo: no, source: "pdf" } : null;
  } catch (e) {
    noteError(ctx.stats, `order number from PDF ${m.id}: ${errText(e)}`);
    return null;
  }
}

/** Messages skipped because their store was off (or unknown) get applied once the store is enabled. */
async function reapplySkipped(ctx: Ctx) {
  const enabled = ctx.stores.filter((s) => s.enabled);
  if (!enabled.length) return;
  const skipped = await ctx.deps.db.emailMessage.findMany({ where: { status: "skipped" }, orderBy: { receivedAt: "asc" } });
  for (const msg of skipped) {
    const stored = msg.parsed as unknown as StoredParse | null;
    if (!stored?.email) continue;
    const match = storeForSku(stored.email.sku, ctx.stores);
    const store = match && match.store.enabled ? match.store : null;
    const code = match?.prefix ?? null;
    if (!store) continue;
    try {
      await ctx.deps.db.emailMessage.update({ where: { id: msg.id }, data: { storeCode: code } });
      await applyParsed(ctx, store, { id: msg.id, threadId: msg.threadId, receivedAt: msg.receivedAt }, stored, msg.parsedBy ?? "regex");
      ctx.stats.reapplied++;
    } catch (e) {
      noteError(ctx.stats, `reapply ${msg.id}: ${errText(e)}`);
    }
  }
}

async function applyParsed(
  ctx: Ctx,
  store: Store,
  msg: { id: string; threadId: string; receivedAt: Date },
  stored: StoredParse,
  parsedBy: string,
) {
  const { db, gmail } = ctx.deps;
  let e = stored.email;
  const at = msg.receivedAt;
  if (!e.warehouseCode) {
    // "[no value]" warehouse: use the store's usual warehouse code.
    const wh = store.warehouseName ? await db.warehouse.findFirst({ where: { name: { equals: store.warehouseName, mode: "insensitive" } } }) : null;
    if (!wh) throw new Error(`No warehouse in the email and none known for ${store.name}`);
    e = { ...e, warehouseCode: wh.emailCode };
  }
  const link = gmailViewUrl(gmail.mailbox, msg.threadId, msg.id);

  await checkWarehouse(ctx, store, e.warehouseCode, link);
  if (e.kind === "shipped" && e.bodyWarehouseCode && e.bodyWarehouseCode !== e.warehouseCode) {
    await raiseIssue(db, {
      ruleId: "ING-WH-MISMATCH", severity: "yellow",
      title: `${e.orderNo}: subject says ${e.warehouseCode}, body says ${e.bodyWarehouseCode}`,
      detail: "The shipped email names two different warehouses. The subject is used; check which is right.",
      fingerprint: `ING-WH-MISMATCH:${msg.id}`, productSku: e.sku,
      evidence: { gmail: link, subjectWarehouse: e.warehouseCode, bodyWarehouse: e.bodyWarehouseCode },
    }, ctx.now);
  }

  await db.product.upsert({
    where: { sku: e.sku },
    create: { sku: e.sku, storeId: store.id, name: e.designName },
    update: { storeId: store.id, ...(e.designName ? { name: e.designName } : {}) },
  });

  const deliveryDate = e.deliveryDate ? new Date(`${e.deliveryDate}T00:00:00Z`) : null;
  const pdf = pickPoPdf(stored.attachments, e);
  const pdfSource = pdf ? { messageId: msg.id, attachmentId: pdf.attachmentId, filename: pdf.filename } : undefined;
  const stage = e.kind === "issued" ? "issued" : "shipped";

  const existing = await db.purchaseOrder.findUnique({ where: { orderNo_warehouseCode: { orderNo: e.orderNo, warehouseCode: e.warehouseCode } } });
  let po: PurchaseOrder;
  if (!existing) {
    po = await db.purchaseOrder.create({
      data: {
        orderNo: e.orderNo, kind: e.orderKind, warehouseCode: e.warehouseCode, storeId: store.id, stage,
        issuedAt: e.kind === "issued" ? at : null,
        shippedAt: e.kind === "shipped" ? at : null,
        tracking: e.tracking, deliveryDate,
        etaAt: deliveryDate, etaSource: deliveryDate ? "email" : null,
        productionTaskUrl: e.productionTaskUrl,
        pdfSource: pdfSource ?? undefined,
      },
    });
  } else {
    const data: Prisma.PurchaseOrderUpdateInput = {
      stage: laterStage(existing.stage, stage),
      tracking: [...new Set([...existing.tracking, ...e.tracking])],
    };
    if (e.kind === "issued" && (!existing.issuedAt || at < existing.issuedAt)) data.issuedAt = at;
    if (e.kind === "shipped" && (!existing.shippedAt || at < existing.shippedAt)) data.shippedAt = at;
    if (deliveryDate) Object.assign(data, { deliveryDate, etaAt: deliveryDate, etaSource: "email" });
    if (!existing.productionTaskUrl && e.productionTaskUrl) data.productionTaskUrl = e.productionTaskUrl;
    if (!existing.storeId) data.store = { connect: { id: store.id } };
    if (!existing.pdfSource && pdfSource) data.pdfSource = pdfSource;
    po = await db.purchaseOrder.update({ where: { id: existing.id }, data });
  }

  // One line per base SKU until the PDF gives sizes and quantities.
  const hasVariantLines = await db.poLine.count({ where: { poId: po.id, productSku: e.sku, variantSku: { not: null } } });
  if (!hasVariantLines) {
    await db.poLine.upsert({
      where: { poId_lineKey: { poId: po.id, lineKey: e.sku } },
      create: { poId: po.id, lineKey: e.sku, productSku: e.sku },
      update: {},
    });
  }

  // One event per kind + order + warehouse + SKU, so a forwarded copy of the same email doesn't duplicate it.
  const dedupeKey = `email:${e.kind}:${e.orderNo}:${e.warehouseCode}:${e.sku}`;
  await db.event.upsert({
    where: { dedupeKey },
    create: {
      at, kind: e.kind === "issued" ? "email_issued" : "email_shipped", productSku: e.sku, poId: po.id, sourceUrl: link, dedupeKey,
      data: {
        orderNo: e.orderNo, warehouse: e.warehouseCode, designName: e.designName, orderType: e.orderType, tracking: e.tracking,
        deliveryDate: e.deliveryDate, componentLabel: e.componentLabel, productionTaskUrl: e.productionTaskUrl, parsedBy,
      },
    },
    update: {},
  });

  if (stored.ai && parsedBy !== "regex" && stored.ai.confidence < ctx.settings.aiLowConfidence) {
    await raiseIssue(db, {
      ruleId: "R17", severity: "info",
      title: `Email for ${e.orderNo} / ${e.sku} read by AI (confidence ${stored.ai.confidence.toFixed(2)})`,
      detail: "The email didn't fully match a known format, so Claude filled in fields. Check the values.",
      fingerprint: `R17:email:${msg.id}`, productSku: e.sku, poId: po.id,
      evidence: { gmail: link, parsed: e as unknown as Prisma.InputJsonValue, ai: stored.ai },
    }, ctx.now);
  }

  await db.emailMessage.update({ where: { id: msg.id }, data: { status: "processed", processedAt: ctx.now, error: null } });
  await safeLabel(ctx, msg.id, LABEL_PROCESSED);
}

/**
 * The ShipHero warehouse comes from the store's warehouse. Raise an issue when the store isn't set up yet,
 * and an FYI the first time a new warehouse code shows up in the emails.
 */
async function checkWarehouse(ctx: Ctx, store: Store, code: string, link: string) {
  const { db } = ctx.deps;
  let wh = await db.warehouse.findUnique({ where: { emailCode: code } });
  if (!wh) {
    wh = await db.warehouse.create({ data: { emailCode: code } });
    await raiseIssue(db, {
      ruleId: "ING-WAREHOUSE", severity: "info",
      title: `New warehouse code "${code}" in PO emails`,
      detail: "Name it in Settings → Warehouses, or untick \"In ShipHero\" if goods there aren't tracked in ShipHero.",
      fingerprint: `ING-WAREHOUSE:${code}`,
      evidence: { warehouseCode: code, store: store.name, gmail: link },
    }, ctx.now);
  }
  if (wh.name && store.warehouseName && wh.name.trim().toLowerCase() !== store.warehouseName.trim().toLowerCase()) {
    await raiseIssue(db, {
      ruleId: "ING-STORE-WH", severity: "info",
      title: `${store.name}: PO goes to ${code} (${wh.name}), store ships from ${store.warehouseName}`,
      detail: "The PO email names a different warehouse than the store's usual one. Fine if intended (e.g. UK stock); otherwise check the PO.",
      fingerprint: `ING-STORE-WH:${store.id}:${code}`,
      evidence: { store: store.name, warehouseCode: code, warehouseName: wh.name, storeWarehouse: store.warehouseName, gmail: link },
    }, ctx.now);
  }
  // The store's warehouse (e.g. "Mainfactor Michigan") decides where its POs are looked up in ShipHero;
  // the ShipHero warehouse ID is resolved from that name during the ShipHero sync.
  if (!store.warehouseName) {
    await raiseIssue(db, {
      ruleId: "ING-STORE-WAREHOUSE", severity: "yellow",
      title: `${store.name}: no warehouse set`,
      detail: "Set the store's warehouse in Settings → Stores so its POs can be matched in ShipHero.",
      fingerprint: `ING-STORE-WAREHOUSE:${store.id}`,
      evidence: { store: store.name, warehouseCode: code, gmail: link },
    }, ctx.now);
  }
}

// ---------------------------------------------------------------- PDFs

export function pickPoPdf(atts: GmailAttachmentRef[], e: Pick<ParsedEmail, "orderNo" | "kind">): GmailAttachmentRef | null {
  const pdfs = atts.filter((a) => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename));
  const named = (a: GmailAttachmentRef) => /purchase\s*order/i.test(a.filename);
  const hasNo = (a: GmailAttachmentRef) => a.filename.toUpperCase().includes(e.orderNo);
  return (
    pdfs.find((a) => named(a) && hasNo(a)) ??
    pdfs.find(hasNo) ??
    pdfs.find(named) ??
    (e.kind === "issued" && pdfs.length === 1 ? pdfs[0] : null)
  );
}

async function parsePendingPdfs(ctx: Ctx) {
  const { db, gmail, ai } = ctx.deps;
  const enabledIds = ctx.stores.filter((s) => s.enabled).map((s) => s.id);
  const where: Prisma.PurchaseOrderWhereInput = {
    storeId: { in: enabledIds },
    pdfJson: { equals: Prisma.AnyNull },
    NOT: { pdfSource: { equals: Prisma.AnyNull } },
    pdfAttempts: { lt: MAX_ATTEMPTS },
  };
  const pendingAll = await db.purchaseOrder.count({ where });
  if (!ai) {
    ctx.stats.pdfPending = pendingAll;
    return;
  }
  const pending = await db.purchaseOrder.findMany({ where, orderBy: { issuedAt: "desc" }, take: ctx.settings.pdfMaxPerRun, include: { lines: true } });
  for (const po of pending) {
    if (Date.now() > ctx.deadline) {
      ctx.stats.incomplete = true;
      break;
    }
    const src = po.pdfSource as { messageId: string; attachmentId: string; filename: string };
    try {
      const pdf = await gmail.getAttachment(src.messageId, src.attachmentId);
      const sku = po.lines[0]?.productSku ?? "";
      const r = await ai.parsePoPdf(pdf, { orderNo: po.orderNo, sku });
      await applyPdf(ctx, po, po.lines.map((l) => l.productSku), r, src);
      ctx.stats.pdfParsed++;
    } catch (e) {
      ctx.stats.pdfFailed++;
      noteError(ctx.stats, `PDF ${po.orderNo}: ${errText(e)}`);
      const updated = await db.purchaseOrder.update({ where: { id: po.id }, data: { pdfAttempts: { increment: 1 }, pdfError: errText(e) } });
      if (updated.pdfAttempts >= MAX_ATTEMPTS) {
        await raiseIssue(db, {
          ruleId: "ING-PDF", severity: "info",
          title: `Couldn't read the PO PDF for ${po.orderNo}`,
          detail: `Tried ${MAX_ATTEMPTS} times. Last error: ${errText(e)}`,
          fingerprint: `ING-PDF:${po.id}`, poId: po.id,
          evidence: { gmail: gmailViewUrl(gmail.mailbox, src.messageId, src.messageId), filename: src.filename },
        }, ctx.now);
      }
    }
  }
  ctx.stats.pdfPending = Math.max(0, pendingAll - ctx.stats.pdfParsed);
}

type PdfResult = Awaited<ReturnType<AiParser["parsePoPdf"]>>;

export async function applyPdf(
  ctx: Pick<Ctx, "deps" | "settings" | "stores" | "now">,
  po: PurchaseOrder,
  knownSkus: string[],
  r: PdfResult,
  src: { messageId: string; filename: string },
) {
  const { db, gmail } = ctx.deps;
  const singleSku = [...new Set(knownSkus)].length === 1 ? knownSkus[0] : null;
  const qty = new Map<string, { productSku: string; variantSku: string | null; qty: number }>();
  const unmatched: string[] = [];

  for (const l of r.lines) {
    if (!(l.qty > 0)) continue;
    const printed = l.sku ? normalizeSku(l.sku) : null;
    const base = printed ? baseSku(printed) : singleSku;
    if (!base) {
      unmatched.push(l.description ?? "(no SKU)");
      continue;
    }
    const variant = printed?.includes("_") ? printed : variantSku(base, l.size);
    const key = variant ?? base;
    const cur = qty.get(key) ?? { productSku: base, variantSku: variant, qty: 0 };
    cur.qty += Math.round(l.qty);
    qty.set(key, cur);
  }

  for (const [lineKey, l] of qty) {
    const storeId = storeForSku(l.productSku, ctx.stores)?.store.id ?? null;
    await db.product.upsert({ where: { sku: l.productSku }, create: { sku: l.productSku, storeId }, update: {} });
    if (l.variantSku) {
      await db.variant.upsert({ where: { sku: l.variantSku }, create: { sku: l.variantSku, productSku: l.productSku }, update: {} });
    }
    await db.poLine.upsert({
      where: { poId_lineKey: { poId: po.id, lineKey } },
      create: { poId: po.id, lineKey, productSku: l.productSku, variantSku: l.variantSku, qtyOrdered: l.qty },
      update: { qtyOrdered: l.qty, variantSku: l.variantSku },
    });
  }
  // Drop base-SKU placeholder lines now covered by sized lines.
  const sized = [...new Set([...qty.values()].filter((l) => l.variantSku).map((l) => l.productSku))];
  if (sized.length) await db.poLine.deleteMany({ where: { poId: po.id, variantSku: null, qtyOrdered: null, productSku: { in: sized } } });

  const pdfDate = parseLooseDate(r.delivery_date) ?? parseLooseDate(r.ship_date) ?? parseLooseDate(r.ex_factory_date);
  const data: Prisma.PurchaseOrderUpdateInput = {
    pdfJson: { ...r, parsedAt: ctx.now.toISOString(), filename: src.filename, unmatched } as unknown as Prisma.InputJsonValue,
    pdfError: null,
  };
  if (pdfDate && po.etaSource !== "email" && po.etaSource !== "carrier") Object.assign(data, { etaAt: pdfDate, etaSource: "pdf" });
  await db.purchaseOrder.update({ where: { id: po.id }, data });

  const link = gmailViewUrl(gmail.mailbox, src.messageId, src.messageId);
  const dedupeKey = `pdf:${po.id}:${r.promptVersion}`;
  await db.event.upsert({
    where: { dedupeKey },
    create: {
      at: ctx.now, kind: "pdf_parsed", poId: po.id, productSku: singleSku, sourceUrl: link, dedupeKey,
      data: { orderNo: po.orderNo, lines: qty.size, totalQty: [...qty.values()].reduce((a, b) => a + b.qty, 0), confidence: r.confidence, model: r.model, promptVersion: r.promptVersion },
    },
    update: {},
  });

  if (r.confidence < ctx.settings.aiLowConfidence || unmatched.length) {
    await raiseIssue(db, {
      ruleId: "R17", severity: "info",
      title: `PO PDF ${po.orderNo} read with low confidence (${r.confidence.toFixed(2)})`,
      detail: [r.notes, unmatched.length ? `Lines without a SKU: ${unmatched.join("; ")}` : null].filter(Boolean).join(" "),
      fingerprint: `R17:pdf:${po.id}`, poId: po.id, byAi: true,
      evidence: { gmail: link, filename: src.filename, confidence: r.confidence },
    }, ctx.now);
  }
}

// ---------------------------------------------------------------- helpers

function mergeAi(e: ParsedEmail, r: Awaited<ReturnType<AiParser["parseEmail"]>>, ref: Date): ParsedEmail {
  const out = { ...e, missing: [...e.missing] };
  if (!out.designName && r.design_name) out.designName = r.design_name;
  if (!out.productionTaskUrl && r.production_task_url?.startsWith("https://app.asana.com/")) out.productionTaskUrl = r.production_task_url;
  if (out.kind === "shipped") {
    if (!out.tracking.length && r.tracking.length) out.tracking = [...new Set(r.tracking.map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (!out.deliveryDate && r.delivery_date) {
      const d = parseLooseDate(r.delivery_date, ref);
      out.deliveryDate = d ? d.toISOString().slice(0, 10) : null;
    }
  }
  return out;
}

function fromAi(r: Awaited<ReturnType<AiParser["parseEmail"]>>, ref: Date): ParsedEmail {
  const orderNo = r.order_no!.trim().toUpperCase();
  const skuRaw = normalizeSku(r.sku!);
  const d = parseLooseDate(r.delivery_date, ref);
  return {
    kind: r.kind as "issued" | "shipped",
    orderNo,
    orderKind: orderKindOf(orderNo),
    sku: baseSku(skuRaw),
    skuRaw,
    componentLabel: null,
    warehouseCode: normalizeWarehouseCode(r.warehouse!),
    designName: r.design_name,
    orderType: null,
    tracking: r.tracking.map((t) => t.trim().toUpperCase()).filter(Boolean),
    deliveryDate: d ? d.toISOString().slice(0, 10) : null,
    deliveryDateRaw: r.delivery_date,
    bodyWarehouseCode: null,
    productionTaskUrl: r.production_task_url,
    missing: [],
  };
}

async function safeLabel(ctx: Ctx, id: string, label: string) {
  try {
    await ctx.deps.gmail.addLabel(id, label);
  } catch (e) {
    // Labels are a convenience in Gmail; the DB is the source of truth for idempotency.
    if (ctx.stats.errorSamples.length < 10) ctx.stats.errorSamples.push(`label ${id}: ${errText(e)}`);
  }
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
