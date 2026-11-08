# Sumi Desktop (Electron: macOS, Windows & Linux)

Sumi is an independent, local-first desktop trading journal with broker sync, statement importers, analytics, SQLite persistence and on-device voice dictation, styled with Tw93's Kami-inspired aesthetic. It is based on [LuxAlgo's MIT-licensed trade-journal](https://github.com/LuxAlgo/trade-journal); see the [root README](../README.md) for the product overview.

The desktop app is an Electron shell (Electron v45.2.3) hosting the Next.js standalone application, backed by an isolated, official Node.js runtime. Sumi is desktop-only; there is no Docker or hosted web distribution. Developers can still run the web app alone with `pnpm dev`.

- **Target Platforms**:
  - macOS 14.0+ (Sonoma or newer) on Apple Silicon (`arm64`) & Intel (`x64`).
  - 64-bit Windows 10/11 (`x64`).
  - 64-bit Linux (`x64`, Ubuntu 22.04+ baseline / glibc 2.35+).
- **Version Truth**: Single source of truth is root `package.json` (`v0.3.3`), stable tag `electron-v0.3.3`, fixed public fork `xolah88457/trade-journal` (no app store wrappers).
- **Bundled Runtimes**: Electron 45.2.3, official separate Node.js 26.13.0 bundled automatically; end users require neither Node.js nor an external browser.
- **In-App Updates**:
  - macOS: Native Sparkle 2.9.6 updater with independent Ed25519 signature verification.
  - Windows & Linux: `electron-updater` 6.8.11 with explicit user consent dialogs (Check → Download consent → Install & Restart consent).
- **Code Signing Disclosures**: Distributed ad-hoc / unsigned for open-source independence without paid Apple Developer ID notarization or Windows Authenticode certificates.

---

## Architecture Scope & Boundaries

To ensure stability and predictable native execution, Sumi defines explicit architectural boundaries:

- **64-bit Architecture**: Support is strictly limited to 64-bit platforms (`arm64` and `x64` on macOS; `x64` on Windows and Linux). 32-bit platforms (x86/arm32) and ARM Windows/Linux are not supported in this release.
- **CPU Compatibility**: CPU compatibility follows standard requirements for the bundled Electron 45, Node.js 26, and native runtime components. The published native transcribe-cpp ASR artifacts provide a standard `cpu-x64` fallback alongside SSE4.2 and AVX acceleration paths; neither a dedicated GPU nor AVX/AVX2 is generally required. However, vintage or legacy 64-bit processors remain untested.
- **Linux Distribution Baseline**: Minimum glibc 2.35 (Ubuntu 22.04 LTS baseline or newer). Older distributions (e.g. Ubuntu 18.04/20.04, CentOS/RHEL 7) are unsupported due to Electron 45 and Node 26 C runtime dependencies.
- **Hardware & Environment Testing Limits**:
  - Full native Parakeet speech recognition inference (~700 MB model download) is not CI-run on Windows and Linux; automated testing verifies native backend viability (Koffi FFI, native DLL/SO loading, and tensor computation) via bundled Silero VAD (1.2 MB) loading, silence detection, and clean disposal without running full ASR inference.
  - Physical microphone hardware across varying Linux sound servers (PulseAudio, PipeWire, ALSA) and Windows audio devices remains untested.
  - Live broker sync connections across all OS/architecture combinations and the first real production in-place upgrade transition across varied platforms remain to be established upon live release.

---

## Quickstart: Build, Check, and Open

### Requirements

- **Operating System**: macOS 14.0+ (Apple Silicon `arm64` or Intel `x64`), 64-bit Windows 10/11 (`x64`), or Linux x64 (Ubuntu 22.04+ baseline).
- **Node.js**: Pinned to official Node **v26.13.0** (matches bundled runtime ABI).
- **Package Manager**: Pinned **pnpm 11.0.8** (`packageManager` in `package.json`).
- **Platform Build Tools**:
  - macOS: Apple Command Line Tools (`xcode-select --install`) for `codesign`, `iconutil`, and `sips`.
  - Windows: Visual Studio 2019/2022 C++ Build Tools (or official VC++ Redistributable directory for CRT DLL bundling).
  - Linux: `build-essential`, `python3`, `dpkg` / `fakeroot` (for `.deb` generation).
- **Internet Access**: Required during initial build to download verified official Electron and Node archives.

From the repository root:

```sh
# 1. Install dependencies with exact lockfile
pnpm install --frozen-lockfile

# 2. Build the production web backend and package desktop application
pnpm desktop:build

# 3. Run automated verification suite (bundle integrity, signing, routes, ASR doctor, SQLite persistence)
pnpm desktop:check

# 4. Open the built application
pnpm desktop:open
```

To package downloadable release distributions:

```sh
# Package release artifacts for your current platform
pnpm desktop:package

# Inspect built artifact status and checksums
node desktop/release.mjs
```

The resulting application is self-contained:

- macOS: `dist/Sumi.app`
- Windows: `dist/sumi-win32-x64/Sumi.exe`
- Linux: `dist/sumi-linux-x64/sumi`

Once built or installed, Sumi requires neither an active terminal, nor a separately installed Node, pnpm, or external browser.

---

## Architecture & Runtime Design

### Platform Bundle Structures

#### macOS (`dist/Sumi.app`)

```text
dist/Sumi.app/
  Contents/
    MacOS/Sumi                    # Official Electron 45.2.3 launcher binary
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
                                  # licenses/dependencies/: only packages that ship in the app
```

#### Windows (`dist/sumi-win32-x64/`)

```text
dist/sumi-win32-x64/
  Sumi.exe                        # Windows Electron 45.2.3 launcher binary
  resources/
    app/                          # Electron main, preload, security, preferences
    server/                       # Next.js standalone production server bundle
    runtime/
      node.exe                    # Standalone official Node 26.13.0 Windows binary
      msvcp140.dll                # App-local Microsoft Visual C++ CRT runtime DLL
      vcruntime140.dll            # App-local Microsoft Visual C++ CRT runtime DLL
      vcruntime140_1.dll          # App-local Microsoft Visual C++ CRT runtime DLL
    launch.cjs                    # Ephemeral loopback launcher
    licenses/                     # Upstream licenses & Microsoft CRT redistributable notice
```

#### Linux (`dist/sumi-linux-x64/`)

```text
dist/sumi-linux-x64/
  sumi                            # Linux Electron 45.2.3 binary
  chrome-sandbox                  # Hardened Chromium setuid sandbox helper
  resources/
    app/                          # Electron main, preload, security, preferences
    server/                       # Next.js standalone production server bundle
    runtime/node                  # Standalone official Node 26.13.0 Linux binary
    launch.cjs                    # Ephemeral loopback launcher
    licenses/                     # Upstream licenses & third-party notices
```

### 1. Pinned Runtimes & ABI Stability

- **Electron 45.2.3**: Downloaded and verified against pinned official Electron SHA-256 checksums across darwin-arm64, darwin-x64, win32-x64, and linux-x64.
- **Bundled Node.js 26.13.0 Runtime**: The Next.js backend runs under an official, standalone Node.js 26.13.0 binary packaged into the application's runtime folder.
- **Zero Electron Rebuild for Native Modules**: `better-sqlite3`, `koffi`, and `transcribe-cpp` execute entirely within the bundled Node runtime. Because the bundled Node version matches the development build host (`v26.13.0`), native C++/Metal modules preserve exact Node ABI compatibility without needing `electron-rebuild`.

### 2. Process & Network Security Isolation

- **Ephemeral Loopback Binding**: The backend server binds strictly to an OS-assigned ephemeral port on `127.0.0.1`.
- **Environment Whitelisting**: The child backend process is spawned with an explicit whitelist: `PATH`, `HOME` / `USERPROFILE`, `TMPDIR`, `LANG`, and `JOURNAL_DATA_DIR`. It strictly **does not inherit** terminal environment variables, `NODE_OPTIONS`, or API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). All API credentials must be entered securely in **Settings → AI**.
- **MainFrame IPC Validation**: Electron IPC handlers (`main.cjs`) strictly enforce origin checks and sender frame validation against the active loopback origin.
- **External Navigation Safeguard**: Any non-loopback URLs or external markdown links open in the user's default external web browser, never inside the Electron window.

