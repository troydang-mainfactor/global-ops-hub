import { redirect } from "next/navigation";
import { currentUserEmail } from "@/lib/auth";
import { Nav } from "@/components/nav";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const email = await currentUserEmail();
  if (!email) redirect("/signin");
  const running = await db.syncRun.findMany({
    where: { finishedAt: null, startedAt: { gt: new Date(Date.now() - 6 * 60 * 1000) } },
    select: { job: true },
  });
  return (
    <>
      <Nav email={email} running={[...new Set(running.map((r) => r.job))]} />
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">{children}</main>
    </>
  );
}
