// Cron entry point: GET or POST /api/jobs/<name> with "Authorization: Bearer $CRON_SECRET".
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getJob, runJob } from "@/lib/jobs/registry";
import { currentUserEmail } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  return Boolean(secret) && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function handle(req: Request, { params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  const isCron = cronAuthorized(req);
  if (!isCron && !(await currentUserEmail())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!getJob(job)) return NextResponse.json({ error: "unknown job" }, { status: 404 });
  const result = await runJob(job, isCron ? "cron" : "manual");
  return NextResponse.json(result, { status: !result.skipped && result.ok === false ? 500 : 200 });
}

export { handle as GET, handle as POST };
