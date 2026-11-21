// Gmail REST client for the inbound PO mailbox.
// Auth: Workspace service account with domain-wide delegation (GMAIL_SA_KEY_JSON),
// or OAuth for one mailbox (GMAIL_OAUTH_*). Read-only by default; GMAIL_APPLY_LABELS=1 switches to
// gmail.modify so processed messages get an "ops-hub/…" label (optional; the DB tracks what's processed).

import { JWT, OAuth2Client } from "google-auth-library";
import type { GmailAttachmentRef, GmailClient, GmailMessage } from "./types";

export function gmailLabelsEnabled(): boolean {
  return process.env.GMAIL_APPLY_LABELS === "1";
}
const scopes = () => [`https://www.googleapis.com/auth/gmail.${gmailLabelsEnabled() ? "modify" : "readonly"}`];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

type Auth = JWT | OAuth2Client;

// Gmail OAuth can reuse the Google sign-in client (GOOGLE_CLIENT_ID/SECRET) if no separate one is set.
const oauthClientId = () => process.env.GMAIL_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const oauthClientSecret = () => process.env.GMAIL_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

export function gmailConfigured(): boolean {
  return Boolean(
    process.env.GMAIL_MAILBOX &&
      (process.env.GMAIL_SA_KEY_JSON ||
        (oauthClientId() && oauthClientSecret() && process.env.GMAIL_OAUTH_REFRESH_TOKEN)),
  );
}

function makeAuth(mailbox: string): Auth {
  const raw = process.env.GMAIL_SA_KEY_JSON;
  if (raw) {
    const json = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const key = JSON.parse(json) as { client_email: string; private_key: string };
    return new JWT({ email: key.client_email, key: key.private_key, scopes: scopes(), subject: mailbox });
  }
  const c = new OAuth2Client(oauthClientId(), oauthClientSecret());
  c.setCredentials({ refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  return c;
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
}

function b64url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function walk(part: Part, out: { text: string[]; html: string[]; attachments: GmailAttachmentRef[] }) {
  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({ attachmentId: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType ?? "", size: part.body.size ?? 0 });
  } else if (part.mimeType === "text/plain" && part.body?.data) {
    out.text.push(b64url(part.body.data).toString("utf8"));
  } else if (part.mimeType === "text/html" && part.body?.data) {
    out.html.push(b64url(part.body.data).toString("utf8"));
  }
  for (const p of part.parts ?? []) walk(p, out);
}

export function createGmailClient(mailbox = process.env.GMAIL_MAILBOX ?? ""): GmailClient {
  if (!gmailConfigured()) throw new Error("Gmail is not configured: set GMAIL_MAILBOX and GMAIL_SA_KEY_JSON (or GMAIL_OAUTH_*)");
  const auth = makeAuth(mailbox);
  const labelIds = new Map<string, string>();

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await auth.request<T>({ url: `${API}${path}`, method: (init.method ?? "GET") as "GET", data: init.body, retry: true });
    return res.data;
  }

  async function labelId(name: string): Promise<string> {
    const cached = labelIds.get(name);
    if (cached) return cached;
    const { labels = [] } = await call<{ labels?: { id: string; name: string }[] }>("/labels");
    let found = labels.find((l) => l.name === name);
    if (!found) found = await call<{ id: string; name: string }>("/labels", { method: "POST", body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
    labelIds.set(name, found.id);
    return found.id;
  }

  return {
    mailbox,
    async listMessageIds(query) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const qs = new URLSearchParams({ q: query, maxResults: "500", includeSpamTrash: "false" });
        if (pageToken) qs.set("pageToken", pageToken);
        const page = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${qs}`);
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return ids;
    },
    async getMessage(id): Promise<GmailMessage> {
      const m = await call<{ id: string; threadId: string; internalDate: string; payload: Part }>(`/messages/${id}?format=full`);
      const headers = m.payload.headers ?? [];
      const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n)?.value ?? null;
      const out = { text: [] as string[], html: [] as string[], attachments: [] as GmailAttachmentRef[] };
      walk(m.payload, out);
      return {
        id: m.id,
        threadId: m.threadId,
        internalDate: new Date(Number(m.internalDate)),
        subject: h("subject") ?? "",
        from: h("from"),
        textBody: out.text.length ? out.text.join("\n") : null,
        htmlBody: out.html.length ? out.html.join("\n") : null,
        attachments: out.attachments,
      };
    },
    async getAttachment(messageId, attachmentId) {
      const a = await call<{ data: string }>(`/messages/${messageId}/attachments/${attachmentId}`);
      return b64url(a.data);
    },
    async addLabel(messageId, name) {
      if (!gmailLabelsEnabled()) return;
      const id = await labelId(name);
      await call(`/messages/${messageId}/modify`, { method: "POST", body: { addLabelIds: [id] } });
    },
  };
}

/** Link to open a message in Gmail. Override with GMAIL_VIEW_URL_TEMPLATE ({mailbox}, {threadId}, {messageId}). */
export function gmailViewUrl(mailbox: string, threadId: string, messageId: string): string {
  const t = process.env.GMAIL_VIEW_URL_TEMPLATE || "https://mail.google.com/mail/u/?authuser={mailbox}#all/{threadId}";
  return t.replace("{mailbox}", encodeURIComponent(mailbox)).replace("{threadId}", threadId).replace("{messageId}", messageId);
}
