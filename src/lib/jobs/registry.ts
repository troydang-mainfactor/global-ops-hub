import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { claudeParser } from "../ai/parser";
import { aiConfigured } from "../ai/client";
import { createGmailClient, gmailConfigured } from "../gmail/client";
import { runGmailIngest } from "../ingest/gmail-ingest";
import { createShipheroClient } from "../shiphero/client";
import { runShipheroSync } from "../shiphero/sync";
import { tokenSet } from "../shiphero/accounts";

export interface JobDef {
  name: string;
  title: string;
  description: string;
  schedule: string; // human-readable; the actual cron lives in vercel.json / your scheduler
  ready: () => string | null; // null = ready, else what's missing
  run: () => Promise<Prisma.InputJsonValue>;
}

export const JOBS: JobDef[] = [
  {
    name: "gmail-ingest",
    title: "Gmail ingest",
    description: "Reads new PO emails (last few days), updates POs, and parses PO PDFs with Claude.",
    schedule: "Every 5 minutes",
    ready: () => (gmailConfigured() ? null : "Gmail credentials not set"),
    run: async () => runGmailIngest({ db, gmail: createGmailClient(), ai: aiConfigured() ? claudeParser : null, budgetMs: BUDGET_MS }, { mode: "incremental" }) as never,
  },
  {
    name: "gmail-backfill",
    title: "Gmail backfill",
    description: "Same as Gmail ingest, over the backfill window (default 120 days). Safe to re-run.",
    schedule: "Manual",
    ready: () => (gmailConfigured() ? null : "Gmail credentials not set"),
    run: async () => runGmailIngest({ db, gmail: createGmailClient(), ai: aiConfigured() ? claudeParser : null, budgetMs: BUDGET_MS }, { mode: "backfill" }) as never,
  },
  {
    name: "shiphero-sync",
    title: "ShipHero sync",
    description: "Matches POs in ShipHero, updates received quantities and stages, inventory, backorders and pre-order tags. Accounts without a token are skipped.",
    schedule: "Every 5 minutes",
    ready: () => null, // checked per account inside the job
    run: async () => {
      const accounts = await runShipheroSync({
        db,
        budgetMs: BUDGET_MS,
        clientFor: (a) => (tokenSet(a) ? createShipheroClient({ token: process.env[a.tokenRef]! }) : null),
      });
      const incomplete = accounts.some((a) => !a.skipped && !a.error && (!a.poPassComplete || !a.inventoryPassComplete));
      return { incomplete, accounts } as never;
    },
  },
];

export function getJob(name: string) {
  return JOBS.find((j) => j.name === name) ?? null;
}

// Jobs stop themselves at ~4 minutes (BUDGET_MS) and the platform kills them at 5 (maxDuration).
// A run still "running" after 6 minutes was killed: mark it failed so new runs aren't blocked.
export const BUDGET_MS = 240_000;
const STALE_MS = 6 * 60 * 1000;

async function closeStaleRuns(name: string) {
  await db.syncRun.updateMany({
    where: { job: name, finishedAt: null, startedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { finishedAt: new Date(), ok: false, error: "Stopped by the server before finishing (time limit). Run it again to continue." },
  });
}

export type StartResult =
  | { started: false; reason: string; runId?: string }
  | { started: true; runId: string };

/** Records a new run (or explains why not). Call executeRun(runId) to do the work, e.g. inside after(). */
export async function startJob(name: string, trigger: "cron" | "manual"): Promise<StartResult> {
  const job = getJob(name);
  if (!job) return { started: false, reason: `Unknown job ${name}` };
  await closeStaleRuns(name);
  const running = await db.syncRun.findFirst({ where: { job: name, finishedAt: null } });
  if (running) return { started: false, reason: "already running", runId: running.id };
  const missing = job.ready();
  const run = await db.syncRun.create({ data: { job: name, startedAt: new Date(), trigger } });
  if (missing) {
    await db.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: false, error: missing } });
    return { started: false, reason: missing, runId: run.id };
  }
  return { started: true, runId: run.id };
}

export async function executeRun(name: string, runId: string) {
  const job = getJob(name)!;
  try {
    const stats = await job.run();
    await db.syncRun.update({ where: { id: runId }, data: { finishedAt: new Date(), ok: true, stats } });
    return { ok: true as const, stats };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.syncRun.update({ where: { id: runId }, data: { finishedAt: new Date(), ok: false, error } });
    return { ok: false as const, error };
  }
}

/** Start and wait (cron). */
export async function runJob(name: string, trigger: "cron" | "manual") {
  const s = await startJob(name, trigger);
  if (!s.started) return { skipped: true as const, reason: s.reason, runId: s.runId };
  return { skipped: false as const, runId: s.runId, ...(await executeRun(name, s.runId)) };
}