---

## Linux Sandboxing & AppImage Constraints

Sumi enforces strict Chromium sandboxing on Linux:

- **Security Integrity**: Never launch or recommend running Sumi with `--no-sandbox` or disabled web security (`webPreferences.webSecurity`). Doing so exposes local desktop files and loopback interfaces to severe vulnerabilities.
- **AppImage Prerequisites**: Standalone `.AppImage` packages require system FUSE (`libfuse2` on Debian/Ubuntu) and unprivileged user namespace support. On distributions with restrictive AppArmor profiles for unprivileged user namespaces (such as default Ubuntu 24.04 installations), AppImages may require explicit user namespace permissions.
- **Recommended Linux Package**: For Debian, Ubuntu, and derivative distributions, the `.deb` package is the **primary recommended format**. It installs system sandbox helpers (`chrome-sandbox`) with correct permissions and integrates seamlessly with desktop menus and system package management.
- **Portable Tarballs**: Portable unpacked directory builds (`dist/sumi-linux-x64/`) do not support in-app self-updating; use `.deb` or `.AppImage` for update support.

---

## Where Your Data Lives & Backups

### Canonical User Data Paths

All user databases, encrypted credentials, preferences, and downloaded voice weights live in standard per-user application storage:

- **macOS**: `~/Library/Application Support/Sumi` (EXACT)
- **Windows**: `%APPDATA%\Sumi` (e.g. `C:\Users\<user>\AppData\Roaming\Sumi`)
- **Linux**: `$XDG_CONFIG_HOME/Sumi` (or `~/.config/Sumi` if `$XDG_CONFIG_HOME` is unset)

