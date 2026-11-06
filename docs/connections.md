# Connections and costs

Start with the connection you already have. You can also use local audits and project storage without connecting any service.

| Connection | What it adds | What you need |
| --- | --- | --- |
| ChatGPT | Answer checks, analysis, question suggestions and content | An eligible subscription and the required account permissions. No separate API key; plan limits apply. |
| OpenRouter | Answer checks, analysis and content with a choice of models | An OpenRouter account with available credit. Connect with OAuth or an existing key. Model usage is billed by OpenRouter. |
| DataForSEO + OpenRouter | Answer collection, followed by AI analysis and content | Both accounts for the full workflow. Each provider charges for its usage. |
| SurfacedBy | Managed checks and insights; suggestions, reviews and drafts when supported | An account with credit and a server that supports the requested operation. Availability is checked before it is offered. |

![OpenGEO connection choices, with no accounts connected](../assets/provider-preview.webp)

Open **Settings > Connections** to connect a service. Credentials are encrypted on your installation and excluded from project exports.

## ChatGPT

OpenGEO implements the [published subscription-sharing protocol](https://developers.openai.com/siwc/token-sharing-open-source/) independently. Eligibility, preview access and permissions can change; a ChatGPT account does not automatically guarantee access. The example DevKit is not bundled.

Checks request web search through your connection. Search availability depends on your account and chosen answer settings. Results are samples and can differ from a conversation you start on the ChatGPT website or app.

When self-hosting in local mode, use a [local port forward](distribution.md#remote-access) so the sign-in browser can reach the callback on the OpenGEO host. Optional [private-network mode](remote-access.md#connect-ai-services) also supports pasting the exact one-time loopback redirect URL into the authenticated workspace. Do not expose an unprotected backend or share that URL to make sign-in work.

## OpenRouter

Choose a model after connecting. This connection answers without live web search. Source links must come from the returned evidence; an answer is not proof of a current web search.

OpenRouter bills for the selected model. OpenGEO bounds output and estimates cost using model rates; rates can change. Review the approved ceiling before running work.

## DataForSEO with OpenRouter

DataForSEO collects answers with web search requested; OpenRouter handles analysis and content. Results can differ from a conversation in a chat app. OpenGEO keeps the original settings privately so trends only compare matching checks.

A direct DataForSEO request has no per-request dollar cap. Its actual charge can exceed an estimate. Use conservative estimates in OpenGEO and spending controls in the provider account.

## SurfacedBy

SurfacedBy is optional. You can keep using local projects and exports without a managed account.

OpenGEO checks the connected server's capabilities before offering managed work. A visibility scan collects answers and waits for SurfacedBy's analysis and recommendations. Ask requests one answer per selected engine without buying a full scan. Suggestions and drafts require a separate price review when available.

Engine availability comes from your connected account. Full checks and single-question checks may support different engines. Ask shows which engines can answer one question, and checks availability again before starting paid work. An unavailable single-question check is never replaced with a full scan.

**Managed features are experimental in this beta.** The desktop release does not certify live supplier quality, billing and refund recovery, worker activation, usage delivery or historical imports. Availability depends on the connected service; see the [beta notes](releases/v0.1.0-beta.4.md).

## Spending, pauses and cancellation

Ask uses your ChatGPT plan by default. Choose paid engines for each question. One spending limit covers them together. For example, two answers quoted at $0.10 and $0.30 fit a $0.40 limit.

For a website already connected to SurfacedBy, OpenGEO checks each selected engine's quote before starting the group. If a quote fails, refresh prices, edit the question or deselect that engine. For a website that still needs to be registered, SurfacedBy checks the price after registration and before buying the answer. Each engine stays within its allocated approval for SurfacedBy work.

Your direct DataForSEO connection uses your saved per-request estimate. Its actual charge can differ. OpenGEO records the reported cost and stops further work if it exceeds the limit. After an ask, selection returns to your ChatGPT plan.

SurfacedBy prices come from the connected service. When it supplies a single-answer price menu, Ask shows each engine's maximum price before you type. Estimates are free. After you enter your question, Ask shows the current quote's dollar amount and expiry, refreshes expired quotes, and lets you retry an unavailable price. Execution checks a current quote against your approved limit and reserves only that quoted maximum. A $0.10 quote under a $1 limit holds $0.10, leaving the rest of your credit available. Unused reserved credits are returned when the final charge is confirmed. The original valuation and reservation stay with the run for its charge and refund; an app update or later price change does not rewrite its receipt.

If a response is lost, retry with the same settings. OpenGEO keeps the original request key and returns the same Ask instead of starting it twice. A request key cannot add engines or raise an existing Ask's approval. One-off answers remain in Ask history even after you track the question; future visibility checks collect their own answers.

OpenGEO never silently substitutes a paid provider. If access expires or a quota is reached, affected work pauses with its progress preserved. A reset time is shown only when the service supplies one.

A run budget controls whether another provider request starts. It cannot undo a charge already incurred. Completed paid work is retained. For managed operations, an approved maximum can be held until the final receipt confirms the charge and release of unused credit.

If a response is lost, OpenGEO checks the saved request identity before retrying. An uncertain paid request pauses for review rather than purchasing a replacement. Cancellation stops further local work and requests remote cancellation when supported; only a confirmed refund reduces the receipt. An unconfirmed cancellation remains unresolved.

Connected services receive the task inputs needed for the operation you request. Read [privacy and data handling](privacy.md) and each provider's own data policy before sending sensitive material.
