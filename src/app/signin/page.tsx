import { SignInButton } from "@/components/sign-in-button";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto mt-24 max-w-sm px-4 text-center">
      <h1 className="text-xl font-semibold">Global Ops Hub</h1>
      <p className="mt-2 text-sm text-muted">Sign in with your @{process.env.ALLOWED_EMAIL_DOMAIN || "mainfactor.com"} Google account.</p>
      {error && <p className="mt-4 rounded bg-red-50 p-2 text-sm text-red-700">That account isn&apos;t allowed. Use your company Google account.</p>}
      <div className="mt-6">
        <SignInButton />
      </div>
    </main>
  );
}
