# Contributing to OpenGEO

Keep the complete local workflow useful without a managed account. Provider adapters describe capabilities and costs; shared backend services own workflows, evidence and budgets. The interface displays canonical results.

Before a change, read its implementation and applicable tests. Explain the user problem and any migration implications. Add meaningful tests for paid-call recovery, data isolation, security boundaries or evidence calculations. Never weaken an assertion to hide a failure.

Run `npm test` and `npm run build`. Do not include credentials, populated configuration, customer evidence or screenshots from private accounts. Use example.com and clearly synthetic fixtures. Write ASCII punctuation in documentation and source comments.

Provider fixtures must cite the documented schema and strip tracking identifiers, credentials and personal data. New providers must support explicit budgets, capability validation and interrupted-request handling. Never add automatic paid fallback.

Small pull requests are easier to review. Describe what changed, how it was verified and any remaining limitation. Public releases require the confidentiality and packaging gates in [release instructions](docs/release.md).
