import { redirect } from "next/navigation";
import { currentUserEmail } from "@/lib/auth";
import { Nav } from "@/components/nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const email = await currentUserEmail();
  if (!email) redirect("/signin");
  return (
    <>
      <Nav email={email} />
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-4">{children}</main>
    </>
  );
}
