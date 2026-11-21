import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic, aiModel } from "./client";
import { EmailFallbackSchema, PoPdfSchema, type AiParser } from "./types";
import { PO_PDF_PROMPT_VERSION, PO_PDF_SYSTEM } from "@/prompts/po-pdf";
import { EMAIL_FALLBACK_PROMPT_VERSION, EMAIL_FALLBACK_SYSTEM } from "@/prompts/email-fallback";

function assertUsable(msg: Anthropic.Message, what: string) {
  if (msg.stop_reason === "refusal") throw new Error(`${what}: model declined (${msg.stop_details?.category ?? "refusal"})`);
  if (msg.stop_reason === "max_tokens") throw new Error(`${what}: output truncated (max_tokens)`);
}

/** Claude-backed parser. Only proposes data; never writes to ShipHero or Asana. */
export const claudeParser: AiParser = {
  async parsePoPdf(pdf, ctx) {
    const model = aiModel();
    const res = await anthropic().messages.parse({
      model,
      max_tokens: 16000,
      output_config: { effort: "low", format: zodOutputFormat(PoPdfSchema) },
      system: PO_PDF_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
            { type: "text", text: `Purchase order ${ctx.orderNo}. The email was about SKU ${ctx.sku}; the PO may list other SKUs too. Extract every line.` },
          ],
        },
      ],
    });
    assertUsable(res, "PO PDF");
    if (!res.parsed_output) throw new Error("PO PDF: response did not match the schema");
    return { ...res.parsed_output, promptVersion: PO_PDF_PROMPT_VERSION, model: res.model };
  },

  async parseEmail({ subject, body }) {
    const model = aiModel();
    const res = await anthropic().messages.parse({
      model,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(EmailFallbackSchema) },
      system: EMAIL_FALLBACK_SYSTEM,
      messages: [{ role: "user", content: `Subject: ${subject}\n\n${body.slice(0, 20000)}` }],
    });
    assertUsable(res, "Email fallback");
    if (!res.parsed_output) throw new Error("Email fallback: response did not match the schema");
    return { ...res.parsed_output, promptVersion: EMAIL_FALLBACK_PROMPT_VERSION, model: res.model };
  },
};
