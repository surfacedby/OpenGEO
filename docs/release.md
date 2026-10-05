# Release gates

Public source must exclude development notes, private configuration, review receipts and runtime data. `npm run check:public` checks tracked paths and all Git history, including files deleted from the current tree, and flags conversation fragments and change narration in current source comments. Manual review must also examine prompts and other prose for internal dialogue and topic bias. These checks precede secret and artifact review. Keep development history separate when preparing the first public source snapshot; do not bypass a failed gate by ignoring an old commit.

Public v1 requires the complete workflow, working desktop/Docker distributions, provider verification, Console billing verification and zero unresolved confidentiality findings.

Installation configures a local pre-push boundary check. CI also checks the full
history. These checks include hidden and ignored private source files; dependency
and build directories receive their separate distribution review. They supplement
secret scanning and manual review, and do not certify that every public file is safe.

Run `npm test`, `npm run build` and `npm run audit:deps`. The dependency gate fails on any advisory in runtime dependencies. A build-tool advisory passes only when `scripts/dependency-dispositions.json` records a review for its exact locked version, dependents and the condition that keeps the affected code unused; any change to those makes it fail again. Use clean environments containing public build settings only. Package Windows x64 and macOS arm64/x64; build Docker Linux amd64/arm64. Install and operate each target on a clean machine. Signing identities, notarization and provider eligibility must be verified before publishing downloads.

Run `npm run audit:source` before the first public push. The auditor inventories hidden and untracked files, scans the working tree with pinned Gitleaks and TruffleHog images, and scans all Git refs once a reviewed commit exists. TruffleHog credential verification is disabled and scanner containers have no network. Targeted matching accepts `OPENGEO_CONFIDENTIAL_VALUES_FILE`, a JSON array stored outside the public repository; matching includes raw, URL-encoded, hex and base64 forms, including UTF-16 little-endian and big-endian binary representations.

On Windows x64, `OPENGEO_SCANNER_DIR` can select the pinned native release binaries instead. Their exact SHA256 digests are checked before execution, credential verification remains disabled, and receipts explicitly record that the native process is not network isolated. Run native scanners only on the maintainer's trusted machine. Scanner reports and confidential matching inputs remain outside the repository in either mode.

Unpack installers, Electron ASAR archives, Docker layers, release archives and published packages into private audit directories. Run `npm run audit:release -- --artifact PATH` for each unpacked tree. Include image configuration/history and bundle source maps when present. Archives left packed are unresolved findings. Repeat against the exact downloads, not an earlier build.

Receipts contain reviewed commit, file hashes, coverage and redacted findings. They are stored outside the public repository. Raw confidential matching inputs must never be committed. An automated pass does not approve publication; a manual provenance, privacy and asset review is still required.

Exact-file false-positive reviews also remain private. `OPENGEO_DISPOSITIONS_FILE`
selects a JSON array outside the checkout. Each disposition must identify the
scope, path, detector rule, SHA256 and review reason; history findings additionally
require their exact commit. A review cannot suppress different source or packaged
bytes. No ignored directory or detector-wide allowance substitutes for review.

Review a fresh checkout of the exact source commit. Git attributes keep text files in LF format across platforms and preserve binary assets, so exact-file dispositions do not change with the maintainer's line-ending preference. Recheck all source bytes after any release-documentation or disposition change.

Every unpacked artifact file receives a hash, including large bundled executables. Files too large for targeted text matching remain review findings until their exact bytes and vendor provenance have been reviewed. A hash alone is not a confidentiality review.

Windows native SQLite preparation removes absolute PDB lookup paths only from validated, unsigned PE CodeView debug records. The GUID, age and executable code remain intact. Signed binaries require a clean upstream build. Preparation refuses any remaining workspace or home-directory path, including compiled module registration. Compile native modules in a neutral release directory with unchanged dependency sources. Native runtime verification runs after this preparation; old artifacts are never retroactively approved.

Preparation inventories every `.node` file recursively, including alternate cache filenames. Desktop packages exclude the native build cache and retain the verified runtime module. Audit the exact installer payload to confirm that unused native caches are absent; checking only the module loaded at runtime does not cover the distribution.

Confirm scanner canaries in temporary fixtures, including encoded strings and bundled/exported content. False positives require a narrow, documented disposition after reviewing the exact rule and file. Do not add blanket exclusions. Revoke any exposed credential, remove its source, and rescan affected history and artifacts.

For packed archive findings, map the reported byte or line range back to the exact unpacked files and review both representations. Some bundled Chromium extension manifests contain published vendor PKCS8 fixtures. Establish exact upstream byte provenance and describe the material accurately; a vendor fixture is not an owner credential, but it must not be described as a public key. Dispositions remain restricted to the reviewed artifact scope, rule and file digest.

History findings retain their commit identity. A historical false-positive disposition requires the full commit hash and the SHA256 of that commit's file blob. A current source disposition never covers an older revision. Native Windows history scans use the local-drive URI format supported by the pinned scanner.

Enable private vulnerability reporting on the repository. Complete naming/logo clearance and contribution/license review. Build and test the reviewed commit again, audit the resulting hashes, then publish only those artifacts.
