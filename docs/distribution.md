# Desktop distribution

OpenGEO does not require users to buy a developer membership, certificate or API account. Signing is a maintainer release concern. Source and Docker distribution do not require a commercial signing certificate.

## Windows

The preferred free route is a Microsoft Store **MSIX** package. Microsoft documents free individual developer registration, hosting, signing and updates for MSIX. Registration still includes identity checks; the owner must perform any government ID or selfie step. EXE/MSI submissions do not receive the same MSIX signing service.

For direct downloadable installers, apply to SignPath Foundation after the public repository and release satisfy its open source conditions. Its program is free but approval is not guaranteed or immediate. Do not publish a download as signed until its exact binary signature is verified.

An unsigned technical preview may be distributed with accurate installation instructions and published hashes after the confidentiality gate passes. Do not ask users to disable antivirus or install a self-signed root certificate. That preview is not the friction-free public v1 installer.

## macOS

Apple's normal Developer ID signing and notarization route requires Apple Developer Program membership, currently USD 99 per year, plus a macOS build runner. Apple's fee waiver covers qualifying nonprofits, accredited educational institutions and government entities; an MIT license alone does not qualify.

Docker or a source install remains the no-certificate alternative. Ad hoc signed developer previews do not provide the same trust or installation experience as notarized downloads. Public v1 desktop acceptance remains open until both architectures are built, signed, notarized and tested on clean machines.

## Build authenticity

The repository verification workflow checks the application on Windows x64, macOS x64/arm64 and Linux x64/arm64. A manual run also builds unsigned desktop packages and native Docker images on matching runners. This avoids mixing the architecture of SQLite with the bundled browser. The workflow has read-only repository permissions, does not load provider or signing credentials, and does not upload packages or publish releases. A configured workflow is not evidence that its platform jobs have passed; retain the actual run results before approving a target.

For a local package on a matching machine, use `node scripts/clean-build.mjs --desktop-installer --platform=win --arch=x64`. Substitute `mac` and the machine's `x64` or `arm64` architecture on macOS. Build output must remain below `release/`. These are unsigned verification builds; the signing and clean installation gates still apply.

Record the reviewed source commit, lockfile, platform/architecture, artifact hashes and confidentiality receipt. GitHub build attestations or Sigstore can establish build provenance, but do not replace Windows Authenticode or Apple notarization.

No signing credentials belong in source, Docker build arguments or frontend bundles. Configure them only through the release runner's protected secret store. Release workflows must not publish automatically before manual confidentiality review.

## Sources checked 2026-09-30

- [Microsoft free registration and MSIX signing](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)
- [SignPath Foundation eligibility](https://signpath.org/terms.html)
- [Apple enrollment](https://developer.apple.com/help/account/membership/program-enrollment)
- [Apple fee waivers](https://developer.apple.com/help/account/membership/fee-waivers/)
- [Electron signing and notarization](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Sigstore build authenticity](https://docs.sigstore.dev/)
