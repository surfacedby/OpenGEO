import { ProviderError } from "./contracts.js";
import { readLimited, isPublicEvidenceUrl } from "./network.js";
import { multiplyUsd, sumUsd, withinUsdBudget } from "./usd.js";
import {
  deepseekAnswerEstimate,
  deepseekModels,
  deepseekPrices,
  isPeak,
  maxSearches,
  resultLimits,
  searchCount,
  type PricedModel,
} from "./deepseek-pricing.js";

export {
  deepseekAnswerEstimate,
  deepseekCheckBudget,
  deepseekModels,
  deepseekPrices,
  isPeak,
  maxSearches,
} from "./deepseek-pricing.js";

/** Every DeepSeek request, and therefore the API key, goes to this host only. It is not configurable. */
export const DEEPSEEK = "https://api.deepseek.com";

/** The Ask drawer's estimate for the default model, before the job knows its model. */
export function deepseekAskEstimate(question: string) {
  const [flash] = deepseekModels(["deepseek-flash"]);
  return deepseekAnswerEstimate(
    flash,
    Buffer.byteLength(question, "utf8") + 1200,
    4096,
  );
}

/** One request to DeepSeek. Statuses map to pauses a person can act on; nothing falls back to another provider. */
export async function deepseekJson(
  path: string,
  key: string,
  body?: unknown,
  signal?: AbortSignal,
  timeout = 20_000,
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(DEEPSEEK + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer " + key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ProviderError(
      "connection_interrupted",
      "The DeepSeek connection was interrupted. Review usage before retrying.",
      true,
    );
  }
  // A non-streaming reply may be preceded by keep-alive blank lines; JSON.parse accepts leading whitespace.
  const parsed = await readLimited(response, 10_000_000)
    .then(JSON.parse)
    .catch(() => null);
  if (!response.ok) {
    if (response.status === 401)
      throw new ProviderError(
        "auth",
        "DeepSeek rejected the API key. Reconnect DeepSeek in Settings.",
      );
    if (response.status === 402)
      throw new ProviderError(
        "quota",
        "DeepSeek balance is insufficient. Top up at platform.deepseek.com. No other provider was used.",
      );
    if (response.status === 429)
      throw new ProviderError(
        "quota",
        "DeepSeek rate limit reached. Work is paused.",
      );
    throw new ProviderError(
      "provider",
      "DeepSeek rejected this request (" + response.status + ").",
      response.status >= 500,
    );
  }
  if (!parsed || typeof parsed !== "object")
    throw new ProviderError(
      "invalid_response",
      "DeepSeek returned an unreadable response.",
      true,
    );
  return parsed;
}

const searchTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web with DeepSeek's search engine for current or factual information. Cite the results you rely on as markdown links to their url.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query of at most 128 characters. Supports site: and lang: operators.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

/** Answers are shown and scored as written; search progress belongs in the surrounding UI. */
const answerRules =
  "Write only the answer for the reader. Do not mention your searches, the search tool or any search limit.";

const text = (value: unknown, max: number) =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
function trimResults(results: unknown) {
  if (!Array.isArray(results)) return [];
  return results
    .slice(0, searchCount)
    .map((r: any) => ({
      title: text(r?.title, resultLimits.title),
      url: text(r?.url, resultLimits.url),
      snippet: text(r?.snippet, resultLimits.snippet),
      date: text(r?.date, resultLimits.date),
    }))
    .filter((r) => isPublicEvidenceUrl(r.url));
}

/** Cost of one chat call from its reported usage, at the rate in force when the call started; null when usage is missing. */
function callCost(model: PricedModel, usage: any, at: Date): number | null {
  const rates = isPeak(at) ? model.peak : model.offPeak;
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const prompt = count(usage?.prompt_tokens),
    output = count(usage?.completion_tokens);
  if (prompt === null || output === null) return null;
  const hit = count(usage.prompt_cache_hit_tokens) ?? 0,
    miss = count(usage.prompt_cache_miss_tokens) ?? Math.max(0, prompt - hit);
  if (hit > prompt || hit + miss !== prompt) return null;
  return sumUsd([
    multiplyUsd(rates.hit / 1_000_000, hit),
    multiplyUsd(rates.miss / 1_000_000, miss),
    multiplyUsd(rates.output / 1_000_000, output),
  ]);
}

/** Extract candidate links; only URLs backed by returned search evidence become citations. */
export function answerLinks(answer: string) {
  const links: { url: string; title?: string }[] = [],
    seen = new Set<string>();
  const add = (url: string, title?: string) => {
    const clean = url.replace(/[.,;:!?'"]+$/, "");
    if (!seen.has(clean)) {
      seen.add(clean);
      links.push({ url: clean, ...(title ? { title } : {}) });
    }
  };
  for (const m of answer.matchAll(
    /\[([^\]\n]{0,300})\]\((https?:\/\/[^\s)]+)\)/g,
  ))
    add(m[2], m[1].trim() || undefined);
  for (const m of answer.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/g)) add(m[0]);
  return links;
}

export type DeepSeekAnswer = {
  text: string;
  links: { url: string; title?: string }[];
  retrievedSources: { url: string; title?: string }[];
  searchQueries: string[];
  webSearchConfirmed: boolean;
  model: string;
  costUsd: number | null;
};

/**
 * One answer, with DeepSeek's own search run on the model's behalf through a function tool. Thinking stays off:
 * the answer fits the shared output cap, and earlier turns need no reasoning echoed back.
 */
