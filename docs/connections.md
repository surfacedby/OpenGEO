# Connections and costs

Start with the connection you already have. You can also use local audits and project storage without connecting any service.

| Connection | What it adds | What you need |
| --- | --- | --- |
| ChatGPT | API answer checks, analysis, question suggestions and content | An eligible subscription and the required account permissions. No separate API key; plan limits apply. |
| OpenRouter | API answer checks, analysis and content with a choice of models | An OpenRouter account with available credit. Connect with OAuth or an existing key. Model usage is billed by OpenRouter. |
| DataForSEO + OpenRouter | API answer collection, followed by AI analysis and content | Both accounts for the full workflow. Each provider charges for its usage. |
| SurfacedBy API | Managed checks and insights; suggestions, reviews and drafts when supported | An account with credit and a server that supports the requested operation. Availability is checked before it is offered. |
| DeepSeek | Visibility checks, schedules and one-off Asks, answered with DeepSeek's own web search | A DeepSeek API key with a positive balance. DeepSeek bills tokens and searches. Recommendations, suggestions and content stay with your other connections. |

![OpenGEO connection choices, with no accounts connected](../assets/provider-preview.webp)

Open **Settings > Connections** to connect a service. Credentials are encrypted on your installation and excluded from project exports.

## ChatGPT

OpenGEO implements the [published subscription-sharing protocol](https://developers.openai.com/siwc/token-sharing-open-source/) independently. Eligibility, preview access and permissions can change; a ChatGPT account does not automatically guarantee access. The example DevKit is not bundled.

Checks collect Responses API answers. These can differ from the answers in the ChatGPT website or app. Web search depends on the selected model and account permissions. OpenGEO records whether a search was requested and whether the response confirms it ran.

When self-hosting in local mode, use a [local port forward](distribution.md#remote-access) so the sign-in browser can reach the callback on the OpenGEO host. Optional [private-network mode](remote-access.md#connect-ai-services) also supports pasting the exact one-time loopback redirect URL into the authenticated workspace. Do not expose an unprotected backend or share that URL to make sign-in work.

## OpenRouter

Choose a model after connecting. Answer checks use model-only API calls without a search plugin, so they do not reproduce a web-search session in a consumer chat app. Source links must come from the provider's answer evidence.

OpenRouter bills for the selected model. OpenGEO bounds output and estimates cost using model rates; rates can change. Review the approved ceiling before running work.

## DataForSEO with OpenRouter

DataForSEO collects API answers with web search requested; OpenRouter handles analysis and content. These are not recordings of a logged-in consumer chat session. Results keep their original collection surface, model and locale so you can judge what is comparable.

A direct DataForSEO request has no per-request dollar cap. Its actual charge can exceed an estimate. Use conservative estimates in OpenGEO and spending controls in the provider account.

## SurfacedBy API

SurfacedBy is optional. You can keep using local projects and exports without a managed account.

OpenGEO checks the connected server's capabilities before offering managed work. Supported checks show a credit preview or quote for review. Selected-question checks collect answers for the approved list without automatically purchasing analysis. Suggestions and drafts require a separate price review when available.

**Managed features are experimental in this beta.** The desktop release does not certify live supplier quality, billing and refund recovery, worker activation, usage delivery or historical imports. Availability depends on the connected service; see the [beta notes](releases/v0.1.0-beta.4.md).

## DeepSeek

DeepSeek runs visibility checks (all questions or one topic, on demand or on a schedule) and one-off Asks. It collects answers only: recommendations, question suggestions, competitor reviews and content stay with your other connections. Paste an API key from the [DeepSeek platform](https://platform.deepseek.com/api_keys); OpenGEO checks it against DeepSeek's balance endpoint before saving it. The key is sent to `api.deepseek.com` and nowhere else.

An answer uses DeepSeek's chat API with its [search API](https://api-docs.deepseek.com/guides/search) offered to the model as a tool. The model decides what to search, up to four searches per answer, and OpenGEO runs each search and returns the results. After the fourth search the model must answer with what it has. `deepseek-flash` is the default model, and thinking mode is off.

DeepSeek bills input tokens (less when its cache is hit), output tokens, and $0.75 per 1,000 searches that return results. Peak-hour rates, 01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays, are twice the off-peak rates. OpenGEO keeps a dated copy of the [published prices](https://api-docs.deepseek.com/quick_start/pricing) and costs each answer from the token counts DeepSeek reports, at the rate in force when each request started. DeepSeek does not report a charge, so the recorded cost is labelled as an estimate. DeepSeek bills Chinese public holidays off-peak; OpenGEO costs them at peak, which errs high.

The Ask price reads "up to": it is the most one answer can cost, with every request at peak rates, the full output allowance and all four searches. A typical answer costs a fraction of a cent. An answer starts only when that maximum fits the engine's share of your limit. An insufficient balance pauses the answer, and no other provider is used.

A visibility check applies the same rule to every question: each answer starts only if its most expensive case still fits what is left of the run budget, so a budget that is too small stops the check early and keeps the answers already collected. The check dialog suggests a budget that lets the whole check finish (for 82 questions on `deepseek-flash`, $1.00). A schedule adds a monthly ceiling, and a scheduled check that would not fit what remains of it does not start.

A DeepSeek check is a reading of its own. The brand view shows the newest check from any connection, labelled with its engine, and each engine keeps its own trend and comparison. Recommendations keep reading the newest check from a connection that prepares them, so a DeepSeek check never replaces them.

## Spending, pauses and cancellation

An ask uses ChatGPT on your plan by default; your plan limits apply. Choose paid engines explicitly for each ask. They share the spending approval evenly, rounded down to the cent. SurfacedBy checks its current quote against that engine's share before submitting work. DataForSEO uses your saved per-request estimate, so its actual charge can differ; OpenGEO records the reported cost and stops further work if it exceeds the limit. DeepSeek starts only when its most expensive possible answer fits its share, and records an estimate from its reported usage. Provider charges and refunds apply. After an ask, selection returns to ChatGPT on your plan.

If a response is lost, retry with the same settings. OpenGEO keeps the original request key and returns the same Ask instead of starting it twice. A request key cannot add engines or raise an existing Ask's approval. One-off answers remain in Ask history even after you track the question; future visibility checks collect their own answers.

OpenGEO never silently substitutes a paid provider. If access expires or a quota is reached, affected work pauses with its progress preserved. A reset time is shown only when the service supplies one.

A run budget controls whether another provider request starts. It cannot undo a charge already incurred. Completed paid work is retained. For managed operations, an approved maximum can be held until the final receipt confirms the charge and release of unused credit.

If a response is lost, OpenGEO checks the saved request identity before retrying. An uncertain paid request pauses for review rather than purchasing a replacement. Cancellation stops further local work and requests remote cancellation when supported; only a confirmed refund reduces the receipt. An unconfirmed cancellation remains unresolved.

Connected services receive the task inputs needed for the operation you request. Read [privacy and data handling](privacy.md) and each provider's own data policy before sending sensitive material.
