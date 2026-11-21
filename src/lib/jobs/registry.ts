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
    run: async () => runGmailIngest({ db, gmail: createGmailClient(), ai: aiConfigured() ? claudeParser : null }, { mode: "incremental" }) as never,
  },
  {
    name: "gmail-backfill",
    title: "Gmail backfill",
    description: "Same as Gmail ingest, over the backfill window (default 120 days). Safe to re-run.",
    schedule: "Manual",
    ready: () => (gmailConfigured() ? null : "Gmail credentials not set"),
    run: async () => runGmailIngest({ db, gmail: createGmailClient(), ai: aiConfigured() ? claudeParser : null }, { mode: "backfill" }) as never,
  },
  {
    name: "shiphero-sync",
    title: "ShipHero sync",
    description: "Matches POs in ShipHero, updates received quantities and stages, inventory, backorders and pre-order tags. Accounts without a token are skipped.",
    schedule: "Every 5 minutes",
    ready: () => null, // checked per account inside the job
    run: async () =>
      runShipheroSync({
        db,
        clientFor: (a) => (tokenSet(a) ? createShipheroClient({ refreshToken: process.env[a.tokenRef]! }) : null),
      }) as never,
  },
];

export function getJob(name: string) {
  return JOBS.find((j) => j.name === name) ?? null;
}

const STALE_MS = 15 * 60 * 1000;

/** Runs a job and logs it to SyncRun. Skips if the same job is already running. */
export async function runJob(name: string, trigger: "cron" | "manual") {
  const job = getJob(name);
  if (!job) throw new Error(`Unknown job ${name}`);
  const running = await db.syncRun.findFirst({
    where: { job: name, finishedAt: null, startedAt: { gt: new Date(Date.now() - STALE_MS) } },
  });
  if (running) return { skipped: true as const, reason: "already running", runId: running.id };

  const missing = job.ready();
  const run = await db.syncRun.create({ data: { job: name, startedAt: new Date(), trigger } });
  if (missing) {
    await db.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: false, error: missing } });
    return { skipped: false as const, ok: false, error: missing, runId: run.id };
  }
  try {
    const stats = await job.run();
    await db.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: true, stats } });
    return { skipped: false as const, ok: true, stats, runId: run.id };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: false, error } });
    return { skipped: false as const, ok: false, error, runId: run.id };
  }
}
