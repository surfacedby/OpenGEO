# Get started with OpenGEO

Find out whether AI answers mention your brand, which sources they cite, and what to improve next. Connect an AI service to begin, or try a website health scan without an account.

## 1. Install and add your website

[Download the app for Windows or Mac](https://github.com/surfacedby/OpenGEO/releases), then follow the [installation guide](distribution.md). Source and Docker users can open their local instance at <http://localhost:4318>.

In setup, enter your website and brand name, then connect an eligible service. OpenGEO can read your public pages and suggest relevant prompts. Review the suggestions and choose what to track. Paid services require a spending limit and any applicable price approval. Review the optional usage-sharing choice before finishing setup.

You can also choose website health without an AI connection. OpenGEO follows robots.txt when reading public pages and sitemaps. A partial crawl is shown as partial coverage.

## 2. Run a visibility check

Open **Prompts** to edit your tracked questions or discover more suggestions. These should be questions your customers ask when looking for a business like yours. Start a visibility check from **Scans** or **Visibility**. If the brand has no prompts yet, OpenGEO takes you to prompt selection first.

Normal visibility checks search the web. Your connected model and account must support web search; OpenGEO does not silently substitute model-only answers. Review the model, language and spending approval before starting.

In **Visibility**, inspect mention and citation rates. Use **Responses** to read full answers and **Sources** to see the pages cited. A failed check is a missing observation; it does not count as an answer that failed to mention you.

## 3. Check your website's health

In **Scans**, choose **Website health**. Review the pages fetched and findings for titles, descriptions, headings, canonical URLs, indexing instructions and structured data. A missing description is a concrete finding, not proof that an AI service is ignoring your business. This scan is optional and does not block visibility checks.

The [connection guide](connections.md) explains service choices, costs and what each check measures.

## Manage brands and the app

**Brand** contains the selected website's name, other names, language, competitors and business context. You can export a backup before deleting a brand; deletion removes its local work, not your other brands or shared connections.

**Settings** is app-wide. Connections, schedules, data preferences and updates apply across brands and remain available even before you add a website.

## 4. Decide what to work on

Review evidence-supported competitors before adding them to a comparison. In **Opportunities**, look at suggested existing-page updates, new resources and website changes. Read the supporting answers and pages before deciding what belongs on your site.

In **Content**, turn a useful idea into a brief and draft. Add your own expertise, check factual claims and review the sources. OpenGEO retains the draft's research and review notes; you decide whether to publish it.

Save manual edits before requesting an AI revision. Revisions preserve the original draft. After a restart, unsaved local edits can be restored, exported or discarded. Save recovered edits before exporting a project.

## 5. Recheck and keep a backup

After updating your website, recheck the same questions, model and locale. AI answers vary, so a change is useful evidence rather than proof that your edit caused it. See [how comparisons work](methodology.md#compare-checks-fairly).

Use Settings to export a backup. Project exports contain saved work and evidence, but no provider credentials. Keep backups private because they can still contain sensitive research.

Daily and weekly schedules survive restarts. The desktop app must remain running for scheduled work; closing its window leaves it in the tray, while **Quit** stops it. A Docker instance can keep running on your host. Selected paid services can charge for scheduled calls, so set a spending ceiling you are comfortable with.

## If something stops

- **A connection expires or reaches its limit:** affected work pauses. Reconnect or wait for the service's limit to reset.
- **A paid request has an uncertain result:** check the provider account before approving a retry. OpenGEO does not automatically replay it or switch providers.
- **An audit cannot fetch a page:** inspect the recorded fetch result and your site's access rules. Unread pages are not treated as successfully audited.
- **The installer is blocked:** follow the platform-specific [installation instructions](distribution.md). Do not disable your computer's security protections globally.

For a reproducible bug, [open an issue](https://github.com/surfacedby/OpenGEO/issues) with your app version, operating system and steps to reproduce it. Remove credentials and private project data first.
