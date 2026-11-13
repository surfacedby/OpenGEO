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

- **ChatGPT:** answers with web search requested, subject to your account permissions.
- **OpenRouter:** answers without live web search.
- **DataForSEO:** answers with web search requested.
- **DeepSeek:** answers with web search available. Only links also returned by its search are counted as citations; other retrieved pages remain separate.
- **SurfacedBy:** answers from the engines currently available for the requested check.

Results can differ from a conversation in a chat app. Each public answer keeps its question, engine, language, collection time and citations. Internal model identifiers and collection details stay out of result screens, public response metadata and project exports. Direct connections still let you choose your own answer settings.

Citations come from returned source evidence, not guessed links in answer text. Requesting search does not prove it ran. The AI searches tab shows only searches reported with the answer, up to 20 per answer. Older answers without that evidence show no reported searches; OpenGEO does not invent them.

SurfacedBy visibility scans include analysis and recommendations. Ask uses selected-question measurement: it preserves the approved question, language, original answer, citations and collection date, then uses local presence matching. It does not buy full analysis. Older saved visibility runs that used selected-question measurement keep that original workflow when resumed; they are never silently replaced with a full scan. Failed or cancelled checks can retain answers already collected.

## Compare checks fairly

In a response, **Retrieved without a citation** lists additional pages the engine
reported finding. Those pages earn no citation credit. For Perplexity checks with
a numbered source list, OpenGEO matches references such as `[3]` to the original
list before filtering duplicate links. When no reference matches a position, the
answer keeps its reported source annotations and the split is unavailable.

Use the same brand identity, aliases, question list, language, connection and answer settings. OpenGEO keeps a private comparison record for that scope, including available search evidence. A change of settings starts a separate comparison. Exported history keeps its comparison digest; imported answers without private settings are not assumed to match a new check.

The history chart uses actual check timestamps. Incomplete checks create gaps; one check is a point rather than a trend. The underlying counts and timestamps remain available in an accessible table.

Question coverage uses the saved request plan. Editing today's questions does not rewrite an earlier check. Older imports without a request plan, or jobs with a different request profile, show collected answers without inventing per-question requested counts.

Even comparable checks are samples. They can show a change worth investigating, but cannot isolate its cause.

## Topics

A topic groups some of a brand's questions toward one goal, with optional target pages and a choice of the brand's competitors. A question can belong to several topics and still counts once in the brand's totals.

A topic reads every check that asked all of its questions: a check of the whole question list, or a check limited to the topic. Its rates use only the answers to its own questions. Its trend compares checks with the same answer settings and the same topic questions, so adding or removing a topic question starts a new comparison.

A check limited to a topic asks only that topic's questions, so providers collect and price only those answers. Its answers count in the topic. The brand's totals stay on the latest check of every question, and the brand's history shows the topic check as a gap named after the topic rather than as a reading.

A target page is cited when an answer links to it. Each answer counts once per page. Fragments, a trailing slash, a leading `www.` and `utm_` tracking parameters (ChatGPT adds `utm_source=openai` to the links it cites) are ignored; any other difference in path or query is a different page.

## Asks

An ask sends one question, typed as a person would search it, to the engines you choose. Each answer keeps its engine, language, date, reported searches and citations. It is scored with the same mention and citation rules as a check.

**One-off answers stay separate from visibility measurements.** They do not enter Responses, Sources, rates, trends, findings or exports. An Ask uses the engines chosen for that question, rather than the consistent question list and settings needed to compare checks. The screen shows earlier answers to the same tracked question beside it so a single reading is not mistaken for a trend.

An engine that returns no answer is left out of every count rather than read as "not mentioned". Answers from different surfaces are shown side by side and never combined into one score. Tracking an ask adds its question to the website's questions, and to a topic if you choose one; it counts from the next check, and the ask's own answers stay where they are.

## Read source coverage

Each answer counts once for a domain or page, even if it cites it repeatedly. Page fragments are combined; different paths and queries remain distinct. A source's coverage cannot exceed 100%, but coverage across sources can add up to more than 100% because one answer may cite several sites. Unsafe or credential-bearing links are excluded from source tables.

Website comparisons use the same selected check for both websites. Their percentages count citations, not market share or recommendations. The comparison includes answers citing both sites, one site, or neither. Its prompt and platform views retain their own answer counts; a gap alone is not a reason to create new content. A reference website is not automatically a competitor.

## Audits and suggested questions

Audits preserve fetched page text and technical facts. Sitemaps help discover pages within the crawl budget and robots policy; a sitemap URL is not evidence until the page is fetched. Findings such as missing metadata or noindex describe page facts, not a proven cause of AI invisibility.

During onboarding, the optional background website check discovers up to 10,000 public pages. It saves progress as pages arrive, works in small paced batches while OpenGEO is open, and yields between batches to other queued work. It resumes after an app restart; cancellation stays cancelled. It uses your internet connection but makes no AI calls. Pages excluded from search remain visible in their own group, without advice to make private content public.

