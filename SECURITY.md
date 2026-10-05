# Security

Never report a credential or private customer payload in a public issue. Report a vulnerability privately with [Report a vulnerability](https://github.com/surfacedby/OpenGEO/security/advisories/new) on the Security tab, and allow time for a fix before disclosing it.

The default installation listens on loopback. Local requests require a session and are checked for Host, Origin and browser fetch context. Electron renderers have no Node access and use context isolation and sandboxing. Crawlers block private networks, including resolved addresses and redirects.

Treat crawled pages as untrusted. They cannot authorize tool calls, credential access, spending or publishing. Content drafts always require human review.

Desktop credentials use protected operating-system encryption. Docker requires a separately supplied encryption secret. Keep that secret readable only by the user running the installation. Credentials are not included in ordinary project backups.

Before every release, scan source, all Git refs and unpacked distribution artifacts. Any exposed credential must be revoked and rescanned. A successful scanner run does not replace manual confidentiality review.
