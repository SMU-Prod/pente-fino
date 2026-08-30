import { z } from "zod";

export const CATEGORIES = ["telecom", "card", "energy", "water"] as const;
export type Category = (typeof CATEGORIES)[number];

export const InvoiceCanonical = z.object({
  issuer: z.object({
    name: z.string().min(2),
    cnpj: z.string().regex(/^\d{14}$/).optional(),
    category: z.enum(CATEGORIES),
  }),
  period: z.object({ start: z.string().date(), end: z.string().date() }),
  dueDate: z.string().date(),
  totalCents: z.number().int().nonnegative(),
  sections: z.array(z.object({
    name: z.string(),
    items: z.array(z.object({
      description: z.string().min(1),
      amountCents: z.number().int(),
      qty: z.number().optional(),
      unitPriceCents: z.number().int().optional(),
      periodRef: z.string().optional(),
      meta: z.record(z.union([z.string(), z.number()])).optional(),
    })).min(1),
  })).min(1),
  readings: z.object({
    previous: z.number(),
    current: z.number(),
    kwh: z.number().optional(),
    m3: z.number().optional(),
    estimated: z.boolean(),
    days: z.number().int().optional(),
  }).optional(),
  tariffs: z.object({
    teCentsKwh: z.number().optional(),
    tusdCentsKwh: z.number().optional(),
    flag: z.string().optional(),
    pis: z.number().optional(),
    cofins: z.number().optional(),
    icms: z.number().optional(),
  }).optional(),
  extraction: z.object({
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string()),
  }),
});

export type InvoiceCanonical = z.infer<typeof InvoiceCanonical>;
export type InvoiceItem = InvoiceCanonical["sections"][number]["items"][number];
