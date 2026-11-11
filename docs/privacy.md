# Privacy and your data

OpenGEO stores your projects and evidence on your installation. Connecting an AI service sends that service the inputs needed for the work you request. You can use local audits and storage without a hosted account or usage sharing.

## What stays on your installation

- Projects, fetched page evidence, collected answers, drafts and workflow progress are stored in SQLite.
- Provider credentials are encrypted in a separate vault. Status endpoints do not return them.
- The local session file authorizes CLI and MCP access. Keep it private.
- Project exports and ordinary backups contain saved project work, but no vault, OAuth token or encryption secret.

Backups can still contain sensitive evidence. Keep them private. Restore through the preview/import interface: imports create independent projects, keep the original collection timestamps and do not replay historical paid work.

## What connected services receive

| Service | Data sent for work you request |
| --- | --- |
| Your website | Requests for public pages and sitemaps during an audit |
| ChatGPT or OpenRouter | Prompts, instructions, source excerpts and project context needed for the selected operation |
| DataForSEO | Prompts, models and supported locale parameters |
| DeepSeek | Each question in a visibility check or Ask, the answer instructions with the project locale, the searches the model chooses and the results returned to it. No website pages, saved answers or business notes. DeepSeek is a company based in China. |
| SurfacedBy API | Domain configuration and requested tasks. Evidence-based role reviews and recommendations also send selected saved answers, their IDs and timestamps, citation links and selected owned page URLs. |

SurfacedBy may read those public pages and return dated excerpts. Each provider has its own data policy; check it before submitting sensitive material.

## Optional usage sharing

**Usage sharing is preselected during new setup.** Uncheck it before finishing setup, or change it in **Settings > Data & privacy**. It does not affect features or output quality and is separate from provider connections.

Nothing is sent from an unsaved preference. Finishing setup saves the choice shown. Existing saved choices are preserved; existing workspaces without a saved choice stay off.

### Fields sent when enabled

OpenGEO sends a fixed set of activity names, UTC dates, providers used for successful workflows, app version, distribution type and operating system to SurfacedBy. Random event IDs prevent duplicate retries. A random installation ID counts returning installations; the receiver stores its hash and reports aggregate counts in a private admin area. These counts represent participating installations, not identified people or paying customers.

**Excluded:** websites, prompts, answers, content, citations, project IDs, models, account details, credentials and free-form properties.

Exports and ordinary backups also exclude the sharing preference, installation ID and pending usage records. Activity from before sharing was enabled is not backfilled. Imported historical work does not count as a new completion.

### Limits, retention and turning it off

- At most 40 events are sent per installation per day, in batches.
- The local queue holds at most 256 records and seven days of retry history. Sending failures do not interrupt your work.
- Turning sharing off aborts the active request and removes the local queue and installation ID. Enabling it again creates a new ID.
- An already accepted request cannot be recalled. Accepted records remain subject to retention; disabling sharing does not immediately remove past aggregates.
- The receiver keeps a rolling 90 calendar days of activity, with hourly expiry. A scheduler outage can delay removal until it recovers.

Daily salted network-address hashes are used for short-lived abuse counters only, not usage records or admin reports, and expire within a day. The ingest endpoint is excluded from request-address access logs and error/transaction payload capture. Hosting networks can still observe connection metadata when handling HTTPS traffic.

## Website icons

OpenGEO loads icons through its backend for websites already in your projects or citation evidence. If a direct icon is unavailable, cached lookup is enabled by default: Google's icon service receives the public hostname and can observe your network address. It receives no provider credentials, project IDs, prompts, content or referring page.

Disable the fallback in **Settings > Data & privacy** to abort active cache requests and stop future lookups. A request already received by Google cannot be recalled; browser-cached images may remain until refresh. Only bounded raster icons are displayed, with a local monogram when unavailable. The cache is in memory and offline operation does not depend on it.

## Paid work and schedules

Run budgets control whether another request starts. They cannot reverse a completed charge. Direct DataForSEO requests can exceed an estimate, so use conservative estimates and provider-side spending controls. OpenRouter uses bounded output and model-rate estimates. DeepSeek starts only when its most expensive possible answer fits the approval, then records an estimate from its reported usage. Managed work uses the supported server preview or quote. See [connections and costs](connections.md#spending-pauses-and-cancellation).

OpenGEO retains completed paid work and never automatically replays a request with an uncertain outcome. Review the provider account before approving a retry. It does not silently switch providers.

Schedules use your selected time zone and monthly ceiling. Pending scheduled jobs reserve approved budgets. Desktop schedules run while the app is open, including in the tray; **Quit** stops them. Docker can run continuously on your host.
