# Privacy, budgets and operation

Projects and evidence reside in SQLite on your installation. Encrypted provider credentials reside in a separate vault. The local session file authorizes CLI/MCP access and must stay private. Provider status endpoints never return credentials.

No telemetry or hosted authentication is required. Crawling requests public pages. ChatGPT and OpenRouter receive instructions, source excerpts and project context for selected content tasks. DataForSEO receives prompts, models and supported locale parameters. Console receives domain configuration and explicitly requested tasks. Review each provider's own data policies.

## Optional usage sharing

Usage sharing is **preselected during new setup**. You can uncheck the optional checkbox before finishing setup, or change it anytime in Settings under Data & privacy. No activity is sent from an unsaved preference. Finishing setup saves the displayed choice. Existing saved choices are never overridden; existing workspaces without a saved preference stay off. Sharing is independent of provider connections and does not affect features or output quality.

If enabled, OpenGEO sends a closed set of activity names, UTC dates, the providers used for successful workflows, app version, distribution type and operating system to SurfacedBy. Random event identifiers prevent retry duplicates; a random installation identifier counts returning installations. The receiver stores a hash of the installation identifier and reports aggregate counts in its private admin area. These are participating installations, not identified people or paying customers.

Websites, prompts, answers, content, citations, project identifiers, models, account details, credentials and free-form properties are excluded. Project exports and ordinary backups exclude the usage preference, installation identifier and pending usage records. No activity from before sharing was enabled is backfilled; imported historical work does not count as a new completion.

Sending is limited to 40 events per installation per day, in batches, with at most 256 queued records and seven days of local retry history. Failure never interrupts work. Turning sharing off aborts the active request and removes queued records and the local identifier. Starting again creates a new identifier. A request already accepted by the receiver cannot be recalled by aborting it.

The receiver keeps a rolling 90 calendar days of activity with hourly expiry, including when collection is disabled. Temporary scheduler outages can delay removal until recovery. Short-lived, daily salted network-address hashes are used only for abuse counters, not the usage ledger or admin reports; these expire within a day. The ingest endpoint is excluded from request-address access logs and error/transaction payload capture. Hosting networks may observe connection metadata when handling HTTPS traffic. Previously accepted records expire with retention; turning sharing off does not erase previously accepted aggregates immediately.

Website icons load through the local backend from websites already in your project or citation evidence. If a direct icon is unavailable, cached icon lookup is enabled by default: Google's icon service receives the individual public hostname and can observe this installation's network address. Requests contain no provider credentials, project identifiers, prompts, content or referring page. Turn this fallback off in Settings under Data & privacy; disabling it aborts active cache requests and stops subsequent lookups. A request already received by Google cannot be recalled. Images already displayed or cached by the browser can remain visible until refresh. The fixed service is optional and has no guaranteed availability. Only bounded raster icons are displayed, with a local monogram fallback when unavailable. Icons are cached in memory; offline operation does not depend on them.

A run budget controls whether additional provider requests start. DataForSEO has no per-request USD ceiling, so a request can cost more than its estimate. Configure a conservative request estimate and use provider-side spending controls. OpenRouter calls have bounded output and catalog-based estimates; model rates may change. Console full checks use the server's credit preview before submission.

Completed paid work is retained. An interrupted request with uncertain completion is never automatically replayed. Review the provider account before approving a retry. No provider is silently substituted. Cancellation stops additional work but cannot undo a completed provider charge.

Schedules use a selected time zone and monthly spending ceiling. Outstanding scheduled jobs reserve their approved budgets. Desktop schedules require the app to remain running; closing the window leaves it in the tray. Quitting stops execution. Docker supports continuous execution on your host.

Ordinary backups contain project exports, not vaults, OAuth tokens or encryption secrets. Restore project exports through the preview/import interface. Imports create independent projects, preserve original collection timestamps and never enqueue historical paid work. Keep sensitive evidence backups private even though they contain no provider credentials.
