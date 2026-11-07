# Sumi for macOS (Electron Desktop)

Sumi is a local-first trading journal combining LuxAlgo's journal screens, automated broker sync, statement importers, analytics, SQLite persistence, and on-device voice dictation, styled with Tw93's Kami-inspired aesthetic.

This branch (`electron`) transitions Sumi to a modern Electron architecture (Electron v45.2.3) hosting the full Next.js standalone application backed by an isolated, official Node.js runtime and native Apple Silicon acceleration.

- **Target Architecture**: macOS 14.0+ on Apple Silicon (`arm64`). _(Intel x86_64 and Windows are not yet supported)._
- **Version Truth**: Single source of truth is root `package.json` (`v0.2.0`).
- **Updates**: Native Sparkle 2.9.6 updater with independent Ed25519 signature verification.
- **Code Signing**: Unsigned / ad-hoc signed for local and open-source distribution without Apple Developer ID or App Store dependencies.

---

## Quickstart: Build, Check, and Open

### Requirements

- **Operating System**: macOS 14.0 (Sonoma) or newer on Apple Silicon (`arm64`).
- **Node.js**: Pinned to official Node **v26.13.0** (matches process ABI).
- **Package Manager**: Pinned **pnpm 11.0.8** (`packageManager` in `package.json`).
- **Apple Command Line Tools**: `xcode-select --install` (for `codesign`, `iconutil`, `sips`, and `xcrun`).
- **Internet Access**: Required during initial build to download verified official Electron and Node archives.

From the repository root (`trade-journal-main/`):

```sh
# 1. Install dependencies with exact lockfile
pnpm install --frozen-lockfile

# 2. Build the production web application and package dist/Sumi.app
pnpm desktop:build

# 3. Run automated verification suite (bundle integrity, signing, routes, SQLite persistence)
pnpm desktop:check

# 4. Open the built application
pnpm desktop:open
```

The application is output to `dist/Sumi.app`. Once built, Sumi is completely self-contained: it requires neither an active terminal, nor a separately installed Node, pnpm, Docker, or external browser.

---

## Architecture & Runtime Design

```text
dist/Sumi.app/
  Contents/
    MacOS/Sumi                    # Renamed official Electron 45.2.3 launcher binary
    Frameworks/
      Electron Framework.framework # Electron engine with hardened entitlements
      Sparkle.framework           # Native Sparkle 2.9.6 framework for atomic updates
      Electron Helper*.app        # Sandboxed GPU, Plugin, and Renderer helpers
    Resources/
      Sumi.icns                   # Native app icon generated from desktop/Icon.swift
      app/                        # Electron main entrypoint, preload, security, preferences
      server/                     # Next.js standalone production server bundle
      runtime/node                # Standalone official Node 26.13.0 binary (ABI preserved)
      launch.cjs                  # Ephemeral loopback port launcher & lifecycle supervisor
      licenses/                   # Upstream MIT, Node, Electron, Chromium, Sparkle licenses
```

### 1. Pinned Runtimes & ABI Stability

- **Electron 45.2.3**: Downloaded and verified against official Electron SHA256 checksums.
- **Node.js 26.13.0 Runtime**: The Next.js backend runs under an official, standalone Node.js 26.13.0 binary packaged into `Contents/Resources/runtime/node`.
- **Zero Electron Rebuild for Native Modules**: `better-sqlite3`, `koffi`, and `transcribe-cpp` execute entirely within the bundled Node runtime. Because the bundled Node version matches the development build host (`v26.13.0`), native C++/Metal modules preserve exact Node ABI compatibility without needing `electron-rebuild`.

### 2. Process & Network Security Isolation

- **Ephemeral Loopback Binding**: The backend server binds strictly to an OS-assigned ephemeral port on `127.0.0.1`.
- **Environment Whitelisting**: The child backend process is spawned with an explicit whitelist: `PATH`, `HOME`, `TMPDIR`, `LANG`, and `JOURNAL_DATA_DIR`. It strictly **does not inherit** terminal environment variables, `NODE_OPTIONS`, or API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). All API credentials must be entered securely in **Settings → AI**.
- **MainFrame IPC Validation**: Electron IPC handlers (`main.cjs`) strictly enforce origin checks and sender frame validation against the active loopback origin.
- **External Navigation Safeguard**: Any non-loopback URLs or external markdown links open in the user's default external web browser, never inside the Electron window.

---

## Where Your Data Lives & Swift Migration

### Application Support Folder

All user data resides in your user library:

```text
~/Library/Application Support/Sumi/
  journal.db          # Primary SQLite database (trades, accounts, notes, playbooks)
  journal.db-wal      # SQLite write-ahead log
  .secret             # Generated cryptographic key for encrypted credentials at rest
  desktop.log         # Backend startup, route, and diagnostic log (rotated per launch)
  preferences.json    # Desktop window, theme, and sidebar preferences (mode 0o600)
  electron/           # Chromium profile, cache, and Local Storage (mode 0o700)
  voice/              # On-device Parakeet ASR model weights (if downloaded)
```

To open this directory directly, choose **Sumi → Show Journal Data** from the native application menu bar.

### Preservation from Swift Versions