export async function deepseekComplete(
  key: string,
  model: string,
  instructions: string,
  input: string,
  signal: AbortSignal,
  maxTokens: number,
  webSearch: boolean,
  now: () => Date = () => new Date(),
): Promise<DeepSeekAnswer> {
  const priced = deepseekPrices.models[model];
  if (!priced)
    throw new ProviderError(
      "capability",
      "Choose a DeepSeek model OpenGEO has prices for.",
    );
  const messages: any[] = [
    {
      role: "system",
      content: instructions + (webSearch ? " " + answerRules : ""),
    },
    { role: "user", content: input },
  ];
  const queries: string[] = [];
  const retrieved = new Map<string, { url: string; title?: string }>();
  const [budgetModel] = deepseekModels([model]);
  const allowance = deepseekAnswerEstimate(
    budgetModel,
    Buffer.byteLength(instructions + input, "utf8") + 1000,
    maxTokens,
  );
  let paidReplyReceived = false;
  let cost: number | null = 0,
    searches = 0,
    confirmed = false;
  try {
    for (let call = 0; call <= maxSearches; call++) {
      signal.throwIfAborted();
      const offer = webSearch && searches < maxSearches && call < maxSearches;
      const at = now();
      const request = {
        model,
        messages,
        max_tokens: maxTokens,
        stream: false,
        thinking: { type: "disabled" },
        ...(offer ? { tools: [searchTool], tool_choice: "auto" } : {}),
      };
      // Search text and parallel tool calls can grow unpredictably. Recheck the actual
      // serialized context before every paid call, within the original answer approval.
      const nextMaximum = sumUsd([
        multiplyUsd(
          budgetModel.inputUsd,
          Buffer.byteLength(JSON.stringify(request), "utf8") + 1000,
        ),
        multiplyUsd(budgetModel.outputUsd, maxTokens),
      ]);
      if (cost === null || !withinUsdBudget(allowance, [cost, nextMaximum]))
        throw new ProviderError(
          "budget",
          "DeepSeek needs more context than this answer allows. Review usage before retrying.",
          paidReplyReceived,
        );
      const reply = await deepseekJson(
        "/chat/completions",
        key,
        request,
        signal,
        600_000,
      );
      paidReplyReceived = true;
      if (reply.model !== model)
        throw new ProviderError(
          "invalid_response",
          "DeepSeek returned an unexpected model. Review usage before retrying.",
          true,
        );
      const spent = callCost(priced, reply.usage, at);
      cost = cost === null || spent === null ? null : sumUsd([cost, spent]);
      const choice = reply.choices?.[0],
        message = choice?.message;
      if (
        choice?.finish_reason === "tool_calls" &&
        Array.isArray(message?.tool_calls) &&
        message.tool_calls.length
      ) {
        if (!offer)
          throw new ProviderError(
            "invalid_response",
            "DeepSeek asked for a tool it was not offered. Review usage before retrying.",
            true,
          );
        if (cost === null)
          throw new ProviderError(
            "cost_unknown",
            "DeepSeek omitted valid usage. Review usage before continuing.",
            true,
          );
        messages.push({
          role: "assistant",
          content: message.content ?? null,
          tool_calls: message.tool_calls,
        });
        for (const tool of message.tool_calls) {
          let content: unknown;
          let query = "";
          try {
            query = text(
              JSON.parse(tool?.function?.arguments ?? "{}")?.query,
              128,
            );
          } catch {
            /* answered below as a bad request */
          }
          if (tool?.function?.name !== "web_search")
            content = { error: "Unknown tool." };
          else if (searches >= maxSearches)
            content = {
              error:
                "No more searches are available. Answer from the results you have.",
            };
          else if (!query)
            content = { error: "Give a search query of 1 to 128 characters." };
          else {
            searches++;
            if (!withinUsdBudget(allowance, [cost!, deepseekPrices.searchUsd]))
              throw new ProviderError(
                "budget",
                "DeepSeek reached this answer's search allowance. Review usage before retrying.",
                true,
              );
            const response = await deepseekJson(
              "/v1/tools/search",
              key,
              { query, count: searchCount },
              signal,
              60_000,
            );
            if (!Array.isArray(response.results))
              throw new ProviderError(
                "invalid_response",
                "DeepSeek returned an unreadable search result. Review usage before retrying.",
                true,
              );
            const found = trimResults(response.results);
            // The supplier bills the raw nonempty result, even if its links cannot be displayed.
            if (response.results.length)
              cost = sumUsd([cost!, deepseekPrices.searchUsd]);
            if (found.length) confirmed = true;
            for (const result of found)
              retrieved.set(result.url, {
                url: result.url,
                title: result.title,
              });
            queries.push(query);
            content = { results: found };
          }
          messages.push({
            role: "tool",
            tool_call_id: tool?.id,
            content: JSON.stringify(content),
          });
        }
        continue;
      }
      if (choice?.finish_reason === "length")
        throw new ProviderError(
          "incomplete",
          "DeepSeek did not finish this answer within the output allowance. Review usage before retrying.",
          true,
        );
      if (
        choice?.finish_reason !== "stop" ||
        typeof message?.content !== "string" ||
        !message.content.trim()
      )
        throw new ProviderError(
          "invalid_response",
          "DeepSeek returned no usable answer. Review usage before retrying.",
          true,
        );
      const links = answerLinks(message.content).filter((link) =>
        retrieved.has(link.url),
      );
      const cited = new Set(links.map((link) => link.url));
      return {
        text: message.content,
        links,
        retrievedSources: [...retrieved.values()].filter(
          (link) => !cited.has(link.url),
        ),
        searchQueries: queries,
        webSearchConfirmed: confirmed,
        model: reply.model,
        costUsd: cost,
      };
    }
    throw new ProviderError(
      "incomplete",
      "DeepSeek kept searching without answering. Review usage before retrying.",
      true,
    );
  } catch (error) {
    // A later definite refusal cannot erase earlier paid calls from this answer.
    if (paidReplyReceived && error instanceof ProviderError)
      error.uncertain = true;
    throw error;
  }
}
