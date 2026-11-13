# Release checklist for maintainers

Use this checklist before publishing source or attaching a new installer. For end-user setup, see the [installation guide](distribution.md).

Public source must exclude development notes, private configuration, review receipts and runtime data. `npm run check:public` checks tracked paths and all Git history, including files deleted from the current tree, and flags conversation fragments and change narration in current source comments. Manual review must also examine prompts and other prose for internal dialogue and topic bias. These checks precede secret and artifact review. Keep development history separate when preparing the first public source snapshot; do not bypass a failed gate by ignoring an old commit.

Public v1 requires the complete workflow, working desktop/Docker distributions, provider verification, Console billing verification and zero unresolved confidentiality findings.

## GitHub beta scope

The GitHub beta targets an unsigned Windows x64 installer and ad hoc signed, unnotarized Mac arm64/x64 DMGs. Source and locally built Docker installation are available separately. Microsoft Store and Mac App Store enrollment are deferred.

Only attach binaries whose exact payload passed confidentiality review and whose actual installation and local workflow were exercised. State the tested host and limitations: an isolated maintainer profile or native hosted runner is not a clean-machine certification. Do not attach untested platforms merely because source tests passed there.

The beta release notes must disclose signing status, automatic download preferences, explicit installation consent, manual Mac replacement, local storage/backup behavior, optional usage sharing and external provider costs. Managed provider output/cost, financial recovery, activation, deployed usage collection and historical import remain separate acceptance gates. A beta release cannot relabel those gates as passed. They remain required before promoting the corresponding managed functionality as production-ready or declaring full v1 complete.

The Windows candidate gate exercises the actual assisted installer's Finish controls and packaged update download/checksum/explicit installation flow with an isolated local feed serving the exact candidate. A separate existing-version upgrade verifies retained workspace and encrypted connections. The controlled feed is not a live GitHub delivery test; publication separately verifies the public installer and update-feed bytes.

Create a GitHub prerelease against the exact reviewed source commit. Include `SHA256SUMS.txt`, a public `release-manifest.json` with source commit and actual artifact hashes, and installation instructions. Never include private audit receipts, detector output, confidential matching values or workstation paths. After upload, download the actual public assets and verify their hashes against the reviewed files before announcing the release. Publishing a checksum is not a substitute for signing or malware/security review.

## Source and artifact review

### 1. Check source, dependencies and platform behavior

Run available tests and checks locally before pushing changes. Application CI is
manual and restricted to `master` for an actual release; pushes and pull requests
do not start it. Reserve hosted runners for the final source verification and
native release builds, installation checks and artifact review.
After building the web application, `npm run test:browser` exercises setup against
the actual local API with delayed privacy-preference requests. Use an installed
Chromium, or set `OPENGEO_TEST_BROWSER` to an existing browser executable.

Installation configures a local pre-push boundary check. CI also checks the full
history. These checks include hidden and ignored private source files; dependency
and build directories receive their separate distribution review. They supplement
secret scanning and manual review, and do not certify that every public file is safe.

Run `npm test`, `npm run build` and `npm run audit:deps`. The dependency gate fails on any advisory in runtime dependencies. A build-tool advisory passes only when `scripts/dependency-dispositions.json` records a review for its exact locked version, dependents and the condition that keeps the affected code unused; any change to those makes it fail again. Use clean environments containing public build settings only. For stable v1, package Windows x64 and macOS arm64/x64; build Docker Linux amd64/arm64, and install and operate each target on a clean machine. Verify signing identities, notarization and provider eligibility before claiming signed stable acceptance. The narrower GitHub beta follows its explicit platform and signing scope above.

### 2. Scan source and keep review material private

Run `npm run audit:source` before the first public push. The auditor inventories hidden and untracked files, scans the working tree with pinned Gitleaks and TruffleHog images, and scans all Git refs once a reviewed commit exists. TruffleHog credential verification is disabled and scanner containers have no network. Targeted matching accepts `OPENGEO_CONFIDENTIAL_VALUES_FILE`, a JSON array stored outside the public repository; matching includes raw, URL-encoded, hex and base64 forms, including UTF-16 little-endian and big-endian binary representations.

Install the exact scanner images named in `scripts/scanner-config.mjs` before using Docker scans. The audit never downloads images automatically and mounts the source read-only instead of copying dependencies or builds. On Windows, `OPENGEO_DOCKER_TRANSPORT=wsl` selects the WSL Docker client when needed; ordinary Docker and the pinned native scanners remain supported. Missing or incomplete scanner output blocks publication.

On Windows x64, `OPENGEO_SCANNER_DIR` can select the pinned native release binaries instead. Their exact SHA256 digests are checked before execution, credential verification remains disabled, and receipts explicitly record that the native process is not network isolated. Run native scanners only on the maintainer's trusted machine. Scanner reports and confidential matching inputs remain outside the repository in either mode.

### 3. Review the exact unpacked package

Unpack installers, Electron ASAR archives, Docker layers, release archives and published packages into private audit directories. Run `npm run audit:release -- --artifact PATH` for each unpacked tree. Include image configuration/history and bundle source maps when present. Archives left packed are unresolved findings. Repeat against the exact downloads, not an earlier build.

