import { Connections } from "./oauth.js";
import { Vault } from "./vault.js";
import {
  ProviderError,
  type Provider,
  type Model,
  type Citation,
  type CredentialInput,
} from "./contracts.js";
import { providerJson } from "./network.js";
export type Completion = {
  text: string;
  costUsd: number | null;
  citations: Citation[];
  model: string;
  webSearchConfirmed?: boolean;
};
function reportedCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function parseDfs(body: any): Completion {
  const task = body.tasks?.[0];
  if (body.status_code !== 20000 || task?.status_code !== 20000)
    throw new ProviderError(
      "provider",
      "The measurement provider did not complete the task.",
      Boolean(task?.cost),
    );
  const result = task.result?.[0];
  if (!result)
    throw new ProviderError(
      "invalid_response",
      "Measurement returned no answer.",
      true,
    );
  const sections = (result.items ?? []).flatMap((x: any) => x.sections ?? []);
  const text = sections
    .filter((s: any) => s.type === "text")
    .map((s: any) => s.text ?? "")
    .join("\n");
  const citations = safeCitations(sections.flatMap((s: any) => s.annotations ?? []));
  if (!text.trim())
    throw new ProviderError(
      "invalid_response",
      "Measurement returned no usable answer.",
      true,
    );
  return {
    text,
    costUsd: reportedCost(task.cost),
    citations,
    model: result.model_name,
  };
}
function credentialHeaders(provider: Provider, credential: { key?: string; login?: string; password?: string }): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(provider === "console" ? { "X-API-Key": credential.key ?? "" } : {
      Authorization: provider === "dataforseo"
        ? "Basic " + Buffer.from(credential.login + ":" + credential.password).toString("base64")
        : "Bearer " + credential.key,
    }),
  };
}
export class Providers {
  constructor(
    readonly vault: Vault,
    readonly connections: Connections,
  ) {}
  headers(provider: Provider): Record<string, string> {
    const c = this.vault.get(provider);
    if (!c)
      throw new ProviderError("auth", "Connect this provider in Settings.");
    return credentialHeaders(provider, c);
  }
  /** Validate with read-only account endpoints before replacing a working local credential. */
  async validateConnection(input: CredentialInput) {
    const urls = {
      openrouter: "https://openrouter.ai/api/v1/key",
      dataforseo: "https://api.dataforseo.com/v3/appendix/user_data",
      console: "https://api.surfacedby.com/api/v1/console/capabilities",
    };
    const result = await providerJson(urls[input.provider], { headers: credentialHeaders(input.provider, input) }, 20000);
    if (input.provider === "dataforseo") {
      if (result.status_code !== 20000 || result.tasks?.[0]?.status_code !== 20000)
        throw new ProviderError("auth", "DataForSEO could not verify these credentials. Check your API login and password.");
    } else if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
      throw new ProviderError("invalid_response", "The provider did not confirm this connection. Your previous connection was kept.");
    }
  }
  async models(provider: Provider, platform = "chat_gpt"): Promise<Model[]> {
    if (provider === "chatgpt") {
      const b = await providerJson("https://api.openai.com/v1/models", {
        headers: {
          Authorization: "Bearer " + (await this.connections.token()),
        },
      });
      return (b.models ?? [])
        .filter((x: any) => x.visibility === "list")
        .map((x: any) => ({
          id: x.slug,
          name: x.display_name,
          contextLength: x.context_window ?? 32768,
          inputUsd: 0,
          outputUsd: 0,
        }));
    }
    if (provider === "openrouter") {
      const b = await providerJson("https://openrouter.ai/api/v1/models");
      return (b.data ?? [])
        .filter(
          (x: any) =>
            x.architecture?.output_modalities?.includes("text") &&
            x.supported_parameters?.includes("max_tokens") &&
            Number.isFinite(Number(x.pricing?.prompt)) &&
            Number.isFinite(Number(x.pricing?.completion)) &&
            Number(x.pricing?.prompt) >= 0 && Number(x.pricing?.completion) >= 0 &&
            x.pricing?.prompt != null && x.pricing?.completion != null &&
            Number(x.pricing?.request ?? 0) === 0,
        )
        .map((x: any) => ({
          id: x.id,
          name: x.name,
          contextLength: x.context_length,
          inputUsd: Number(x.pricing.prompt),
          outputUsd: Number(x.pricing.completion),
          maxOutputTokens: x.top_provider?.max_completion_tokens,
        }))
        .sort(
          (a: Model, b: Model) =>
            Number(b.id === "openai/gpt-6-sol") -
              Number(a.id === "openai/gpt-6-sol") ||
            a.name.localeCompare(b.name),
        );
    }
    if (provider === "dataforseo") {
      const b = await providerJson(
        "https://api.dataforseo.com/v3/ai_optimization/" +
          platform +
          "/llm_responses/models",
        { headers: this.headers(provider) },
      );
      if (b.status_code !== 20000)
        throw new ProviderError(
          "provider",
          "Unable to load measurement models.",
        );
      return (b.tasks?.[0]?.result ?? [])
        .filter((x: any) => x.web_search_supported !== false)
        .map((x: any) => ({
          id: x.model_name,
          name: x.model_name,
          contextLength: 32768,
          inputUsd: 0,
          outputUsd: 0,
        }));
    }
    const b = await this.console("/capabilities");
    return b.data?.models ?? [];
  }
  async complete(
    provider: Provider,
    model: string,
    instructions: string,
    input: string,
    signal: AbortSignal,
    maxTokens = 4096,
    webSearch = false,
    prices?: Pick<Model, "inputUsd" | "outputUsd">,
  ): Promise<Completion> {
    if (provider === "openrouter") {
      if (!prices || ![prices.inputUsd, prices.outputUsd].every((price) => Number.isFinite(price) && price >= 0 && Number.isFinite(price * 1_000_000)))
        throw new ProviderError("estimate", "This model has no usable price bounds. Refresh the model list before running paid work.");
      const b = await providerJson(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: this.headers(provider),
          signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: instructions },
              { role: "user", content: input },
            ],
            max_tokens: maxTokens,
            usage: { include: true },
            provider: { require_parameters: true,
              max_price: { prompt: prices.inputUsd * 1_000_000, completion: prices.outputUsd * 1_000_000, request: 0 } },
          }),
        },
      );
      const choice = b.choices?.[0];
      if (choice?.finish_reason !== "stop")
        throw new ProviderError(
          "incomplete",
          "The model did not finish this pass. Review provider usage before retrying.",
          true,
        );
      if (
        typeof choice.message?.content !== "string" ||
        !choice.message.content.trim()
      )
        throw new ProviderError(
          "invalid_response",
          "No usable model output.",
          true,
        );
      return {
        text: choice.message.content,
        costUsd: reportedCost(b.usage?.cost),
        citations: safeCitations(choice.message?.annotations ?? []),
        model: b.model,
      };
    }
    if (provider !== "chatgpt")
      throw new ProviderError(
        "capability",
        "Select ChatGPT or OpenRouter for local content.",
      );
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (await this.connections.token()),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      body: JSON.stringify({
        model,
        instructions,
        input: [{ role: "user", content: input }],
        store: false,
        stream: true,
        // A visibility check needs a fresh search; merely offering the tool lets the model skip it.
        ...(webSearch ? { tools: [{ type: "web_search" }], tool_choice: "required" } : {}),
      }),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => null);
      const code = b?.error?.code;
      throw new ProviderError(
        r.status === 429 ? "quota" : r.status === 401 ? "auth" : "provider",
        r.status === 429
          ? "ChatGPT usage limit reached. Manage usage or resume later."
          : code === "subscription_sharing_user_not_eligible" ? "This ChatGPT account is not eligible for plan sharing. Review account eligibility; repeated sign-in will not resolve this restriction."
          : code === "subscription_sharing_unsupported_capability" ? "This model or account does not allow the requested capability. Change the model or turn off web search before starting a new check."
          : "ChatGPT could not complete this request.",
        r.status >= 500,
      );
    }
    if (!r.body)
      throw new ProviderError("interrupted", "The stream did not start.", true);
    let buffer = "",
      text = "",
      completed = false, webSearchConfirmed = false;
    let citations: Citation[] = [];
    const finishedItems = new Map<number, any>();
    const decoder = new TextDecoder();
    responseStream: for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 2_000_000)
        throw new ProviderError(
          "invalid_response",
          "Response exceeded the size limit.",
          true,
        );
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith("data:") || line === "data: [DONE]") continue;
        const event = JSON.parse(line.slice(5));
        if (event.type === "response.output_text.delta")
          text += event.delta ?? "";
        if (event.type === "response.output_item.done")
          finishedItems.set(event.output_index, event.item);
        if (event.type === "response.output_text.annotation.added")
          citations.push(...safeCitations([event.annotation]));
        if (text.length > 2_000_000)
          throw new ProviderError(
            "invalid_response",
            "Response exceeded the size limit.",
            true,
          );
        if (event.type === "response.completed") {
          completed = event.response?.status === "completed";
          // Plan sharing may omit output in the terminal event. Completed stream items still carry the actual tool and citation evidence.
          const output = event.response?.output?.length ? event.response.output : [...finishedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
          webSearchConfirmed = output.some((item: any) => item.type === "web_search_call" && item.status === "completed");
          const parts = output.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === "output_text");
          const finalText = parts.map((part: any) => part.text ?? "").join("\n");
          if (finalText.trim()) text = finalText;
          citations = safeCitations([...citations, ...parts.flatMap((part: any) => part.annotations ?? [])]);
          if (completed) break responseStream;
        }
        if (
          ["response.failed", "response.incomplete", "error"].includes(
            event.type,
          )
        ) {
          const code =
            event.response?.error?.code ?? event.error?.code ?? event.code;
          throw new ProviderError(
            String(code).includes("usage_limit") ? "quota" : "incomplete",
            "ChatGPT stopped this response. No paid fallback was used.",
            !String(code).includes("usage_limit"),
          );
        }
      }
    }
    if (!completed || !text.trim())
      throw new ProviderError(
        "interrupted",
        "ChatGPT did not confirm completion. Review usage before retrying.",
        true,
      );
    return { text, costUsd: 0, citations, model, webSearchConfirmed };
  }
  async measure(
    platform: string,
    model: string,
    prompt: string,
    locale: string,
    signal: AbortSignal,
  ) {
    const b = await providerJson(
      "https://api.dataforseo.com/v3/ai_optimization/" +
        platform +
        "/llm_responses/live",
      {
        method: "POST",
        headers: this.headers("dataforseo"),
        signal,
        body: JSON.stringify([
          {
            model_name: model,
            user_prompt: prompt,
            web_search: true,
            max_output_tokens: 2048,
            ...(platform === "chat_gpt"
              ? { web_search_country_iso_code: locale.split("-")[1] ?? "US" }
              : {}),
          },
        ]),
      },
    );
    return parseDfs(b);
  }
  async console(
    path: string,
    body?: unknown,
    key?: string,
    signal?: AbortSignal,
    method?: "POST" | "PATCH",
  ) {
    return providerJson("https://api.surfacedby.com/api/v1/console" + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        ...this.headers("console"),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      signal,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

/** Citation metadata is projected explicitly, without supplier tracking fields or invented links. */
export function safeCitations(annotations: unknown): Citation[] {
  const seen = new Set<string>(), citations: Citation[] = [];
  if (!Array.isArray(annotations)) return citations;
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) continue;
    const citation = annotation.url_citation ?? annotation;
    if (!citation || typeof citation !== "object" || Array.isArray(citation)) continue;
    if (typeof citation.url !== "string") continue;
    try {
      const url = new URL(citation.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href); citations.push({ url: citation.url, ...(typeof citation.title === "string" ? { title: citation.title } : {}) });
    } catch { /* Malformed supplier annotations are not usable citation evidence. */ }
  }
  return citations;
}
