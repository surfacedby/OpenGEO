import type { Model } from "./contracts.js";

// DeepSeek's prices and the worst-case answer estimate, with no Node or network imports, so the server
// (budget checks before every request) and the check dialog (the suggested run budget) use the same math.

export type Rates = { hit: number; miss: number; output: number };
export type PricedModel = { name: string; contextLength: number; maxOutputTokens: number; offPeak: Rates; peak: Rates };
/**
 * DeepSeek's published rates in USD per million tokens, and its search fee per successful request.
 * Read from https://api-docs.deepseek.com/quick_start/pricing on the date below; update both together.
 */
export const deepseekPrices: { checked: string; source: string; searchUsd: number; models: Record<string, PricedModel> } = {
  checked: "2026-11-09",
  source: "https://api-docs.deepseek.com/quick_start/pricing",
  searchUsd: 0.75 / 1000,
  models: {
    "deepseek-flash": { name: "DeepSeek Flash", contextLength: 1_048_576, maxOutputTokens: 393_216,
      offPeak: { hit: 0.003, miss: 0.15, output: 0.6 }, peak: { hit: 0.006, miss: 0.3, output: 1.2 } },
    "deepseek-v4-pro": { name: "DeepSeek V4 Pro", contextLength: 1_048_576, maxOutputTokens: 393_216,
      offPeak: { hit: 0.022, miss: 0.66, output: 1.98 }, peak: { hit: 0.044, miss: 1.32, output: 3.96 } },
  },
};
/** At most this many searches per answer; the call after the last one has no tool, so the model must answer. */
export const maxSearches = 4;
export const searchCount = 8;
/** Each search result is trimmed to these fields and lengths before it goes back to the model. */
export const resultLimits = { title: 200, url: 500, snippet: 400, date: 40 };
export const resultBytes = 1300;
export const searchBytes = searchCount * resultBytes + 200;

/** DeepSeek's peak window: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. Chinese public holidays are
 * off-peak upstream but are not modelled here, so a holiday is costed at the higher peak rate. */
export function isPeak(at: Date) {
  const day = at.getUTCDay(), hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

/** Listed models OpenGEO has prices for, priced at the peak rate so any estimate errs high. */
export function deepseekModels(listed: string[]): Model[] {
  return Object.entries(deepseekPrices.models).filter(([id]) => listed.includes(id)).map(([id, m]) => ({
    id, name: m.name, contextLength: m.contextLength, maxOutputTokens: m.maxOutputTokens,
    inputUsd: m.peak.miss / 1_000_000, outputUsd: m.peak.output / 1_000_000,
  }));
}

/**
 * The most one answer can cost: every chat call at the peak cache-miss rate, carrying the question, all search
 * results so far and all earlier output, each producing the full output allowance, plus every search fee.
 */
export function deepseekAnswerEstimate(model: Pick<Model, "inputUsd" | "outputUsd">, tokenUpper: number, cap: number) {
  let total = 0, context = tokenUpper;
  for (let call = 0; call <= maxSearches; call++) {
    total += context * model.inputUsd + cap * model.outputUsd;
    context += cap + searchBytes;
  }
  return total + maxSearches * deepseekPrices.searchUsd;
}

/**
 * A run budget that lets a check of `questions` answers finish: a typical answer allowed at 15% of the worst
 * case (answers so far have cost about 7%), plus one full worst case, because each answer starts only if its
 * worst case still fits. Rounded up to the next $0.25. 82 questions on Flash suggest $1.00.
 */
export function deepseekCheckBudget(questions: number, model: Pick<Model, "inputUsd" | "outputUsd">, tokenUpper = 1700, cap = 4096) {
  const worst = deepseekAnswerEstimate(model, tokenUpper, cap);
  return Math.max(0.25, Math.ceil(worst * (0.15 * Math.max(0, questions) + 1) * 4) / 4);
}