Directory layout:

```text
<User Data Directory>/
  journal.db          # Primary SQLite database (trades, accounts, notes, playbooks)
  journal.db-wal      # SQLite write-ahead log
  .secret             # Generated cryptographic key for encrypted credentials at rest
  desktop.log         # Backend startup, route, and diagnostic log (rotated per launch)
  preferences.json    # Desktop window, theme, and sidebar preferences (mode 0o600)
  electron/           # Chromium profile, cache, and Local Storage (mode 0o700)
  voice/              # On-device Parakeet ASR model weights (downloaded on demand)
```

To open this directory directly on macOS, choose **Sumi → Show Journal Data** from the native application menu bar.

### Manual Backups & Data Preservation

- **Safe Backups**: To back up your trading journal, quit Sumi completely and copy the **entire data folder**, including the hidden `.secret` file. Never delete, overwrite, or merge an existing journal directory.
- **Preservation Across Upgrades**: The `journal.db` SQLite database, attachments, and `.secret` key are preserved directly across versions. Existing v0.2.0 installations and data remain untouched until you explicitly install and open the new version.
- **Preferences Migration**: On initial launch, if `preferences.json` is not present, Sumi imports existing desktop appearance and sidebar preferences prefixed with `journal-*` from macOS `UserDefaults` (`local.sumi.journal` `journalPreferences`). Preferences are written atomically with mode `0o600` under a 64KB aggregate bound.
- **Isolated Chromium Storage**: Chromium session data and local storage reside in `<data>/electron/` to ensure full isolation from system-wide browser sessions.

---

## Private Offline Voice Dictation

Sumi includes private, on-device voice dictation powered by `@transcribe-cpp` 0.4.1 across all target platforms:

- **macOS Apple Silicon (`arm64`)**: Native Metal GPU + CPU acceleration (`@transcribe-cpp/darwin-arm64-metal`).
- **macOS Intel (`x64`)**: Native CPU acceleration (`@transcribe-cpp/darwin-x64-cpu`).
- **Windows (`x64`)**: Native CPU + optional Vulkan acceleration (`@transcribe-cpp/win32-x64-cpu-vulkan`). Dedicated GPU is **NOT required**; CPU inference works out of the box.
- **Linux (`x64`)**: Native CPU + optional Vulkan acceleration (`@transcribe-cpp/linux-x64-cpu-vulkan`). Dedicated GPU is **NOT required**; CPU inference works out of the box.

### Model Weights Architecture

