# How OpenGEO measures visibility

A visibility check is a sample of AI answers to questions you chose. OpenGEO keeps the answers and citations so you can inspect what each number means. It does not promise rankings or prove that a website edit caused a later change.

## Mentions and citations

| Metric | Meaning |
| --- | --- |
| Mention rate | Percentage of collected answers that mention your configured brand name or aliases |
| Citation rate | Percentage of collected answers that link to your website or one of its subdomains |
| Source coverage | Percentage of collected answers citing a particular domain or page |

For example, if 8 of 10 collected answers mention your brand, the mention rate is 80%. This example explains the calculation; it is not a product result.

**Missing answers stay missing.** If you request 10 answers and collect 8, the requested and missing counts stay visible. The two missing answers are not converted into answers with zero mentions.

Local matching uses brand names and aliases with Unicode word boundaries. A citation must link to the configured host or a subdomain. Generic brand names can produce ambiguous matches, so read the answer. This matching is not an entity classifier. SurfacedBy full checks retain the provider's canonical recognition and proprietary scores, with separate labels.

## Where answers come from

- **ChatGPT:** Responses API answers. Web search depends on the chosen model and account permissions.
- **OpenRouter:** model-only API answers, without a search plugin.
- **DataForSEO and supported SurfacedBy checks:** consumer-interface answers, labelled with their collection surface.

API answers can differ from a logged-in consumer chat app. Each observation records its prompt, provider, platform, returned model identity, locale, collection time, answer, citations and retrieval mode.

Citations come from provider annotations, not guessed links in answer text. Requesting search does not prove it ran: ChatGPT confirms search only when the final response contains a completed `web_search_call`. The interface marks other cases, including older records without that flag, as unconfirmed. The searches a completed call reports (its `action.query`) are saved with the answer as given, up to 20 per answer, and older records simply have none. See the [web search response contract](https://developers.openai.com/api/docs/guides/tools-web-search).

Supported SurfacedBy selected-question checks preserve the approved question IDs, locale, original answers, citations and collection dates, then use local presence matching. They do not automatically purchase analysis. Failed or cancelled checks can retain answers already collected; full checks keep their separate pricing and analysis workflow.

## Compare checks fairly

Use the same project identity, aliases, question list, locale, provider, platform, model and retrieval mode. OpenGEO stores a configuration digest for that scope, including confirmed-search status. Model aliases can change upstream, so the returned model identity is also retained.

The history chart uses actual check timestamps. Incomplete checks create gaps; one check is a point rather than a trend. The underlying counts and timestamps remain available in an accessible table.

Question coverage uses the saved request plan. Editing today's questions does not rewrite an earlier check. Older imports without a request plan, or jobs with a different request profile, show collected answers without inventing per-question requested counts.

Even comparable checks are samples. They can show a change worth investigating, but cannot isolate its cause.

## Campaigns

A campaign groups some of a brand's questions toward one goal, with optional target pages and a choice of the brand's competitors. A question can belong to several campaigns and still counts once in the brand's totals.

A campaign reads every check that asked all of its questions: a check of the whole question list, or a check limited to the campaign. Its rates use only the answers to its own questions. Its trend compares checks with the same answer settings and the same campaign questions, so adding or removing a campaign question starts a new comparison.

A check limited to a campaign asks only that campaign's questions, so providers collect and price only those answers. Its answers count in the campaign. The brand's totals stay on the latest check of every question, and the brand's history shows the campaign check as a gap named after the campaign rather than as a reading.

A target page is cited when an answer links to it. Each answer counts once per page. Fragments, a trailing slash, a leading `www.` and `utm_` tracking parameters (ChatGPT adds `utm_source=openai` to the links it cites) are ignored; any other difference in path or query is a different page.

## Read source coverage

Each answer counts once for a domain or page, even if it cites it repeatedly. Page fragments are combined; different paths and queries remain distinct. A source's coverage cannot exceed 100%, but coverage across sources can add up to more than 100% because one answer may cite several sites. Unsafe or credential-bearing links are excluded from source tables.

## Audits and suggested questions

Audits preserve fetched page text and technical facts. Sitemaps help discover pages within the crawl budget and robots policy; a sitemap URL is not evidence until the page is fetched. Findings such as missing metadata or noindex describe page facts, not a proven cause of AI invisibility.

Website-grounded questions reference readable page records and are reviewed before tracking. Thin or unreadable evidence can yield no suggestions. ChatGPT and OpenRouter use separate passes to understand the website, draft audience questions and review their relevance. Offering quotations must match the page text and support the current offering in context. Questions should reflect the audience's needs rather than repeat specifications or assume a diagnosis.

These checks do not establish search demand. Your expertise can clarify scope but does not replace page evidence. Each pass uses the same connection and approved spending ceiling. SurfacedBy suggestions may read selected public pages and the primary page directly, returning dated sources; they can differ from suggestions based on a saved local audit. You review either set before selecting questions.

## Competitors and opportunities

The first ChatGPT check can suggest competitors named in its answers with a matching website citation in the same answer. This can miss an uncited competitor, but avoids guessing domains. You choose which sites enter the comparison. Unconfirmed websites remain under **To review**, separate from confirmed competitors and references. A reviewed parent website covers its subdomains.

When supported, SurfacedBy role review reads selected saved answers and cited websites to distinguish competing offerings from references. It is analysis of supplied evidence, not a fresh measurement or an authority score. Supported request sizes and availability are checked before approval; partial or unrelated results are not published.

Recommendations distinguish existing-page edits, new resources and website changes. SurfacedBy reviews business scope and website roles before proposing and independently checking improvements. Fresh page excerpts keep their own read dates and travel with credential-free backups and imports. Selected excerpts are not a complete site inventory: check existing coverage before creating a resource. Empty reviewed sets are valid; unsupported or incomplete results publish no recommendations.

Original answers keep their dates and text. Changing an opportunity's progress does not change its source observation. Managed findings retain their originating scan and evidence period; older domain findings are not presented as new-scan evidence.

## Drafts and revisions

Content separates research, briefing, drafting, verification and editing, followed by a separate review of the edited article. Sources, unknowns, user expertise and unresolved findings remain inspectable. Unknown evidence IDs or unrecognized citation links stop the workflow.

Manual edits mark the final review as covering an earlier version. AI revisions snapshot the saved draft and reuse its original sources, producing a separate draft with new research, brief and verification. Save manual changes before requesting a revision. Automated checks support your review; they do not replace a person checking factual claims.

## Cost records

Receipts distinguish reported spend from conservative estimates retained when a provider omits cost. A held estimate is not a confirmed charge. Managed suggestions and drafts require price review; approved funds remain held until a receipt confirms the charge and release of unused credit.

A lost acknowledgement is checked using the saved request identity before any retry. Missing confirmation pauses the run rather than purchasing a replacement. Saved results can remain collectible when new generation is unavailable. Cancellation requests and confirmed refunds stay distinct from unresolved outcomes. See [connections and costs](connections.md#spending-pauses-and-cancellation).
