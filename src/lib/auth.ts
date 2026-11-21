import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { getServerSession } from "next-auth";
import { db } from "./db";

const DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "mainfactor.com").toLowerCase();

export function emailAllowed(email: string | null | undefined): boolean {
  return Boolean(email && email.toLowerCase().endsWith(`@${DOMAIN}`));
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      authorization: { params: { hd: DOMAIN, prompt: "select_account" } },
    }),
  ],
  callbacks: {
    async signIn({ profile, user }) {
      const p = profile as { email?: string; email_verified?: boolean; hd?: string } | undefined;
      const email = p?.email ?? user.email;
      if (!emailAllowed(email) || p?.email_verified === false) return false;
      await db.user.upsert({
        where: { email: email!.toLowerCase() },
        create: { email: email!.toLowerCase(), name: user.name ?? email! },
        update: user.name ? { name: user.name } : {},
      });
      return true;
    },
  },
  pages: { signIn: "/signin", error: "/signin" },
};

export function devBypass(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.AUTH_DEV_BYPASS === "1";
}

/** Signed-in user's email, or null. */
export async function currentUserEmail(): Promise<string | null> {
  if (devBypass()) return "dev@localhost";
  const s = await getServerSession(authOptions);
  return emailAllowed(s?.user?.email) ? s!.user!.email! : null;
}

export async function requireUser(): Promise<string> {
  const email = await currentUserEmail();
  if (!email) throw new Error("Not signed in");
  return email;
}
