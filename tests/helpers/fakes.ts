import type { AiParser, EmailFallback, PoPdf } from "@/lib/ai/types";
import type { GmailClient, GmailMessage } from "@/lib/gmail/types";

export function fakeGmail(messages: GmailMessage[], attachments: Record<string, Buffer> = {}) {
  const labels: Record<string, string[]> = {};
  const client: GmailClient & { labels: typeof labels; fetches: number; messages: GmailMessage[]; queries: string[] } = {
    mailbox: "inbound@example.com",
    labels,
    fetches: 0,
    messages,
    queries: [],
    async listMessageIds(q) {
      client.queries.push(q);
      return [...client.messages].reverse().map((m) => m.id); // Gmail lists newest first
    },
    async getMessage(id) {
      client.fetches++;
      const m = client.messages.find((x) => x.id === id);
      if (!m) throw new Error(`no message ${id}`);
      return m;
    },
    async getAttachment(_mid, aid) {
      const b = attachments[aid];
      if (!b) throw new Error(`no attachment ${aid}`);
      return b;
    },
    async addLabel(id, name) {
      (labels[id] ??= []).push(name);
    },
  };
  return client;
}

export function msg(
  id: string,
  e: { subject: string; body: string; receivedAt: Date },
  attachments: GmailMessage["attachments"] = [],
): GmailMessage {
  return { id, threadId: `t-${id}`, internalDate: e.receivedAt, subject: e.subject, from: "vendor@example.com", textBody: e.body, htmlBody: null, attachments };
}

export function fakeAi(opts: { pdf?: (orderNo: string) => PoPdf; email?: (subject: string) => EmailFallback } = {}) {
  const calls = { pdf: 0, email: 0 };
  const ai: AiParser & { calls: typeof calls } = {
    calls,
    async parsePoPdf(_buf, ctx) {
      calls.pdf++;
      if (!opts.pdf) throw new Error("no pdf fake");
      return { ...opts.pdf(ctx.orderNo), promptVersion: "test.v1", model: "fake" };
    },
    async parseEmail({ subject }) {
      calls.email++;
      const r = opts.email?.(subject) ?? {
        kind: "unknown" as const, order_no: null, sku: null, warehouse: null, design_name: null, tracking: [], delivery_date: null, production_task_url: null, confidence: 0.2,
      };
      return { ...r, promptVersion: "test.v1", model: "fake" };
    },
  };
  return ai;
}
