# Evidence methodology

When the SurfacedBy connection supports question suggestions, it reads selected public pages and the primary website page, then returns reviewed rows with source links and timestamps. Its result can differ from suggestions based on your saved local audit. Neither path selects questions for a visibility check without your review.

Observations are immutable records. Audits retain fetched page text and technical facts; visibility checks retain answer text and citation annotations. Updating an opportunity's status changes its progress, not its originating observation. Draft changes keep prior revisions.

During setup, sitemaps help discover public pages within the audit's crawl limit and robots policy. Sitemap URLs are not factual evidence: the page must still be fetched. Website-grounded question suggestions reference readable page records, exclude brand-led prompts and are reviewed before becoming tracked questions. Thin or unreadable evidence can produce no suggestions.

ChatGPT and OpenRouter suggestions use three separate AI passes: establish the website's purpose and current offerings or resources, draft audience questions, then independently review relevance and wording. Offering quotations must match the supplied page text; their attribution, context and current availability determine what they support. Questions start from the audience's knowledge, observable need or goal, rather than copying product specifications or assuming a diagnosis. These checks reduce errors; they do not prove search demand or guarantee that every suggestion fits the website. Review the rows before checking them. Your saved expertise can clarify scope; it does not substitute for page evidence. Each pass uses the same connection and approved spending ceiling.

The first ChatGPT check can suggest competitors from its collected answers. A candidate must be named in an answer and have a matching website citation in that answer. This conservative rule can miss competitors with no cited website; it avoids guessing domains or treating every source as a competitor. Candidates are added to comparisons only after user selection. Cited websites with an unconfirmed role appear under To review, separately from confirmed competitors and references. A reviewed parent website covers citations from its subdomains.

When SurfacedBy supports website role review, it receives your selected check's saved answers and citation links, reads the tracked website and cited websites, and returns competing offerings and references with their original answer IDs. This is analysis of client-supplied evidence, not a new visibility measurement or an authority score. The comparison list changes only when you select websites. Availability and supported request sizes are checked before approval; a partial or unrelated result is not published.

Local presence matching uses configured brand names, aliases and the website with Unicode word boundaries. A citation must link to the configured host or a subdomain. Literal matching can confuse generic names; review the answer when recognition is ambiguous. It is not an entity classifier.

When SurfacedBy supports recommendations from saved answers, it reviews business scope and cited website roles before proposing and independently checking improvements. Existing-page edits, new resources and website changes remain distinct. Fresh owned-page excerpts have their own read dates and are stored separately from local audits. They travel with credential-free backups and project imports. Original answers retain their original dates and text. Selected pages are not a complete site inventory; check existing coverage before creating a new resource. An empty reviewed set is valid, and unsupported or incomplete results publish no recommendations.

Rates use collected answers as their denominator. The requested count and missing count remain visible. A failed request is never converted into an answer with zero mentions. Console full checks use the provider's canonical recognition rather than local reinterpretation.

When SurfacedBy advertises selected-question checks for the chosen platform, OpenGEO requests fresh answers for the exact approved question list and locale. It preserves original question IDs, citations and collection dates, then uses the same local presence matching as direct connections. These scraped observations retain their `consumer_interface` surface, distinct from API answers. Missing responses remain missing; failed or cancelled checks can retain answers already collected. This smaller check does not automatically purchase analysis. Full checks keep their existing price and analysis workflow.

Source coverage counts each collected answer once per domain or page, regardless of repeated citation annotations. Page fragments are combined; distinct paths and queries remain separate. Each source rate is bounded by 100%; rates across sources can sum to more than 100% because an answer can cite multiple sources. Unsafe or credential-bearing links are excluded from source tables.

Question coverage uses the saved request plan. Missing answers have no mention or citation rate. Older imports without that plan, and provider jobs with a different total request profile, show collected answers without inventing a per-question requested count. Editing today's questions does not rewrite the saved check.

History plots actual check timestamps in the current comparison scope. Incomplete checks create gaps, and a single check is a point rather than a fabricated trend. An accessible data table retains the counts and timestamps behind the chart.

Comparability requires the same project identity, aliases, prompt list, locale, provider, platform and selected model. A configuration digest records that scope. Even comparable runs are samples, not proof of a causal effect. Provider model aliases can change versions; observations record returned model identities.

ChatGPT plan checks call the supported Responses API. Optional web search depends on the selected model and account/workspace permission. OpenRouter answer checks are model-only API calls without search plugins. Retrieval mode is stored with observations and participates in recheck comparison. Neither path reproduces a logged-in consumer chat interface. Citations come from provider annotations, never from guessed links in answer text.

Requesting web search does not prove it ran. ChatGPT observations record the requested mode separately from `webSearchConfirmed`, which requires a completed `web_search_call` in the final response. Absent confirmation, the interface says use is unconfirmed. Older observations without that flag also remain unconfirmed. Recheck comparisons include confirmed-search status. See [OpenAI's web search output contract](https://developers.openai.com/api/docs/guides/tools-web-search).

Deterministic audits describe facts such as missing metadata, heading structure or noindex. They do not claim that a missing tag causes AI invisibility. Recommendations are interpretations anchored to page or observation identifiers.

Research separates source-supported claims from unknowns and user-supplied expertise. Drafts and verification notes remain inspectable. The edited article receives a separate final review; unresolved claims stay visible with the draft. Manual edits mark that review as covering an earlier version. Unknown evidence identifiers and unrecognized citation links stop the content workflow. Human review remains required.

AI revisions snapshot the saved draft and reuse its original source records. They create a separate draft with its own research, brief and final verification; the original is preserved. Save manual changes before requesting a revision.

Cost receipts distinguish reported spend from conservative estimates held when a provider omits its cost. A held estimate is not a claim about the eventual charge. Cancellation stops local work and requests remote Console cancellation when a submitted check is known. A confirmed pending-check refund reduces the receipt; unconfirmed cancellation remains visibly unresolved.

Console managed suggestions and drafts require a price review before purchase. The approved maximum is held until a receipt confirms the charge and return of unused credits. A lost acknowledgement is looked up by the saved request identity before any retry. Missing confirmation pauses the run; it does not purchase a replacement. Saved results remain collectible when new generation is unavailable.

Console findings identify their originating scan and evidence period. Its score is proprietary and distinct from local mention and citation rates. Older domain findings are not represented as new-scan evidence.
