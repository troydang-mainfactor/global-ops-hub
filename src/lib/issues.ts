import type { Prisma } from "@prisma/client";
import type { Db } from "./db";

export type Severity = "red" | "yellow" | "info";

export interface IssueInput {
  ruleId: string;
  severity: Severity;
  title: string;
  detail: string;
  fingerprint: string; // rule + entities, so re-runs update instead of duplicating
  productSku?: string | null;
  poId?: string | null;
  campaignGid?: string | null;
  evidence: Prisma.InputJsonValue;
  byAi?: boolean;
}

/**
 * Creates or refreshes an Issue. A recurring resolved issue reopens;
 * dismissed stays dismissed; snoozed stays snoozed until snoozedUntil passes.
 */
export async function raiseIssue(db: Db, i: IssueInput, now = new Date()) {
  const existing = await db.issue.findUnique({ where: { fingerprint: i.fingerprint } });
  if (!existing) {
    return db.issue.create({
      data: {
        ruleId: i.ruleId, severity: i.severity, title: i.title, detail: i.detail, fingerprint: i.fingerprint,
        productSku: i.productSku ?? null, poId: i.poId ?? null, campaignGid: i.campaignGid ?? null,
        evidence: i.evidence, byAi: i.byAi ?? false, firstSeen: now, lastSeen: now,
      },
    });
  }
  let status = existing.status;
  if (status === "resolved") status = "open";
  if (status === "snoozed" && existing.snoozedUntil && existing.snoozedUntil <= now) status = "open";
  return db.issue.update({
    where: { id: existing.id },
    data: { severity: i.severity, title: i.title, detail: i.detail, evidence: i.evidence, lastSeen: now, status },
  });
}
