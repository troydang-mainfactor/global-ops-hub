export interface GmailAttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: Date;
  subject: string;
  from: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: GmailAttachmentRef[];
}

/** The Gmail operations ingest needs. Injected so tests can use a fake mailbox. */
export interface GmailClient {
  mailbox: string;
  listMessageIds(query: string): Promise<string[]>;
  getMessage(id: string): Promise<GmailMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  /** Adds a label (created if missing). Best-effort: failures must not fail ingest. */
  addLabel(messageId: string, labelName: string): Promise<void>;
}
