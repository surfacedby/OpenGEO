# Install OpenGEO

The easiest way to try OpenGEO is the desktop app. It includes the runtime and browser, so you do not need developer tools or an Apple developer account.

## Desktop downloads

Download from the [official GitHub release](https://github.com/surfacedby/OpenGEO/releases/tag/v0.1.0-beta.7).

| Computer | File |
| --- | --- |
| Windows x64 | `OpenGEO-0.1.0-beta.7-windows-x64.exe` |
| Mac with an Apple M-series chip | `OpenGEO-0.1.0-beta.7-macos-arm64.dmg` |
| Mac with an Intel processor | `OpenGEO-0.1.0-beta.7-macos-x64.dmg` |

This beta has no Linux desktop download. Use [Docker](#docker) or [run from source](development.md#run-from-source) instead. Store listings are optional future distribution channels.

## Verify your download

Download `SHA256SUMS.txt` and `release-manifest.json` from the same release. The manifest records the application source, file hashes and actual verification scope.

On Windows, run this in PowerShell from your Downloads folder:

```powershell
Get-FileHash .\OpenGEO-0.1.0-beta.7-windows-x64.exe -Algorithm SHA256
```

On a Mac, run this in Terminal, using `x64` instead of `arm64` for Intel:

```sh
shasum -a 256 ~/Downloads/OpenGEO-0.1.0-beta.7-macos-arm64.dmg
```

Compare the complete result with `SHA256SUMS.txt`. A matching hash confirms you received the published file. It is not a publisher certificate or a guarantee that software is safe.

## Install on Windows

Run the installer. On the Finish screen, choose whether to open OpenGEO and create a desktop shortcut, then click **Finish**. It installs for your current user; you can also open it later from the Start menu.

**The Windows beta is unsigned.** Windows may show an unknown-publisher or SmartScreen warning. Some managed computers will block it. `Get-AuthenticodeSignature` is expected to report `NotSigned`. Do not disable antivirus or SmartScreen globally, or install a self-signed root certificate for OpenGEO.

## Install on a Mac

1. Choose **Apple menu > About This Mac**. An Apple M-series chip needs the arm64 download; an Intel processor needs x64.
2. Open the DMG and drag OpenGEO to **Applications**.
3. Eject the disk image, then open OpenGEO from Applications.

**The Mac previews are ad hoc signed, not Developer ID signed or notarized.** macOS may block first launch. If you trust the official download and have checked its hash, follow [Apple's per-app Open Anyway instructions](https://support.apple.com/102445): attempt to open the app, then use **System Settings > Privacy & Security > Open Anyway** if offered. Organization policies may still prevent installation. Do not disable Gatekeeper globally.

An ad hoc signature detects changes to the sealed app; it does not verify the publisher or establish an Apple malware review. Both architectures passed actual mounted-and-copied installer workflow tests on macOS 15. Older macOS versions, browser-quarantine installation and clean-machine installation are not certified.

## Updates, workspace and uninstalling

OpenGEO checks for desktop updates while it is running. In **Settings > About**, you can check now, control automatic downloads, or stop a download on a metered connection. Downloads are checked against the release checksum. Installation always needs your confirmation, and unsaved work or unfinished scans block a restart.

On Windows, choose **Install and restart** when the download is ready. On Mac, open the downloaded disk image, quit OpenGEO, and drag the new app to Applications to replace the existing copy. Mac replacement is manual while Apple signing and notarization are deferred. Older versions without the updater need one download from GitHub to get this feature.

Export a backup in Settings before updating. Closing the window leaves OpenGEO running in the tray; use **Quit** before manually replacing it. Each release needs its own upgrade verification.

On a Mac, an update can show a macOS dialog saying **OpenGEO wants to use your
confidential information stored in "OpenGEO Safe Storage" in your keychain**.
Ad hoc signed updates need your approval to read the existing encrypted connections.
Check the official download and its checksum, then enter your login Keychain
password in that **macOS system dialog** and choose **Always Allow** for the updated
app. Never enter that password in OpenGEO's interface or a website. Dismissing the
dialog can leave startup waiting; reopen the app when you are ready to approve it.

| System | Workspace location | Remove the application |
| --- | --- | --- |
| Windows | `%APPDATA%\OpenGEO` | Settings > Apps > Installed apps > OpenGEO |
| macOS | `~/Library/Application Support/OpenGEO` | Quit, then move OpenGEO from Applications to Trash |

The workspace is separate from the application. Keep it private and review it before deleting anything. Uninstalling the app does not certify data erasure. Project exports exclude credentials, but can contain private research and drafts.

## Docker

Docker runs the same application on your own host. The beta does not publish a prebuilt container image; Compose builds the checked-out source.

With Docker Compose and Node.js available, run from a checkout:

```sh
node scripts/setup.mjs
docker compose up --build -d
```

Open <http://localhost:4318>, or the port you set in `OPENGEO_PORT`. The setup script creates an encryption secret in `.local/encryption-secret`. Keep the `.local` directory owner-only (mode 700); the mounted secret file must be readable by the container's unprivileged user (mode 644). If Node.js is unavailable, create the file with at least 32 random bytes using your operating system's secure random generator and apply those permissions.

Keep the Docker data volume and encryption secret when updating. Source and Docker backups require you to preserve both separately. Do not expose the backend directly to the internet; see [remote access](#remote-access) for reaching it from another machine. ChatGPT sign-in uses a loopback callback; the [connection guide](connections.md#chatgpt) explains forwarding and the optional remote completion flow.

## Remote access

For direct HTTPS access over Tailscale, follow the [private-network setup guide](remote-access.md). This optional source/Docker mode requires a workspace access key. The existing desktop downloads retain local mode.

For local mode, keep the application and sign-in ports bound to loopback on the server, then forward them over an authenticated SSH connection. The SSH host can be reached through Tailscale or WireGuard if your account and network rules permit it.

The backend checks for loopback `Host` headers, but a header check is not access control. A proxy that rewrites headers does not add authentication. Keep the request checks enabled and use explicit loopback bindings at both ends:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4318:127.0.0.1:4318 -L 127.0.0.1:4319:127.0.0.1:4319 you@your-host
```

Then open <http://127.0.0.1:4318> on your own machine. If you changed the server's ports, replace the remote targets with its configured `OPENGEO_PORT` and `OPENGEO_OAUTH_PORT`.

The application forward can use another free local port. For example, `-L 127.0.0.1:8318:127.0.0.1:4318` is reached at <http://127.0.0.1:8318>. The browser sends the same port in `Host` and `Origin`, which must agree.

The sign-in forward is different. Keep its local port equal to `OPENGEO_OAUTH_PORT`, because sign-in sends the browser to that exact loopback address.

The SSH connection controls access to the server-side forwarding. Anyone who can reach your local forwarded port can still use the local-mode workspace and connected providers, including other users on that computer. The local session cookie is not a separate login. Direct network-hostname access requires the separately configured [remote mode](remote-access.md); see the [security model](../SECURITY.md#local-access-is-the-trust-boundary).

## Build or contribute

See [development](development.md) for source setup, CLI, MCP and packaging. Maintainers must follow the [release checklist](release.md) before publishing a new binary. It covers signing, exact package review and platform tests; a successful source build alone does not qualify an installer.
