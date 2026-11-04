# Interface design system

OpenGEO uses a shared visual foundation across the workspace, setup, settings and task dialogs. Keep business rules and evidence calculations in their existing server modules.

## Foundation

`src/ui/tokens.css` owns colors, typography, spacing, radii, shadows and responsive page spacing. Use semantic names such as `--citation`, `--muted` and `--panel-space` instead of choosing a new color or padding for each screen. Blue identifies primary actions and mentions; teal identifies citations. Pair status colors with words or icons.

The interface uses Inter, Lucide icons, quiet borders and a pale canvas. Cards group related evidence or a task. Avoid putting every label inside another card.

## Shared components

| Component | Use |
| --- | --- |
| `PageHeader` | Every workspace screen: icon, title, short explanation and contextual action |
| `MetricCard` | A measured value, its denominator and an optional comparable-check change |
| `CoverageRing` | A real count and denominator, with an accessible text equivalent |
| `EmptyState` | Explain what is missing and offer a useful next step |
| `Section` | A content surface with one heading and consistent body spacing; do not nest panels for padding |
| `Toolbar` | Search or context on the left, related list actions on the right |
| `Tabs` | Shared tab navigation with arrow-key, Home and End support |
| `ActionCard` | A small set of distinct workflows with a description and an explicit next action |
| `Dialog` | Confirmations and task forms; `variant="drawer"` for full answer evidence |
| `Select` | Searchable keyboard selection, including inside native dialogs |
| `LanguageSelect` | The same language choices in setup and brand settings, preserving imported locales |

Panels, buttons, form controls, tabs and responsive tables share the base styles in `styles.css`. Feature styles own layout, not alternate themes. Dialog dropdowns portal into their nearest dialog so they remain interactive in its modal layer. Escape closes the dropdown first; closing a dialog returns focus to its opener.

Put the main action in `PageHeader`. Do not repeat the page introduction in a bordered banner directly below it. Use tabs to switch related views, one surface for a list, and dividers between rows. Let whitespace separate sections; a border is not a substitute for spacing. Reusable structures belong in `src/ui`, not copied JSX across screens. Render and inspect desktop and mobile states after changing shared components, including empty, populated, loading and error states.

## Screen patterns

| Area | Pattern |
| --- | --- |
| Overview | Evidence summary, citation coverage, comparable history and next action |
| Prompts | Tracked questions, grounded suggestions, prompt editing and grouping by campaign |
| Campaigns | Questions grouped toward one goal, each with results, target pages, competitors and the checks that read it |
| Visibility | Trends, readable chart data, question coverage grouped by campaign and check history |
| Responses | Search and mutually exclusive outcome filters, then a full-answer drawer |
| Sources | Domain/page views with citation counts and supporting answers |
| Competitors | Saved comparison websites, citation comparison and supporting evidence |
| Scans | AI visibility and website health workflows, coverage and page findings |
| Opportunities | Prioritized groups, supporting evidence and content handoff |
| Content | Draft library, document editor, review and unsaved-change protection |
| Reports | Export the saved project evidence |
| Brand | Selected website's name, language, competitors, business context and deletion |
| Settings | App-wide connections, schedules, privacy and updates, available without a brand |
| Setup | The same controls and surfaces with a short, explicit progress sequence |

## Evidence and scope

The overview summary and response filters use existing saved observations. They do not request new answers or spend provider credits. Missing data stays missing; an empty history is not a zero score. Deltas use the server's comparable measurement. Charts mark incomplete checks with shaded gaps and retain an accessible data table.

Traffic attribution, market-wide rankings, outreach and sentiment scores require additional collection or analysis. Do not add placeholder versions of these features to fill a layout. Existing audits, answers, citations, findings and drafts supply the visuals.

## Local verification

Build before browser checks. `scripts/analytics-ui-review.ts` covers all thirteen screens at desktop, tablet and mobile widths, each campaign tab, the campaign selector over Visibility, Responses, Sources and Competitors, and grouped prompts, then checks header clipping, chart labels, evidence navigation, filters, answer drawers and saved draft navigation. `scripts/workflow-ui-review.ts` checks task dialogs, dropdowns, keyboard isolation, submission safety and a check limited to one campaign. Connection and recheck review scripts cover provider availability and retained run settings.

These scripts use isolated local test records and keep paid work stopped. Their labelled screenshots are regression evidence, not public product claims. Public screenshots follow `SCREENSHOT_PROFILE.md`.
