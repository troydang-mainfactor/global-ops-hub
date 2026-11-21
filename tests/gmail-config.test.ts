import { afterEach, describe, expect, it } from "vitest";
import { gmailConfigured } from "@/lib/gmail/client";

const KEYS = ["GMAIL_MAILBOX", "GMAIL_SA_KEY_JSON", "GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

describe("gmailConfigured", () => {
  it("reuses the Google sign-in client when no Gmail-specific client is set", () => {
    KEYS.forEach((k) => delete process.env[k]);
    Object.assign(process.env, { GMAIL_MAILBOX: "me@x.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" });
    expect(gmailConfigured()).toBe(false);
    process.env.GMAIL_OAUTH_REFRESH_TOKEN = "rt";
    expect(gmailConfigured()).toBe(true);
  });
});