Existing brands can start page discovery from Scans and choose a limit of 1,000, 10,000 or 100,000 pages. Stop keeps the pages already checked; Resume explicitly continues that saved crawl. Only one background discovery can be active or paused for a brand. A completed crawl can be run again to check the website afresh. This does not schedule recurring checks or restart stopped work automatically.

When a page, sitemap or robots policy responds with HTTP 429 or 503, the crawler preserves its position instead of treating the error page as website content. Background discovery waits at least 30 seconds, increases the delay on repeated responses and honors a valid Retry-After header. After three automatic retries at the same URL, or a requested wait longer than a day, it pauses for review. Manual checks pause immediately. Website checks share the saved wait for that host (including its www variant), even if the first check is cancelled or the app restarts. Other websites can continue. Waiting on another check does not consume a retry.

Page text and headings come from the declared main content, a single article, or the visible body when neither exists. Navigation, dialogs, forms, hidden elements and other interface text are excluded; useful article headers, FAQ answers and service cards remain. Navigation links still help discover pages. This is HTML evidence, not a claim that every visual or interactive element has been understood. Previously saved page records keep the content collected at their original check.

Website-grounded questions reference readable page records and are reviewed before tracking. Thin or unreadable evidence can yield no suggestions. ChatGPT and OpenRouter use separate passes to understand the website, draft audience questions and review their relevance. Offering quotations must match the page text and support the current offering in context. Questions should reflect the audience's needs rather than repeat specifications or assume a diagnosis.

These checks do not establish search demand. Your expertise can clarify scope but does not replace page evidence. Each pass uses the same connection and approved spending ceiling. SurfacedBy suggestions may read selected public pages and the primary page directly, returning dated sources; they can differ from suggestions based on a saved local audit. You review either set before selecting questions.

## Competitors and opportunities

The first ChatGPT check can suggest competitors named in its answers with a matching website citation in the same answer. This can miss an uncited competitor, but avoids guessing domains. You choose which sites enter the comparison. Unconfirmed websites remain under **To review**, separate from confirmed competitors and references. A reviewed parent website covers its subdomains.

Checks started with ChatGPT or OpenRouter also prepare recommendations from the saved answers and readable public pages. Topic checks use only their frozen questions and answers; their recommendations appear in the Topic's Opportunities tab as well as the general improvement list. A newer Topic check replaces only that Topic's unstarted advice, while accepted actions retain their evidence. If no website check is available, OpenGEO reads up to six pages first. Answer collection and recommendations share the same approved budget; a pause keeps collected answers available. Other connections retain their separate analysis controls.

Local competitor review reads complete saved answers and their citation links in durable batches. A single answer that exceeds the chosen model's capacity pauses review rather than silently losing its ending. Recommendations exclude failed page responses, sign-in pages and pages marked noindex. These exclusions are still visible in Pages.

New local reviews can also identify a website as an organization, product, publisher, directory, marketplace, platform or community. This category is separate from its competitor or reference role. The saved quote must occur in a supporting answer or that website's citation title. Missing or conflicting category evidence leaves the website unclassified. These are interpretations of saved answers, not independently verified business profiles; open the comparison to inspect the quoted evidence. Older reviews and providers without category results stay unclassified.

Structured-data types are publisher declarations, not proof of eligibility for search features. The local reader resolves supported Schema.org contexts without fetching remote context documents. It inspects up to 16 blocks within 64 KB, with limits on nesting and entities; page details disclose malformed, unresolved or omitted declarations.

When supported, SurfacedBy role review reads selected saved answers and cited websites to distinguish competing offerings from references. It is analysis of supplied evidence, not a fresh measurement or an authority score. Supported request sizes and availability are checked before approval; partial or unrelated results are not published.

Recommendations distinguish existing-page edits, new resources and website changes. SurfacedBy reviews business scope and website roles before proposing and independently checking improvements. Fresh page excerpts keep their own read dates and travel with credential-free backups and imports. Selected excerpts are not a complete site inventory: check existing coverage before creating a resource. Empty reviewed sets are valid; unsupported or incomplete results publish no recommendations.

Original answers keep their dates and text. Changing an opportunity's progress does not change its source observation. Managed findings retain their originating scan and evidence period; older domain findings are not presented as new-scan evidence.

## Drafts and revisions

Content separates research, briefing, drafting, verification and editing, followed by a separate review of the edited article. Sources, unknowns, user expertise and unresolved findings remain inspectable. Unknown evidence IDs or unrecognized citation links stop the workflow.

Manual edits mark the final review as covering an earlier version. AI revisions snapshot the saved draft and reuse its original sources, producing a separate draft with new research, brief and verification. Save manual changes before requesting a revision. Automated checks support your review; they do not replace a person checking factual claims.

## Cost records

Receipts distinguish reported spend from conservative estimates retained when a provider omits cost. A held estimate is not a confirmed charge. Managed suggestions and drafts require price review; approved funds remain held until a receipt confirms the charge and release of unused credit.

A lost acknowledgement is checked using the saved request identity before any retry. Missing confirmation pauses the run rather than purchasing a replacement. Saved results can remain collectible when new generation is unavailable. Cancellation requests and confirmed refunds stay distinct from unresolved outcomes. See [connections and costs](connections.md#spending-pauses-and-cancellation).
