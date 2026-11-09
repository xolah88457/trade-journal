# Sumi

Sumi is a local-first desktop trading journal for macOS, Windows and Linux. Your trades, notes and attachments live in a SQLite database on your own machine. Sumi imports broker statements or syncs read-only from supported brokers, rebuilds your fills into round-trip trades, and gives you analytics, a daily journal, prop firm cost tracking and optional AI reflection.

Sumi is based on [LuxAlgo's open-source trade-journal](https://github.com/LuxAlgo/trade-journal) (MIT). See [Attribution and license](#attribution-and-license).

<img src=".github/assets/screenshot-dashboard.png" alt="Sumi dashboard with demo trades: net P&L, win rate, Edge Score radar, cumulative and daily P&L charts" width="100%" />

## Features

### Getting trades in

- **Broker sync**: read-only API sync through [`@luxalgo/broker-sdk`](https://github.com/LuxAlgo/broker-sdk) for Alpaca, Binance, Bybit, Coinbase, Kraken, OKX, Tradier, IBKR Flex, Hyperliquid, Questrade, Topstep, Trading212, Webull, Crypto.com, E\*TRADE, Public, Charles Schwab, TradeStation, tastytrade, Robinhood Crypto, Gemini and KuCoin. Keys are encrypted on your machine; **Sync now** per account.
- **Statement import**: CSV, TSV, HTML, XML and Excel files with automatic format detection for TradeZella, Tradervue, TradingView (paper history and strategy list), MetaTrader 4 and 5, Interactive Brokers (activity CSV, Flex Query, Flex XML), ThinkorSwim/Schwab, NinjaTrader, Tradovate, TopstepX, Webull, DAS Trader Pro, XTB xStation and Hyperliquid. See [docs/importers.md](docs/importers.md).
- **Column mapper**: map the columns of any other CSV yourself.
- **AI statement parsing (optional)**: read unsupported statements, including PDFs, with your own AI key.
- **Import preview**: check the parsed executions before importing, set the statement time zone, and choose or create the target account for multi-account files.
- **Duplicate protection**: re-importing the same fills is ignored.
- **Manual trade entry**: add a trade with side, quantity, entry/exit, fees, stop loss, take profit, outcome (open, stop hit, target hit, breakeven) and notes, or add raw executions.
- **Demo data**: load about 90 days of generated trades to explore the app.

### Accounts

- File-import, manual and broker-synced accounts, each with a currency and starting balance.
- FIFO, LIFO or weighted-average matching per account.
- Archive, unarchive, clear all trades, delete, or transfer all data into another account.
- Quick account switcher on every screen; the Filters panel selects several accounts at once.

### Dashboard

- Cards: Net P&L, trade win %, profit factor, day win %, average win/loss, Edge Score, cumulative P&L, daily P&L, month calendar, recent trades and open positions, max drawdown, streaks, expectancy per trade, average duration, best/worst day and trade time performance.
- Drag cards to rearrange them, show or hide cards, and search for cards.
- Save named layouts or use the Overview, Trading day, Performance and Risk review presets.
- Add a trade straight from the dashboard.
- Accounts in different currencies are summarized per currency.

### Calendar

- Monthly P&L calendar with weekly totals.
- Hover a day for its trades and running P&L.
- Insights: net P&L, trade win rate, average daily P&L, day consistency, best and worst day, average green and red day, a daily performance chart and performance by weekday. See [docs/calendar-insights.md](docs/calendar-insights.md).

### Trades

- Trade table with sorting, a column picker and running totals (net cumulative P&L, win %, profit factor, average win/loss).
- Bulk actions: mark reviewed or unreviewed, add a tag, delete.
- Export the filtered trades to CSV.
- **Trade detail**: executions, average entry and exit, gross and net P&L, fees, net ROI, duration, volume, planned and realized R, and a running P&L chart.
- Planned stop loss and take profit, with stop or target hit detection.
- Close an open position by entering an exit.
- Tags, mistakes, playbook assignment, a 1 to 5 star rating and reviewed status.
- Playbook rule checklist per trade: followed, broken or not assessed.
- Trade notes in the Markdown editor.
- **Screenshots**: drag and drop or upload chart screenshots (PNG, JPEG, WebP) into a gallery with full-size view. Download any screenshot again with its Download button or by right-clicking it. PDFs and other documents can be attached too.
- Previous and next trade navigation, within all trades, the current filters or the same account.
- Delete a single trade from its detail page, with its executions, notes, screenshots and AI reviews.

### Filters

- Applies to the dashboard, calendar, trades and reports.
- Filter by date range, weekday, accounts, symbols, excluded symbols, direction, asset class, outcome, strategy, tags, mistakes, review status and rating.
- Filter by entry and exit time, size, entry and exit price, minutes held, net P&L, and planned or realized R.

### Daily journal

- List of trading days with their results.
- Each day shows day stats (net and gross P&L, trades, winners and losers, win rate, volume, profit factor, expectancy), an intraday cumulative P&L chart and the day's trades.
- Day note in the Markdown editor, with screenshots and attachments.
- Delete a day's journal: its note and attachments go, its trades stay.
- AI session recap (optional), from the day's trades or, on a day without trades, from the day note.

### Notebook

- Free-form Markdown notes organized into folders, with search.
- Create and delete folders, and drag folders to reorder them.
- Attachments on notes.

### Note editor (journal, trades, notebook, missed trades)

- Markdown with headings, bold, italic, bullet lists and checklists, plus a preview mode.
- Link a trade into a note by searching symbol, date or account.
- Note templates: built-in Pre-market plan, Trade review and Weekly review, plus your own saved templates.
- Autosave.
- Voice dictation into any note.

### Playbooks

- Strategies with a description and a rule list.
- Rule adherence report: performance when all rules were followed versus when at least one was broken, and performance by rule.

### Progress

- Daily routines scheduled by weekday for before, during and after trading.
- Tick off each day's routines.
- Daily completion score and a 13-week completion heatmap.

### Missed trades

- Log missed opportunities with symbol, direction, strategy, planned entry, stop and target, observation time and a review note.
- Search, edit, archive and restore entries, and attach screenshots.

### Reports

- **Overview**: trading overview plus breakdowns by symbol, tag, mistake, playbook, weekday, holding time, long vs short and opening hour.
- **Performance trends**: rolling 20-trade win-rate and average P&L trends, with the largest winner and loser. See [docs/performance-trends.md](docs/performance-trends.md).
- **Trade explorer**: scatter plots of holding time, entry time, MAE, MFE, net P&L and realized R, with presets. See [docs/trade-explorer.md](docs/trade-explorer.md).
- **Breakdowns and cross-analysis**: group by one or two of symbol, strategy, tag, mistake, direction, asset class, weekday, month, entry or exit hour, 15-minute entry or exit slot, holding time, position size and entry price.
- **Compare groups**: two filter sets side by side.
- **MAE and MFE estimates** from market data (see [below](#market-data)).
- **Edge Score**: a 0 to 100 score from win %, profit factor, average win/loss, drawdown, recovery and consistency. See [docs/edge-score.md](docs/edge-score.md).

### Exporting

- **Daily journal report and trade report**: multi-page PDF or PNG with the day overview or trade summary, executions, notes and chart screenshots. Preview pages and choose which to include. A day without trades shows a flat equity curve at zero.
- **Review exports**: PDF or PNG of reports, the notebook, missed trades and progress.
- **Data**: full journal backup as JSON, all trades as CSV.
- Exports respect privacy mode.

### Prop firm tracker

- Overview, Accounts, Payouts and Transactions views.
- Track prop accounts through evaluation, verification, funded, instant-funded and live phases, with linked attempts and resets.
- Expenses in eight categories (evaluation, reset, activation, subscription, platform, market data, transfer, other), shared firm costs and partial refunds.
- Payout requests with trader split, withheld fees, status and expected date. Record partial receipts and reversals, with overdue flags.
- Money spent, payouts received, net after costs and cash ROI.
- Monthly spending vs payouts chart, cumulative net cash, firm returns, expense breakdown, account progress and pass rate.
- Renewal reminders for the next 30 days and overdue ones.
- Filter by firm, account, currency and dates.
- Search records.
- Every edit records a reason; void and restore entries; edit history.
- Attach invoices and payout proof.
- Import and export prop cash records as CSV.
- Read-only demo preview.
- Kept separate from trade P&L. See [docs/prop-firms.md](docs/prop-firms.md).

### AI reflection (optional)

- Ask your journal questions in plain language.
- Session recaps for a day and critiques of a single trade. A day with no closed trades can be recapped from its note.
- **Tidy up**: a button next to Dictate rewrites a dictated or typed note into clean, structured writing. Nothing changes until you choose Replace note, and you can undo it.
- Every request shows a preview of exactly what will be sent before it goes out.
- Use your own Anthropic or OpenAI key or an OpenAI-compatible server, choose the model, and add personal trading instructions.
- **Free to start**: one-click setup for OpenRouter (`openrouter/free`) or Groq (`openai/gpt-oss-120b`) with a free API key, no API fees. Free plans are rate-limited, and free models may log prompts.
- Configure it in **Settings → AI**. See [docs/ai-scope.md](docs/ai-scope.md).

### Offline voice dictation

- Dictate into notes, trade entries, playbooks and prop records with on-device speech recognition. No audio leaves your machine (see [below](#offline-voice-dictation)).
- Press **Tidy up** afterwards to have your AI provider turn the transcript into cleaner writing (optional; it sends the note text only after you confirm the preview).

### Settings

- **General**: display and default import time zones.
- **Trading**: contract multipliers, breakeven range, default fees and default stop and target distances.
- **Currency conversion**: reporting currency with saved exchange rates for combined results.
- **Market data**: provider connections or uploaded candle CSVs.
- **AI**: provider, model, key and personal instructions.
- **Data and backups**: JSON and CSV export.
- **About and licenses**: licenses, and checking for updates in the desktop app.

### Privacy and appearance

- Privacy mode hides balances, P&L and prices everywhere.
- Light and dark themes.
- Collapsible sidebar and a layout that works on narrow windows.
- Optional password for the web version.

### Desktop app

- Native app for macOS, Windows and Linux; everything is stored in a local SQLite database.
- In-app updates.
- **Show Journal Data** menu item opens the data folder.
- Window, theme and sidebar preferences are remembered.

## Screenshots

Captured from the app with generated demo data and fictional prop firm records.

<details>
<summary><strong>Calendar</strong></summary>
<img src=".github/assets/screenshot-calendar.png" alt="P&L calendar with daily results, weekly totals and performance insights" width="100%" />
</details>

<details>
<summary><strong>Trade detail</strong></summary>
<img src=".github/assets/screenshot-trade.png" alt="Trade detail with P&L summary, executions, running P&L and trade review controls" width="100%" />
</details>

<details>
<summary><strong>Daily journal</strong></summary>
<img src=".github/assets/screenshot-journal.png" alt="Daily journal with day stats, intraday P&L, the day's trades and a notes editor" width="100%" />
</details>

<details>
<summary><strong>Reports</strong></summary>
<img src=".github/assets/screenshot-reports.png" alt="Reports overview with trade time performance and breakdowns by symbol and direction" width="100%" />
</details>

<details>
<summary><strong>Prop firms</strong></summary>
<img src=".github/assets/screenshot-prop-firms.png" alt="Prop firm demo preview with money spent, payouts received and monthly cash flow" width="100%" />
</details>

## Install

Sumi ships as a desktop app:

| Platform | Architectures                | Packages                  | In-app updates                             |
| -------- | ---------------------------- | ------------------------- | ------------------------------------------ |
| macOS 14 | Apple Silicon (arm64), Intel | `.dmg`, `.zip`            | Sparkle                                    |
| Windows  | x64 (10/11)                  | NSIS `.exe`, portable zip | electron-updater                           |
| Linux    | x64 (glibc 2.35+)            | `.deb`, `.AppImage`       | electron-updater (not for unpacked builds) |

Release builds are produced by CI from `electron-v*` tags and published to this repository's [GitHub Releases](https://github.com/xolah88457/trade-journal/releases). Builds are not code-signed, so macOS Gatekeeper and Windows SmartScreen show a first-launch warning. Build steps, first-launch instructions, data locations, backups and the update system are documented in **[desktop/README.md](desktop/README.md)**.

## Develop

Requirements: Node 22+ and pnpm 11.0.8 (pinned in `package.json`). Desktop builds additionally pin Node 26.13.0; see [desktop/README.md](desktop/README.md).

```bash
git clone https://github.com/xolah88457/trade-journal
cd trade-journal
pnpm install --frozen-lockfile
pnpm dev   # web app at http://localhost:3000
```

The first run creates a SQLite database in `apps/web/data/` and applies schema upgrades automatically. On an empty dashboard choose **Load demo data** for about 90 days of generated trades, or import [`docs/samples/demo-trades-tradingview.csv`](docs/samples/demo-trades-tradingview.csv) from **Import → File upload**. `pnpm preview` builds and serves the production web app instead.

```bash
pnpm test          # vitest across packages and the app
pnpm typecheck     # all workspaces
pnpm format:check  # prettier
pnpm desktop:build # build the desktop app (see desktop/README.md)
```

When running the web app directly, these optional environment variables apply (set them in the shell or `apps/web/.env.local`; see [`.env.example`](.env.example)):

| Variable                                 | Effect                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `JOURNAL_DATA_DIR`                       | Database, attachments and key directory (default `./data` of the app) |
| `JOURNAL_PASSWORD`                       | Require a password to open the web app                                |
| `JOURNAL_SECRET`                         | Encryption key source for credentials at rest                         |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`   | AI keys via the environment instead of Settings                       |
| `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | Route AI requests through a gateway or proxy                          |

The desktop app starts its backend with a restricted environment (only `JOURNAL_DATA_DIR` among these); enter AI and market-data keys in Settings.

## How it works

A raw **execution** (fill) is the one primitive. Executions arrive from broker sync, statement imports or manual entry; the round-trip engine turns them into trades; every screen reads from there.

```text
broker sync / statement import / manual entry
        -> executions (deduplicated fills)
        -> round-trip engine (FIFO / LIFO / WAVG)
        -> dashboard, calendar, journal, reports, Edge Score, AI reflection
```

## Market data

Market data is optional and used only for the MAE/MFE excursion estimates of closed trades in **Reports → Trade explorer**. Opening a trade or Reports never contacts a provider by itself.

Configure a source in **Settings → Market data**: London Strategic Edge, Alpaca or OANDA (free API keys are available), the public Binance or Coinbase endpoints (no key), or upload local candle CSV files. Keys are encrypted at rest. MAE/MFE are estimates from observed candles and executions, not tick-perfect values. Provider setup, the CSV schema, calculation definitions and limits are in [docs/market-data.md](docs/market-data.md).

## Offline voice dictation

The **Dictate** button in note editors transcribes speech on your machine; no audio is sent to a cloud service. It uses [`transcribe-cpp`](https://www.npmjs.com/package/transcribe-cpp) with the Parakeet Unified EN 0.6B speech model and a Silero voice-activity-detection model. The small VAD model is bundled in [`models/`](models). The large speech model (about 700 MB) is not bundled; Sumi downloads it on request into the data folder under `voice/`. See [desktop/README.md](desktop/README.md) for platform details.

## Monorepo layout

| Path                                       | What it is                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [`apps/web`](apps/web)                     | The app: Next.js 15, SQLite (Drizzle), Tailwind, Recharts, TanStack Table, ai-sdk          |
| [`packages/core`](packages/core)           | Private workspace package: pure domain engine (round trips, metrics, calendar, Edge Score) |
| [`packages/importers`](packages/importers) | Private workspace package: statement parsers and migration importers                       |
| [`desktop`](desktop)                       | Electron shell, packaging, update and verification scripts                                 |

## Disclaimer

Sumi reports and analyzes what your broker reports. Nothing it computes or generates, including AI output, is investment advice, and no metric predicts future results. Verify important numbers against your broker's statements.

## Attribution and license

Sumi is an independent project based on [LuxAlgo's open-source trade-journal](https://github.com/LuxAlgo/trade-journal), which is released under the MIT license. Sumi is not affiliated with or endorsed by LuxAlgo. Its visual style is inspired by Tw93's Kami. Sumi's additions and the original code are distributed under the [MIT License](LICENSE), which retains the original copyright notice (© LuxAlgo Global, LLC). The LuxAlgo name and marks are covered by the [trademark policy](TRADEMARKS.md). Third-party licenses are listed in **Settings → About & licenses** and in [desktop/THIRD-PARTY-NOTICES.md](desktop/THIRD-PARTY-NOTICES.md). Security reports: see [SECURITY.md](SECURITY.md).
