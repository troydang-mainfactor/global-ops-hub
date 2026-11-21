import { z } from "zod";

export const PoPdfSchema = z.object({
  po_number: z.string().nullable(),
  vendor: z.string().nullable(),
  order_date: z.string().nullable(),
  ex_factory_date: z.string().nullable(),
  ship_date: z.string().nullable(),
  delivery_date: z.string().nullable(),
  lines: z.array(
    z.object({
      sku: z.string().nullable(),
      size: z.string().nullable(),
      description: z.string().nullable(),
      qty: z.number(),
      unit_cost: z.number().nullable(),
    }),
  ),
  confidence: z.number(),
  notes: z.string().nullable(),
});
export type PoPdf = z.infer<typeof PoPdfSchema>;

export const EmailFallbackSchema = z.object({
  kind: z.enum(["issued", "shipped", "unknown"]),
  order_no: z.string().nullable(),
  sku: z.string().nullable(),
  warehouse: z.string().nullable(),
  design_name: z.string().nullable(),
  tracking: z.array(z.string()),
  delivery_date: z.string().nullable(),
  production_task_url: z.string().nullable(),
  confidence: z.number(),
});
export type EmailFallback = z.infer<typeof EmailFallbackSchema>;

/** The AI calls the ingest service needs. Injected so tests can run without the API. */
export interface AiParser {
  parsePoPdf(pdf: Buffer, ctx: { orderNo: string; sku: string }): Promise<PoPdf & { promptVersion: string; model: string }>;
  parseEmail(input: { subject: string; body: string }): Promise<EmailFallback & { promptVersion: string; model: string }>;
}