- **No Database Overwriting**: The `journal.db` SQLite database, attachments, and `.secret` key are preserved directly from prior Swift builds. No automatic database format conversion or duplicate copying is performed.
- **One-Time Preferences Migration**: On initial launch, if `preferences.json` is not present, Sumi imports existing desktop appearance and sidebar preferences prefixed with `journal-*` from macOS `UserDefaults` (`local.sumi.journal` `journalPreferences`). Non-journal preferences and non-string values are strictly filtered out, and preferences are written atomically with mode `0o600` under a 64KB aggregate bound.
- **Isolated Chromium Storage**: Chromium session data and local storage reside in `~/Library/Application Support/Sumi/electron/` to ensure full isolation from system-wide browser sessions.

---

## Native In-App Updates (Sparkle 2.9.6)

Sumi includes native, in-app updates using the **Sparkle 2.9.6** framework via `electron-sparkle` (0.2.0).

- **Independent Ed25519 Cryptographic Signatures**: Update archives are signed using Ed25519 cryptographic keys. The public key (`SUPublicEDKey`) is configured in `desktop/update-config.json` and bundled in `Info.plist`. The private signing key (`SPARKLE_PRIVATE_KEY`) is stored strictly as a private GitHub Actions secret and is never stored in the repository, artifacts, or build logs.
- **Update Feed**: Stable release feed is hosted at:
  ```text
  https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml
  ```
- **In-App Flow**: Check for updates directly in **Settings** or via the application menu. Sparkle downloads updates in the background, validates the Ed25519 signature against `SUPublicEDKey`, terminates the backend server cleanly, applies an atomic binary replacement, and restarts the app.
- **Testing Verification Notice**: Cryptographic feed generation and local atomic installation mechanisms are validated via automated checks; seamless in-place production upgrades from v0.2.0 to future releases will be established and confirmed on subsequent version releases.

---

## Code Signing & First-Launch Gatekeeper Notice

Sumi is ad-hoc signed (`codesign --sign -`) with Apple Hardened Runtime entitlements:

- `com.apple.security.cs.allow-jit` (V8 execution)
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.device.audio-input` (local microphone capture for voice dictation)

### Bypassing Gatekeeper on First Launch

Because this open-source build is distributed independently without a paid Apple Developer ID certificate:

1. In Finder, **Right-Click (Control-Click)** on `Sumi.app` and choose **Open**.
2. Click **Open** in the macOS confirmation dialog.
3. Alternatively, open **System Settings → Privacy & Security**, scroll down to the security section, and click **Open Anyway**.

> **Note on Managed Macs**: Managed Macs governed by corporate Mobile Device Management (MDM) profiles that require strict Developer ID notarization may reject ad-hoc signed applications.

---

## Packaging & Releases

Packaging for distribution produces compressed archives, a disk image, and cryptographic checksums:

```sh
# Package release artifacts
pnpm desktop:package
```

Outputs in `dist/`:

- `dist/Sumi-0.2.0-macos-arm64.zip`: Standalone zip archive for Sparkle updates.
- `dist/Sumi-0.2.0-macos-arm64.dmg`: Drag-to-install disk image for users.
- `dist/SHA256SUMS.txt`: SHA256 checksums of the release artifacts.
- `dist/appcast.xml`: Sparkle 2.9.6 XML feed generated via `desktop/update-tools.mjs`.

### GitHub Release Workflow

Releases are automated via `.github/workflows/electron-release.yml`:

- **Triggers**: Executed **only** on tags matching `electron-v*` (e.g. `electron-v0.2.0`) or via manual `workflow_dispatch` specifying a valid tag.
- **Branch Ancestry & Version Verification**: The workflow enforces that the release commit is an ancestor or direct descendant of `origin/electron` and verifies that the tag version matches `package.json`.
- **Runner**: Executes on GitHub-hosted Apple Silicon ARM64 runners (`macos-15`) with a strict `uname -m == arm64` guard.
- **Artifact Isolation**: Publishes strictly `Sumi-*.zip`, `Sumi-*.dmg`, `SHA256SUMS.txt`, and `appcast.xml`. Development caches, private keys, database files, and model weights are strictly prevented from entering the release.

---

## Automated Verification & Checks

Run the complete test suite before cutting releases or committing changes:

```sh
# Run core unit and integration tests
pnpm test

# Run TypeScript checks across all workspaces
pnpm typecheck

# Run Electron desktop check (verifies signing, symlinks, routes, and SQLite restart persistence)
pnpm desktop:check
```

The desktop verification tests launch a temporary Sumi backend in a clean temporary directory (`/tmp/sumi-check-*`), query all key API routes, test account creation and SQLite restarts, and ensure that no sensitive credentials, `.env` files, or heavy ASR model weights are bundled into the application.

---

## Features & Local Operations

- **Local-First Trading Journal**: Manual trade entries, plan targets, screenshot galleries, and daily reports are persisted directly to `journal.db`.
- **Local On-Device Voice Dictation**: Speech is captured via microphone and transcribed locally on Metal GPU / CPU using Parakeet Unified EN 0.6B and Silero VAD (transcribe-cpp bindings). Heavy weights (~731 MB) reside in user storage (`~/Library/Application Support/Sumi/voice`), while the lightweight Silero VAD model (1.2 MB) is bundled self-contained in the app.
- **Daily Review Exports**: Generates paginated daily review PDFs and PNG archives rendered 100% locally on-device.
- **AI Reflection**: Optional remote AI reflection (Ask Journal, Daily Recap, Trade Critique) with context preview dialogs. Configurable in **Settings → AI**.
- **Offline Attribution & Licenses**: View upstream MIT licenses, Node, Electron, Chromium, and dependency licenses anytime in **Settings → About & licenses**.