- **Bundled Voice Activity Detection (VAD)**: The lightweight Silero VAD model (`silero-vad-v6.2-F32.gguf`, ~1.2 MB) is bundled self-contained inside the application bundle at `models/silero-vad-v6.2-F32.gguf`.
- **External Speech Recognition (ASR) Weights**: Heavy Parakeet Unified EN 0.6B weights (~697 MiB / 731 MB GGUF Q8_0) are **never bundled** inside distribution packages. They are downloaded on demand or reused read-only from your existing local HuggingFace cache into user storage (`<User Data>/voice/`) only upon explicit user request in Settings.
- **Native ASR Doctor & CI Verification**: Verification tests (`pnpm desktop:check` via `desktop/check-support.mjs`) boot the bundled official Node runtime, load the packaged `transcribe-cpp` native library, run Silero VAD silence inference (512 float32 samples), and cleanly dispose of resources. This proves DLL/SO loading, FFI bindings, and runtime tensor calculation without requiring the full ~700MB Parakeet model download or full speech-to-text inference in Windows/Linux CI.

---

## Windows Packaging, Visual C++ CRT & Code Signing

### App-Local Visual C++ CRT DLLs

To ensure native modules (such as `transcribe.dll` and `ggml`) execute reliably on fresh Windows installations without requiring users to install the system-wide Microsoft Visual C++ Redistributable:

- The build script (`desktop/build.mjs`) automatically locates official Microsoft Visual C++ 14.x x64 CRT DLLs (`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`) via `vswhere` or `VCToolsRedistDir`.
- These DLLs are bundled directly into `resources/runtime/` and `@transcribe-cpp/win32-x64-cpu-vulkan/`.
- Required redistribution terms and provenance notices are preserved in `licenses/` and `THIRD-PARTY-NOTICES.md`.

### Code Signing & First-Launch Security Notices

Sumi is distributed independently without paid code-signing certificates:

- **macOS**: Ad-hoc signed (`codesign --sign -`) with Apple Hardened Runtime entitlements (JIT, unsigned executable memory, and microphone capture). On first launch, if Gatekeeper displays a security notice:
  1. In Finder, **Right-Click (Control-Click)** on `Sumi.app` and choose **Open**.
  2. Click **Open** in the macOS confirmation dialog.
  3. Alternatively, open **System Settings → Privacy & Security** and click **Open Anyway**.
- **Windows**: Unsigned (no Authenticode certificate). Windows Defender SmartScreen may display an "Unrecognized app" prompt on first launch:
  1. Click **More info**.
  2. Click **Run anyway**.
- **Linux**: Install via `.deb` using standard system package tools (`sudo apt install ./Sumi-0.3.3-linux-x64.deb`).

_(Note: Managed enterprise workstations governed by strict corporate MDM profiles requiring commercial code signing may restrict ad-hoc binaries.)_

---

## In-App Updates

Sumi coordinates updates using platform-native update mechanisms:

### macOS: Native Sparkle 2.9.6

- **Framework**: Sparkle 2.9.6 via `electron-sparkle` (0.2.0).
- **Cryptographic Signatures**: Update archives are signed using Ed25519 keys. The public key (`SUPublicEDKey`) is bundled in `Info.plist`. The private signing key (`SPARKLE_PRIVATE_KEY`) resides strictly in GitHub Actions secrets and is never included in the repository.
- **Update Feeds**:
  - Apple Silicon (`arm64`): `https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml`
  - Intel (`x64`): `https://github.com/xolah88457/trade-journal/releases/latest/download/appcast-x64.xml`
- **Flow**: Check for updates in **Settings → About & licenses**. Sparkle downloads the update, verifies the Ed25519 signature, shuts down the backend cleanly, and applies an atomic update.

### Windows & Linux: `electron-updater` 6.8.11

- **Framework**: `electron-updater` 6.8.11 coordinating native dialogs.
- **Manual Consent Policy**: Updates are never downloaded automatically in the background on startup.
- **Two-Stage User Consent**:
  1. **Download Consent**: Clicking "Check for updates" displays a native dialog when a newer version is found, prompting the user to download.
  2. **Install & Restart Consent**: Once downloaded and verified, a prompt asks whether to restart and apply the update now or later.
- **Safe Backend Shutdown**: The supervisor gracefully terminates the backend Node server before invoking `quitAndInstall()`.
- **Package Integration**:
  - Linux `.deb` installs utilize standard Debian polkit authorization for package updates.
  - Linux `.AppImage` installs replace the running AppImage file.
  - Portable tarballs / unpacked installs do not self-update and honestly display manual update guidance.

