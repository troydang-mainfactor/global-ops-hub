// Loads the sample PO emails from tests/fixtures into the local DB through the real ingest
// code (fake mailbox, no Claude). For local UI checks only: `npm run demo`.
import { PrismaClient } from "@prisma/client";
import { runGmailIngest } from "../src/lib/ingest/gmail-ingest";
import { fakeGmail, msg } from "../tests/helpers/fakes";
import * as f from "../tests/fixtures/emails";

const db = new PrismaClient();
const gmail = fakeGmail([
  msg("demo-1", f.issuedStok, [{ attachmentId: "a1", filename: "Purchase Order PO094330.pdf", mimeType: "application/pdf", size: 1 }]),
  msg("demo-2", f.issuedEvan),
  msg("demo-3", f.issuedSoUk),
  msg("demo-4", f.shippedFalr),
  msg("demo-5", f.shippedMegaComponentNoDate),
  msg("demo-6", f.shippedWarehouseMismatch),
  msg("demo-7", f.unknownFormat),
]);

runGmailIngest({ db, gmail, ai: null }, { mode: "backfill" })
  .then((s) => console.log(JSON.stringify(s, null, 2)))
  .finally(() => db.$disconnect());
