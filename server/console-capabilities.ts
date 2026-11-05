import { z } from "zod";
import { ProviderError } from "./contracts.js";
import { platformKey } from './platforms.js';

const publicCapabilities = z.object({
  contract_version: z.string().max(40).optional(),
  platforms: z.array(z.object({ key: platformKey, name: z.string().min(1).max(80), enabled: z.boolean() })).max(40)
    .refine(rows => new Set(rows.map(row => row.key)).size === rows.length),
  operations: z.array(z.string().max(80)).max(40).default([]),
  content_available: z.boolean().default(false),
  selected_question_platforms: z.array(platformKey).max(40).default([])
    .refine(keys => new Set(keys).size === keys.length),
});
const operations = new Set(["full_check", "observations", "diagnoses", "opportunities", "brand_configuration", "competitor_configuration", "content", "research", "questions", "competitors", "local_opportunities", "measurement"]);
/** Only fields used by connection setup cross the backend boundary, even if a provider adds private diagnostics. */
export function consoleCapabilities(value: unknown) {
  const result = publicCapabilities.safeParse(value);
  if (!result.success) throw new ProviderError("capability", "SurfacedBy availability could not be verified. Try the connection again.");
  const capability = result.data;
  return { ...capability, operations: capability.operations.filter(operation => operations.has(operation)),
    selected_question_platforms: capability.operations.includes('measurement')
      ? capability.selected_question_platforms.filter(key => capability.platforms.some(row => row.key === key && row.enabled)) : [] };
}
