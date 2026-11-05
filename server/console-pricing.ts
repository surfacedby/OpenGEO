import { z } from 'zod';
import { ProviderError } from './contracts.js';

const scale = 1_000_000;
export const usdString = z.string().regex(/^\d{1,9}(?:\.\d{1,6})?$/)
  .refine(value => Number.isSafeInteger(Math.round(Number(value) * scale)));

export function creditUnitUsd(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000 ||
      Math.abs(value * scale - Math.round(value * scale)) > 1e-7 || Math.round(value * scale) < 1)
    throw new ProviderError('estimate', 'SurfacedBy did not return a usable credit price. Nothing was submitted.');
  return value;
}

/** Keep the quote's valuation through approval, recovery and settlement, even if the current rate changes. */
export function quotedCreditUsd(quote: { estimated_credits: number; estimated_usd: string }): number {
  const amount = usdString.parse(quote.estimated_usd);
  const micros = Math.round(Number(amount) * scale);
  if (!Number.isSafeInteger(quote.estimated_credits) || quote.estimated_credits <= 0 || micros <= 0 || micros % quote.estimated_credits !== 0)
    throw new ProviderError('estimate', 'SurfacedBy returned an inconsistent price. Nothing was submitted.');
  return micros / quote.estimated_credits / scale;
}

export function creditsUsd(credits: number, unitUsd: number): number {
  creditUnitUsd(unitUsd);
  if (!Number.isSafeInteger(credits) || credits < 0)
    throw new ProviderError('estimate', 'SurfacedBy returned an invalid credit price.');
  const micros = Math.round(unitUsd * scale);
  if (micros < 1 || !Number.isSafeInteger(credits * micros))
    throw new ProviderError('estimate', 'SurfacedBy returned an unsupported credit price.');
  return credits * micros / scale;
}

/** Floor the monetary approval: converting a limit must never authorize an extra credit. */
export function creditsWithinBudget(budgetUsd: number, unitUsd: number): number {
  creditsUsd(0, unitUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 1000000)
    throw new ProviderError('budget', 'Choose a valid spending limit.');
  return Math.floor(Math.floor(budgetUsd * scale + 1e-7) / Math.round(unitUsd * scale));
}
