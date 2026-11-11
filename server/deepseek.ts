import { ProviderError } from "./contracts.js";
import { readLimited } from "./network.js";
import { deepseekAnswerEstimate, deepseekModels, deepseekPrices, isPeak, maxSearches, resultLimits, searchCount, type PricedModel } from "./deepseek-pricing.js";

export { deepseekAnswerEstimate, deepseekCheckBudget, deepseekModels, deepseekPrices, isPeak, maxSearches } from "./deepseek-pricing.js";

/** Every DeepSeek request, and therefore the API key, goes to this host only. It is not configurable. */
export const DEEPSEEK = "https://api.deepseek.com";

/** The Ask drawer's estimate for the default model, before the job knows its model. */
export function deepseekAskEstimate(question: string) {
  const [flash] = deepseekModels(["deepseek-flash"]);
  return deepseekAnswerEstimate(flash, Buffer.byteLength(question, "utf8") + 1200, 4096);
}

/** One request to DeepSeek. Statuses map to pauses a person can act on; nothing falls back to another provider. */
export async function deepseekJson(path: string, key: string, body?: unknown, signal?: AbortSignal, timeout = 20_000): Promise<any> {
  let response: Response;
  try {
    response = await fetch(DEEPSEEK + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { Authorization: "Bearer " + key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ProviderError("connection_interrupted", "The DeepSeek connection was interrupted. Review usage before retrying.", true);
  }
  // A non-streaming reply may be preceded by keep-alive blank lines; JSON.parse accepts leading whitespace.
  const parsed = await readLimited(response, 10_000_000).then(JSON.parse).catch(() => null);
  if (!response.ok) {
    const detail = typeof parsed?.error?.message === "string" ? " " + parsed.error.message.replace(/[^\x20-\x7e]/g, " ").slice(0, 200).trim() : "";
    if (response.status === 401) throw new ProviderError("auth", "DeepSeek rejected the API key. Reconnect DeepSeek in Settings.");
    if (response.status === 402) throw new ProviderError("quota", "DeepSeek balance is insufficient. Top up at platform.deepseek.com. No other provider was used.");
    if (response.status === 429) throw new ProviderError("quota", "DeepSeek rate limit reached. Work is paused.");
    throw new ProviderError("provider", "DeepSeek rejected this request (" + response.status + ")." + detail, response.status >= 500);
  }
  if (!parsed || typeof parsed !== "object")
    throw new ProviderError("invalid_response", "DeepSeek returned an unreadable response.", true);
  return parsed;
}

const searchTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web with DeepSeek's search engine for current or factual information. Cite the results you rely on as markdown links to their url.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query of at most 128 characters. Supports site: and lang: operators." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

/** The answer is shown and scored as written, so the model must not narrate its searching (a live answer opened with
 * "I've hit my search limit" before this rule). */
const answerRules = "Write only the answer for the reader. Do not mention your searches, the search tool or any search limit.";

const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
function trimResults(results: unknown) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, searchCount).map((r: any) => ({
    title: text(r?.title, resultLimits.title), url: text(r?.url, resultLimits.url),
    snippet: text(r?.snippet, resultLimits.snippet), date: text(r?.date, resultLimits.date),
  })).filter(r => r.url);
}

/** Cost of one chat call from its reported usage, at the rate in force when the call started; null when usage is missing. */
function callCost(model: PricedModel, usage: any, at: Date): number | null {
  const rates = isPeak(at) ? model.peak : model.offPeak;
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const prompt = count(usage?.prompt_tokens), output = count(usage?.completion_tokens);
  if (prompt === null || output === null) return null;
  const hit = count(usage.prompt_cache_hit_tokens) ?? 0, miss = count(usage.prompt_cache_miss_tokens) ?? Math.max(0, prompt - hit);
  return (hit * rates.hit + miss * rates.miss + output * rates.output) / 1_000_000;
}

