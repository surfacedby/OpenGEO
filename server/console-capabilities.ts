import { z } from "zod";
import { ProviderError } from "./contracts.js";

const publicCapabilities = z.object({
  contract_version: z.string().max(40).optional(),
  platforms: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), name: z.string().min(1).max(80), enabled: z.boolean() })).max(40),
  operations: z.array(z.string().max(80)).max(40).default([]),
  content_available: z.boolean().default(false),
  models: z.array(z.object({ id: z.string().min(1).max(150), operations: z.array(z.string().max(80)).max(40) })).max(200).default([]),
});
const operations = new Set(["full_check", "observations", "diagnoses", "opportunities", "brand_configuration", "competitor_configuration", "content", "research", "questions"]);
/** Only fields used by connection setup cross the backend boundary, even if a provider adds private diagnostics. */
export function consoleCapabilities(value: unknown) {
  const result = publicCapabilities.safeParse(value);
  if (!result.success) throw new ProviderError("capability", "SurfacedBy availability could not be verified. Try the connection again.");
  return { ...result.data, operations: result.data.operations.filter(operation => operations.has(operation)),
    models: result.data.models.map(model => ({ id: model.id, operations: model.operations.filter(operation => operations.has(operation)) })) };
}
