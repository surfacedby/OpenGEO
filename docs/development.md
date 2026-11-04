# Develop OpenGEO

OpenGEO uses React and TypeScript for the interface, Fastify for the backend and SQLite for local storage. Electron and Docker run the same backend. Workflows, credentials and spending decisions belong to the server; the UI, CLI and MCP use those operations.

## Run from source

Requires Node.js 22 or newer. If a native dependency needs compilation, you will also need Python and your platform's C++ build tools.

From a checkout:

```sh
npm ci
node scripts/setup.mjs
npm run build
```

Set `OPENGEO_SECRET_FILE` to the absolute path of `.local/encryption-secret`, then start the server:

```sh
export OPENGEO_SECRET_FILE="$(pwd)/.local/encryption-secret"
npm start
```

In PowerShell, use `$env:OPENGEO_SECRET_FILE = (Resolve-Path .local/encryption-secret).Path` instead of `export`.

Open <http://localhost:4318>. Keep `.local` private. The desktop app uses the operating-system credential store instead of this secret file.

## Work on the interface

Use the shared [design system](design-system.md) for tokens, components and screen patterns.

With the secret configured, run `npm run dev` for the backend and `npm run web` in a second terminal for Vite. Vite proxies `/api` to the local backend. Do not expose either server remotely.

Before submitting application changes, run:

```sh
npm test
npm run build
npm run check:public
```

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for evidence, privacy and test requirements.

## Package a desktop build

`npm run desktop` starts Electron after building. `npm run package:desktop` builds the app, bundles Chromium, prepares SQLite for the installed Electron runtime and verifies the native binding before packaging.

SQLite bindings for Node and Electron are not interchangeable. Run `npm rebuild better-sqlite3` before returning to Node development or tests after desktop packaging.

Native sources and Electron headers compile outside your home directory and checkout: `C:\OpenGEOBuild` on Windows or `/tmp/opengeo-build` on macOS/Linux. Set `OPENGEO_NATIVE_BUILD_ROOT` to choose another neutral writable directory. The guard rejects paths inside the home directory or checkout, including redirected paths. Only verified bindings return to the package; temporary source and headers are removed.

For a clean verification build on a matching Windows x64 machine:

```sh
node scripts/clean-build.mjs --desktop-installer --platform=win --arch=x64
```

On macOS, use `--platform=mac` and the host's `x64` or `arm64` architecture. Build output stays under `release/`. These builds are not signed stable releases. Follow the full [release checklist](release.md) before distributing them.

## CLI and MCP

Use the same `OPENGEO_DATA_DIR` as the running app. Its local session file authorizes access and must remain private. Credentials are never command-line arguments.

| Command | Purpose |
| --- | --- |
| `node dist-server/cli.js projects` | List local projects |
| `workspace ID` | Read a project's workspace |
| `job ID` | Inspect a saved job |
| `run JSON` | Start a workflow with the shared budgets |
| `schedule JSON` | Save a schedule |
| `review ID` | Read a paused run's approval requirements |
| `resume ID approval.json` | Submit explicit review and an optional increased ceiling |
| `cancel ID` | Stop work and request supported provider cancellation |
| `ask PROJECT ask.json` | Ask one question of the engines in the file, with its spending limit |
| `asks PROJECT [ASK]` | List a project's asks, or read one ask's answers |

The shortened commands in the table are subcommands of `node dist-server/cli.js`. An approval file contains `reviewed` and optionally `maxCostUsd`. An ask file contains `question`, `engines` (for example `["chatgpt", "surfacedby-gemini"]`) and, for paid engines, `maxCostUsd`. Question discovery requires an audited website through `auditJobId`.

For MCP stdio, launch `node dist-server/mcp.js`. It exposes the same start, read, review, resume and cancellation operations, plus `list_ask_engines`, `estimate_ask`, `ask_engines` and `read_ask` for asks.

## Runtime and storage

SQLite migration 1 creates projects, jobs, artifacts, workflow steps and settings. WAL preserves durable writes. A runtime lock prevents separate processes from recovering the same work. An interrupted job retains an uncertain provider step for user review.

Migration 3 adds the optional closed-field usage outbox. New setup preselects sharing, but no events are sent until the preference is saved. Existing choices and existing workspaces without a saved choice are preserved. The local session protects the preference; exports exclude consent and queue state. Usage tests use a local transport, not the live collector or a paid provider.

Audits default to 100 public pages. The traversal budget can be raised to 100,000 to control host load and duration; it is not a project or feature limit. Coverage retains failed fetches and remaining queued pages. Browser rendering uses the validated networking path and blocks WebSockets, service workers and downloads.

## Review UI changes

`node node_modules/tsx/dist/cli.mjs scripts/analytics-ui-review.ts` checks loaded evidence views in an isolated local runtime. Its clearly labelled synthetic records cover chart gaps, repeated citations, drill-downs, full answers and layouts at 1360, 760 and 390 pixels. Captures stay outside the repository and are regression evidence, not marketing examples. The runner and scheduler stay stopped; no paid requests run.

Public product screenshots follow [SCREENSHOT_PROFILE.md](../SCREENSHOT_PROFILE.md), using a real audit of example.com and no private account data.