/** Links in the final answer are its citations: markdown links first (they carry a title), then bare URLs. */
export function answerLinks(answer: string) {
  const links: { url: string; title?: string }[] = [], seen = new Set<string>();
  const add = (url: string, title?: string) => {
    const clean = url.replace(/[.,;:!?'"]+$/, "");
    if (!seen.has(clean)) { seen.add(clean); links.push({ url: clean, ...(title ? { title } : {}) }); }
  };
  for (const m of answer.matchAll(/\[([^\]\n]{0,300})\]\((https?:\/\/[^\s)]+)\)/g)) add(m[2], m[1].trim() || undefined);
  for (const m of answer.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/g)) add(m[0]);
  return links;
}

export type DeepSeekAnswer = {
  text: string; links: { url: string; title?: string }[]; searchQueries: string[];
  webSearchConfirmed: boolean; model: string; costUsd: number | null;
};

/**
 * One answer, with DeepSeek's own search run on the model's behalf through a function tool. Thinking stays off:
 * the answer fits the shared output cap, and earlier turns need no reasoning echoed back.
 */
export async function deepseekComplete(
  key: string, model: string, instructions: string, input: string, signal: AbortSignal,
  maxTokens: number, webSearch: boolean, now: () => Date = () => new Date(),
): Promise<DeepSeekAnswer> {
  const priced = deepseekPrices.models[model];
  if (!priced) throw new ProviderError("capability", "Choose a DeepSeek model OpenGEO has prices for.");
  const messages: any[] = [{ role: "system", content: instructions + (webSearch ? " " + answerRules : "") }, { role: "user", content: input }];
  const queries: string[] = [];
  let cost: number | null = 0, searches = 0, confirmed = false;
  for (let call = 0; call <= maxSearches; call++) {
    signal.throwIfAborted();
    const offer = webSearch && searches < maxSearches && call < maxSearches;
    const at = now();
    const reply = await deepseekJson("/chat/completions", key, {
      model, messages, max_tokens: maxTokens, stream: false, thinking: { type: "disabled" },
      ...(offer ? { tools: [searchTool], tool_choice: "auto" } : {}),
    }, signal, 600_000);
    const spent = callCost(priced, reply.usage, at);
    cost = cost === null || spent === null ? null : cost + spent;
    const choice = reply.choices?.[0], message = choice?.message;
    if (choice?.finish_reason === "tool_calls" && Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      if (!offer) throw new ProviderError("invalid_response", "DeepSeek asked for a tool it was not offered. Review usage before retrying.", true);
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
      for (const tool of message.tool_calls) {
        let content: unknown;
        let query = "";
        try { query = text(JSON.parse(tool?.function?.arguments ?? "{}")?.query, 128); } catch { /* answered below as a bad request */ }
        if (tool?.function?.name !== "web_search") content = { error: "Unknown tool." };
        else if (searches >= maxSearches) content = { error: "No more searches are available. Answer from the results you have." };
        else if (!query) content = { error: "Give a search query of 1 to 128 characters." };
        else {
          searches++;
          try {
            const found = trimResults((await deepseekJson("/v1/tools/search", key, { query, count: searchCount }, signal, 60_000)).results);
            // DeepSeek bills a search only when it returns results.
            if (found.length) { confirmed = true; if (cost !== null) cost += deepseekPrices.searchUsd; }
            queries.push(query);
            content = { results: found };
          } catch (error) {
            if (error instanceof ProviderError && (error.code === "auth" || error.code === "quota")) throw error;
            queries.push(query);
            content = { error: "Search is unavailable right now." };
          }
        }
        messages.push({ role: "tool", tool_call_id: tool?.id, content: JSON.stringify(content) });
      }
      continue;
    }
    if (choice?.finish_reason === "length")
      throw new ProviderError("incomplete", "DeepSeek did not finish this answer within the output allowance. Review usage before retrying.", true);
    if (choice?.finish_reason !== "stop" || typeof message?.content !== "string" || !message.content.trim())
      throw new ProviderError("invalid_response", "DeepSeek returned no usable answer. Review usage before retrying.", true);
    return { text: message.content, links: answerLinks(message.content), searchQueries: queries, webSearchConfirmed: confirmed,
      model: typeof reply.model === "string" ? reply.model : model, costUsd: cost === null ? null : Math.round(cost * 1e8) / 1e8 };
  }
  throw new ProviderError("incomplete", "DeepSeek kept searching without answering. Review usage before retrying.", true);
}
