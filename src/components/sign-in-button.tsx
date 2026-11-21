"use client";
import { signIn } from "next-auth/react";

export function SignInButton() {
  return (
    <button onClick={() => signIn("google", { callbackUrl: "/" })} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-bg">
      Sign in with Google
    </button>
  );
}