Receipts contain reviewed commit, file hashes, coverage and redacted findings. They are stored outside the public repository. Raw confidential matching inputs must never be committed. An automated pass does not approve publication; a manual provenance, privacy and asset review is still required.

Exact-file false-positive reviews also remain private. `OPENGEO_DISPOSITIONS_FILE`
selects a JSON array outside the checkout. Each disposition must identify the
scope, path, detector rule, SHA256 and review reason; history findings additionally
require their exact commit. A review cannot suppress different source or packaged
bytes. No ignored directory or detector-wide allowance substitutes for review.

Review a fresh checkout of the exact source commit. Git attributes keep text files in LF format across platforms and preserve binary assets, so exact-file dispositions do not change with the maintainer's line-ending preference. Recheck all source bytes after any release-documentation or disposition change.

Every unpacked artifact file receives a hash, including large bundled executables. Files too large for targeted text matching remain review findings until their exact bytes and vendor provenance have been reviewed. A hash alone is not a confidentiality review.

### 4. Verify native binaries and scanner coverage

Windows native SQLite preparation removes absolute PDB lookup paths only from validated, unsigned PE CodeView debug records. The GUID, age and executable code remain intact. Signed binaries require a clean upstream build. Preparation refuses any remaining workspace or home-directory path, including compiled module registration. Compile native modules in a neutral release directory with unchanged dependency sources. Native runtime verification runs after this preparation; old artifacts are never retroactively approved.

Preparation inventories every `.node` file recursively, including alternate cache filenames. Desktop packages exclude the native build cache and retain the verified runtime module. Audit the exact installer payload to confirm that unused native caches are absent; checking only the module loaded at runtime does not cover the distribution.

Confirm scanner canaries in temporary fixtures, including encoded strings and bundled/exported content. False positives require a narrow, documented disposition after reviewing the exact rule and file. Do not add blanket exclusions. Revoke any exposed credential, remove its source, and rescan affected history and artifacts.

For packed archive findings, map the reported byte or line range back to the exact unpacked files and review both representations. Some bundled Chromium extension manifests contain published vendor PKCS8 fixtures. Establish exact upstream byte provenance and describe the material accurately; a vendor fixture is not an owner credential, but it must not be described as a public key. Dispositions remain restricted to the reviewed artifact scope, rule and file digest.

History findings retain their commit identity. A historical false-positive disposition requires the full commit hash and the SHA256 of that commit's file blob. A current source disposition never covers an older revision. Native Windows history scans use the local-drive URI format supported by the pinned scanner.

### 5. Publish only the reviewed files

Enable private vulnerability reporting on the repository. Complete naming/logo clearance and contribution/license review. Build and test the reviewed commit again, audit the resulting hashes, then publish only those artifacts.

Keep large build and release transfers on hosted runners when local bandwidth is limited. An anonymous full-download check can also run there, returning only its small hash receipt. That receipt must bind the actual successful run, workflow revision, source and complete downloaded bytes; a successful upload or server digest alone is not a full-download check.

## Hosted beta release procedure

The `Review and publish beta packages` workflow has three separate phases. Each
requires an exact full commit on `master` and a private draft release targeting
that commit. Draft review assets must never be published.

1. **Prepare:** build on Windows x64 and both native Mac architectures; install
   beta.4 in an isolated profile, update it, verify the project, audit evidence,
   disabled usage sharing and OS-encrypted storage survive, then exercise a fresh
   installation. Verify the Mac resource seal and retain complete payload
   inventories. Also build and operate Docker on Linux amd64 and arm64. Upload
   candidates only to the private draft.
2. **Audit:** use the original prepare run ID. Hosted Linux runners unpack those
   exact packages and ASAR files, compare installed vendor files with pinned
   official archives, and scan the complete payload and fresh source/history.
   `OPENGEO_RELEASE_REVIEW` is a temporary repository secret containing the private
   confidential-value array. It is used only in this phase, never in builds or
   application processes. Findings and file-level review dispositions stay in the
   private draft. A blocked audit is retained; subsequent audit runs do not rebuild
   installers or replace earlier evidence.
3. **Publish:** requires an authenticated, exact-hash publication approval in the
   private draft, successful source and remote-access CI, and zero unresolved
   audit findings. Review vendor metadata and all payload exceptions before
   approving. The runner publishes only the approved installers, an exact source
   archive, manifest and checksums, then anonymously downloads every public file
   in full and checks its bytes. Retain the small verification receipt privately.

Delete the temporary matching secret and private review draft after retaining the
necessary audit evidence. Existing public release assets remain immutable.

Mac fresh startup uses the runner's normal Keychain. The encrypted upgrade check
uses one uniquely named disposable Keychain in the runner user's Keychain directory,
so macOS applies its protected format. It contains a synthetic item whose decrypt ACL names
only the exact old and new code identities. The independent partition list also
contains exactly those two code hashes; an unlisted program must be refused.
The system consent tool receives the disposable keychain password through a
private pipe, never a process argument, environment variable or saved file.
This represents explicit fixture-owner
consent; it does not automate or bypass the macOS password dialog. The original
default and user search list are restored, system and dynamic lists are preserved,
and the disposable Keychain is removed even
after a failed check. No existing Keychain item, TCC setting, publisher identity or
application credential protection is changed. Record that scope in the package
receipt and disclose the end-user Keychain approval in the update guide.
