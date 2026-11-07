# Sumi for macOS

Sumi keeps LuxAlgo's journal screens, importers, analytics, SQLite storage, and optional integrations. The interface adapts Kami's parchment, ivory, warm charcoal, navy, and editorial typography. The original repositories remain separate: the journal is the application base; Kami is a visual reference, not a second backend.

## Build and open

Requirements for building: macOS 13 or newer, Node 22 or newer, pnpm (this repository pins 11.0.8), and Apple's Command Line Tools (`xcode-select --install` if not installed). Internet access is required to install dependencies and download the official Node runtime during the build.

From `trade-journal-main/`:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build
pnpm desktop:check
pnpm desktop:open
```

The result is `dist/Sumi.app`. Double-click it in Finder, or copy it into your Applications folder. Once built, the app needs neither your development checkout nor a separately installed Node, pnpm, Docker, or browser. Quit Sumi before rebuilding or replacing the app. This build targets the Mac architecture it is built on (Apple Silicon on this machine); it is not a universal binary.

The app is ad-hoc signed for local use, not Apple-notarized. A downloaded or shared copy may trigger Gatekeeper; use Finder's **Open** or **System Settings → Privacy & Security → Open Anyway** only if you trust your build. Public distribution requires your own Developer ID signing and notarization.

## Where your data lives

```text
~/Library/Application Support/Sumi/
  journal.db       SQLite journal
  .secret          generated encryption key (when credentials are saved)
  desktop.log      backend startup and error log, replaced each launch
```

Use **Sumi → Show Journal Data** to open this folder. Back up the **entire folder while the application is quit**, including hidden `.secret` and any attachments/subdirectories. The database alone is not a complete backup if you use encrypted credentials or attachments. Rebuilding/replacing the `.app` does not replace your journal.

A fresh desktop install starts a new journal. Existing browser/Docker journals are **not automatically moved or overwritten**. To migrate one, quit both applications, back up both folders, then copy the full existing data directory (including hidden files and attachment folders) into the Sumi data folder. Do not merge two databases. If the previous journal used `JOURNAL_SECRET`, clear/re-enter its integration credentials after migration: the desktop app uses the generated `.secret` file rather than shell environment keys.

Theme, privacy, sidebar, and dashboard preferences are saved in macOS preferences and restored across launches, even though the loopback port changes. Existing browser appearance preferences are not imported. New installs use the light parchment theme; the sidebar appearance control switches to warm charcoal.

## Local and online behavior

- A native Cocoa window embeds Apple's WebKit. There is no browser tab and no Electron/Chromium dependency.
- A bundled Node process serves the full Next.js app on an OS-assigned port bound **only to `127.0.0.1`**. Quitting Sumi shuts down that process. As with other localhost tools, other processes running as your user can access this local service; it is not a hardened multi-user server.
- SQLite and attachments stay on this Mac. No journal or environment files are included in the `.app` build.
- Manual entry, journaling, local analytics, and file imports work without broker/AI subscriptions.
- Broker sync, remote market data, and remote AI require a network connection and your own provider configuration. Enter credentials in Settings; Finder apps do not inherit your terminal's API-key environment variables.
- **Local on-device voice dictation**: Sumi integrates an on-device local voice runtime powered by Parakeet Unified EN 0.6B ASR and Silero VAD (transcribe.cpp bindings on Metal GPU / CPU). Voice dictation is honest batch dictation: speech is captured locally and transcribed upon clicking Stop (no live per-word cloud streaming requirement). A lightweight Silero VAD gate filters out silence before ASR and detects natural pauses so the heavier ASR engine remains idle during silence. For long notes up to 5 minutes, audio is segmented into bounded ~30s chunks at pauses and transcribed sequentially with cancellation support.
- **Native microphone permissions**: Microphone capture is controlled by WebKit `WKUIDelegate` media capture permissions (strictly granted only to the local main frame loopback origin and denying camera capture). macOS system-level microphone permission is enforced via `NSMicrophoneUsageDescription`.
- **Model storage & privacy**: ASR model weights are stored outside `Sumi.app` in user storage (`~/Library/Application Support/Sumi/voice`) or reused read-only from your existing local HuggingFace cache. The lightweight Silero VAD asset (1.2 MB, MIT license) is bundled self-contained inside the application. Dictation audio is ephemeral in memory; the voice backend does not log or store audio recordings or standalone transcript artifacts. Inserted text placed into editor fields follows normal journal note persistence when saved by the user.
- **AI reflection & personal instructions**: Optional remote AI features (Ask Journal, Daily Recap, and Trade Critique) can be configured in **Settings → AI**. You can define personal trading instructions (up to 2,000 characters) grounded in your journal data. Reflection requests require explicit user confirmation through a context preview dialog showing the exact prompt, provider, and sanitized endpoint before any external call is dispatched; modifications to instructions or scopes require clicking Refresh to prevent prompt drift. Local voice dictation operates completely independently of remote AI features and requires no API keys or network access.
- Native file pickers handle imports; exports use a macOS Save dialog. External website links open in your default browser, not inside the journal.
- No auto-updater, cloud sync, Windows/Linux wrapper, or automatic data migration is included.

## Manual trades & screenshots

- **Arbitrary text symbols & non-live prices**: Enter any text symbol/ticker (e.g., stocks, crypto, forex, futures) and historical or custom execution prices. No live feeds or broker connections are required.
- **Local defaults & actionable errors**: Forms default to device-local timestamps, default quantity of 1, fee of 0, and automatically pre-select your first manual account. Clear validation errors highlight invalid fields without silent disablement. Submitting a new manual trade form won't silently merge with an existing open trade for the same account and symbol; close the open trade first or select a different account.
- **Plans vs fills**: Target prices (Stop loss and Take profit) are stored as trade plans, not simulated fills. They define planned risk and targets without affecting portfolio accounting until an actual exit fill occurs.
- **Selectable outcomes**: For manual trades, select between keeping the position **Open**, hitting **Stop loss**, hitting **Take profit**, or exiting at **Break even**. Selecting a hit target visually greys out the unhit target while retaining both prices. Break-even exits record an exit at exact entry price (0 gross P&L before fees) without falsifying net transaction fees.
- **Per-trade screenshot gallery**: Upload trade screenshots and charts directly on the trade detail page (up to 8 MB per file; PNG, JPEG, and WebP supported). Attachments and existing PDF docs remain accessible locally.
- **No embedded LuxAlgo live chart**: The trade detail view uses local performance graphics and attachment galleries; it does not embed external LuxAlgo live streaming charts.
- **Persistent storage**: All manual trades, plans, executions, notes, and metadata are saved locally to your existing `journal.db` database.

## Checks

```sh
pnpm test                # journal/core/importer tests
pnpm typecheck           # TypeScript checks
pnpm desktop:check       # built bundle, signing, clean packaging, routes, SQLite restart persistence
```

Desktop checks create and remove a separate temporary journal. They never use your real Sumi data. Rebuild after source changes before running them. The bundled official Node binary is checksum-verified and matches the build-time Node version, so the `better-sqlite3` native module uses the correct ABI without relying on Homebrew dynamic libraries.

## Attribution

LuxAlgo's MIT license and trademark policy are retained. Sumi uses an independent name and mark. Kami's MIT license is retained in `Kami-LICENSE.txt`. The built app includes upstream, Node, and dependency notices in `Contents/Resources/licenses/`; see `THIRD-PARTY-NOTICES.md`. No remotely hosted Kami fonts or logos are used.
