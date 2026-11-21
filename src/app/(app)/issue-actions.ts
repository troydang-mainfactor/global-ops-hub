"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export async function updateIssue(f: FormData) {
  const who = await requireUser();
  const id = String(f.get("id"));
  const action = String(f.get("action"));
  const reason = String(f.get("reason") ?? "").trim();
  if (action === "resolve") await db.issue.update({ where: { id }, data: { status: "resolved", resolution: reason || `Resolved by ${who}` } });
  else if (action === "snooze") await db.issue.update({ where: { id }, data: { status: "snoozed", snoozedUntil: new Date(Date.now() + 7 * 86400000) } });
  else if (action === "dismiss") {
    if (!reason) throw new Error("A reason is required to dismiss");
    await db.issue.update({ where: { id }, data: { status: "dismissed", resolution: `${reason} (${who})` } });
  }
  revalidatePath("/");
}