_Update Testing Notice_: Feed generation, updater contracts, and shutdown hooks are verified via automated unit and packaging tests; first real in-place upgrade transitions across all production platforms will be confirmed upon subsequent version releases.

---

## Packaging & Releases

Packaging for distribution produces platform-specific installers, standalone archives, and cryptographic checksums:

```sh
# Package release artifacts
pnpm desktop:package
```

### Generated Artifacts in `dist/`

- **macOS**:
  - `dist/Sumi-0.3.3-macos-arm64.dmg` & `dist/Sumi-0.3.3-macos-arm64.zip`
  - `dist/Sumi-0.3.3-macos-x64.dmg` & `dist/Sumi-0.3.3-macos-x64.zip`
  - `dist/appcast.xml` (Apple Silicon feed) & `dist/appcast-x64.xml` (Intel feed)
- **Windows**:
  - `dist/Sumi-0.3.3-win32-x64-setup.exe` (NSIS installer)
  - `dist/Sumi-0.3.3-win32-x64.zip` (Portable standalone zip)
- **Linux**:
  - `dist/Sumi-0.3.3-linux-x64.deb` (Debian/Ubuntu package, primary)
  - `dist/Sumi-0.3.3-linux-x64.AppImage` (Standalone AppImage, secondary)
- **Checksums**:
  - `dist/SHA256SUMS.txt` (SHA-256 hashes of all release artifacts)

### GitHub Release Workflow

Automated via `.github/workflows/electron-release.yml`:

- **Triggers**: Pushes to the `electron` branch run build, verification, and smoke checks only; publishing runs strictly on tags matching `electron-v*` (e.g. `electron-v0.3.3`). There is no manual `workflow_dispatch` trigger.
- **Ancestry & Version Verification**: Enforces that the release commit is an ancestor of `origin/electron` and verifies tag version parity with root `package.json`.
- **Artifact Isolation**: Publishes strictly verified binaries, installers, feeds, and checksums. Development caches, `.env` files, databases, and heavy model weights are strictly blocked from release assets.
- **CI Publishing Policy**: The main branch and official releases publish only after all native platform build and verification jobs pass.

---

## Automated Verification & Checks

Run the complete test suite before cutting releases or committing changes:

```sh
# Run core unit and integration tests
pnpm test

# Run TypeScript checks across all workspaces
pnpm typecheck

# Run Electron desktop check (verifies signing, symlinks, routes, ASR doctor, and SQLite persistence)
pnpm desktop:check
```

The desktop verification suite launches an isolated backend on an ephemeral port in a clean temporary directory, validates license compliance, tests account creation and SQLite restarts, verifies native ASR silence detection, and ensures no private files, databases, or heavy weights are packaged.

### Build tooling layout

`build.mjs`, `package.mjs`, `release.mjs`, `open.mjs`, `check-support.mjs` and `cross-platform-smoke.mjs` are build-time scripts and are never copied into the app. Helpers they share (architecture normalisation, root version, SHA-256, private-file and symlink-confinement checks, verified archive download, DLL version probing) live in `desktop/lib/common.mjs`. `node desktop/check-support.mjs` runs the verifier unit tests in `desktop/check-support.test.mjs`; all desktop tests run with `node --test desktop/*.test.mjs` (four `check.test.mjs` integration tests additionally need a built `dist/`).

---

## Features & Local Operations

- **Local-First Trading Journal**: Manual trade entries, plan targets, screenshot galleries, and daily reports are persisted directly to `journal.db`.
- **Private On-Device Voice Dictation**: Speech is captured via microphone and transcribed locally on Metal GPU / CPU using Parakeet Unified EN 0.6B and Silero VAD (transcribe-cpp bindings). Heavy weights (~697 MiB) reside outside the app in user storage, while lightweight Silero VAD (1.2 MB) is bundled self-contained.
- **Daily Review Exports**: Generates paginated daily review PDFs and PNG archives rendered 100% locally on-device.
- **AI Reflection**: Optional remote AI reflection (Ask Journal, Daily Recap, Trade Critique) with context preview dialogs. Configurable in **Settings → AI**.
- **Offline Attribution & Licenses**: View upstream MIT licenses, Node, Electron, Chromium, and dependency licenses anytime in **Settings → About & licenses**.
