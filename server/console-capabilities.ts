import { z } from "zod";
import { ProviderError } from "./contracts.js";
import { platformKey } from './platforms.js';
import { usdString, quotedCreditUsd, creditUnitUsd } from './console-pricing.js';

const measurementPricing = z.object({
  estimates_free: z.literal(true), estimate_validity_seconds: z.number().int().positive(),
  credit_increment: z.literal(1), rounding: z.literal('up_to_whole_credit_per_request'),
  settlement: z.literal('actual_usage_up_to_estimate'),
  platforms: z.array(z.object({ platform: platformKey, one_answer_credits: z.number().int().positive(),
    one_answer_usd: usdString })).max(40).refine(rows => new Set(rows.map(row => row.platform)).size === rows.length),
});

const publicCapabilities = z.object({
  contract_version: z.string().max(40).optional(),
  platforms: z.array(z.object({ key: platformKey, name: z.string().min(1).max(80), enabled: z.boolean() })).max(40)
    .refine(rows => new Set(rows.map(row => row.key)).size === rows.length),
  operations: z.array(z.string().max(80)).max(40).default([]),
  content_available: z.boolean().default(false),
  selected_question_platforms: z.array(platformKey).max(40).default([])
    .refine(keys => new Set(keys).size === keys.length),
  pricing: z.object({ credit_usd: z.number().finite().positive(),
    measurement: measurementPricing.nullable().optional() }).optional(),
});
const operations = new Set(["full_check", "observations", "diagnoses", "opportunities", "brand_configuration", "competitor_configuration", "content", "research", "questions", "competitors", "local_opportunities", "measurement"]);
/** Only fields used by connection setup cross the backend boundary, even if a provider adds private diagnostics. */
export function consoleCapabilities(value: unknown) {
  const result = publicCapabilities.safeParse(value);
  if (!result.success) throw new ProviderError("capability", "SurfacedBy availability could not be verified. Try the connection again.");
  const capability = result.data;
  const selected = capability.operations.includes('measurement')
    ? capability.selected_question_platforms.filter(key => capability.platforms.some(row => row.key === key && row.enabled)) : [];
  const pricing = capability.pricing?.measurement;
  if (pricing) {
    const unit = creditUnitUsd(capability.pricing!.credit_usd);
    for (const row of pricing.platforms)
      if (quotedCreditUsd({ estimated_credits: row.one_answer_credits, estimated_usd: row.one_answer_usd }) !== unit)
        throw new ProviderError('capability', 'SurfacedBy returned inconsistent prices. Refresh before starting.');
  }
  return { ...capability, operations: capability.operations.filter(operation => operations.has(operation)),
    selected_question_platforms: selected,
    pricing: capability.pricing ? { ...capability.pricing, measurement: pricing && selected.length
      ? { ...pricing, platforms: pricing.platforms.filter(row => selected.includes(row.platform)) } : null } : undefined };
}
