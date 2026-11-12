# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Workflow status**: you can mark any session `backlog`, `wip` or `done`, and flag it **important**. This is separate from the classification tiers. It is stored in `metadata.json` and never in the JSONL.
  - Without a stored status, Keep and Review sessions default to Backlog. Suggested and Auto-delete sessions stay unsorted. The rule lives in one helper, `lib/status.js`.
  - CLI: `csesh status <id> <backlog|wip|done|clear>`, `csesh important <id> [on|off]`, `list --status/--important`, a STATUS column, and status in `--json`. The `resume` picker defaults to Backlog + WIP (`--all`, `--status`).
  - API: `POST /api/sessions/:id/status`, `POST /api/sessions/:id/important`, `POST /api/batch/status`, `POST /api/batch/important`, plus `GET /api/sessions?status=&important=`. Sessions include `status`, `statusExplicit` and `important`; `/api/stats` includes `statusCounts`.
  - Dashboard: it now opens on **My view** (WIP / Backlog / Done). Also added: status tabs, a Status card, a status column and sort, detail-view buttons, a batch Status menu, and the shortcuts `w`/`b`/`d`/`i`.
- **Remote machines**: csesh can pull a read-only copy of other machines' sessions over rsync + ssh. The machine list is in `~/.claude/tools/csesh/remotes.json`. Each machine can set `claude` to a wrapper command (e.g. `hclaude`) used when resuming its sessions.
  - Every session has a `host`.
  - CLI: `csesh remote list|add|rm|sync`, `list --host` with a HOST column, and `resume --host`. Remote sessions resume over `ssh -t`.
  - API: `GET/POST /api/remotes`, `DELETE /api/remotes/:name`, `POST /api/remotes/sync`, and `GET /api/sessions?host=`.
  - Dashboard: a Machines section with sync health, a Sync remotes button, a Machines dialog to add, remove and sync machines, and a host column and filter.

### Changed

- The dashboard loads all sessions; the old 5000 cap was raised.
- `j`/`k` row focus is tracked by row index, so group header rows don't throw it off.

### Safety

- Remote copies are excluded from `cleanup` and `rename`, and trash refuses them. `cleanup`, trash and classification of local sessions behave exactly as before.
- The remote-management endpoints accept only JSON from a localhost origin, so a web page cannot trigger ssh with a cross-site POST.

## [3.0.0] - 2026-02-28

### Changed (BREAKING)

- **Zero npm dependencies.** Removed chalk, cli-table3, and commander.
  - `lib/colors.js` — native ANSI escape codes with Proxy-based chaining (replaces chalk)
  - `lib/table.js` — UTF-8 box-drawing table formatter (replaces cli-table3)
  - `lib/cli.js` — CLI framework built on `util.parseArgs` (replaces commander)
- Node.js minimum version raised from 18.0 to 18.3 (required for `util.parseArgs`)
- `npm ls` now prints `(empty)` — zero transitive dependencies, zero supply chain vectors

### Added

- `lib/colors.js` (55 lines) — supports `c.bold.green('text')` chaining, respects `NO_COLOR` / `FORCE_COLOR`
- `lib/table.js` (120 lines) — fixed-width columns, word wrap, ANSI-aware truncation with ellipsis
- `lib/cli.js` (270 lines) — commands, nested subcommands, typed options, variadic arguments, auto-help

## [2.1.0] - 2026-02-28

### Added

- `csesh rename <id> <title>` — renames the JSONL slug field so sessions appear with the new name in `claude --resume`
- `lib/rename.js` — safe slug rewriter with backup (.bak) and atomic write (temp + rename)
- Rename feedback in web dashboard: toast shows "Renamed — visible in claude --resume"

## [2.0.2] - 2026-02-28

### Fixed

- Version display now dynamic — reads from package.json everywhere (CLI, dashboard footer, info modal)
- Collapsed sidebar footer no longer overflows
- Stat cards fit without horizontal scroll (reduced minmax to 130px)

## [2.0.1] - 2026-02-28

### Fixed

- Sidebar footer sticky (no more scrolling to see it)
- Auto-tags noise: removed generic tool tags (Bash, Read, Edit, Write, Glob, Grep), keyword tags require 2+ matches
- Keyboard shortcuts: Cmd+K focuses filter, Cmd+Enter focuses sidebar search (Mac AZERTY compatible)
- Back-to-dashboard button uses brand icon (was unclear triangle)
- Trash view now shows persistent tab bar and filters
- Tab order: All, Keep, Review, Suggested, Auto-delete, Trash, Favorites

## [2.0.0] - 2026-02-27

### Added

- Light/dark/auto theme toggle
- GitHub-style activity heatmap (365 days)
- Cost tracking: per session, per project, per day, weekly comparison with arrows
- `csesh cost` command with today/week/month/all-time + sparkline
- `csesh doctor` command for setup health check
- Auto-naming: "Fix login bug (Edit x8, Bash x3)"
- Keyboard shortcuts: Cmd+K command palette

### Changed

- Dashboard redesigned: 10 stat cards, persistent tab navigation, collapsible sidebar
- Sidebar footer: 2-row layout with centered action icons

## [1.1.0] - 2026-02-27

### Security

- Bundle Chart.js, marked, DOMPurify locally (removed CDN dependencies)
- Remove Google Fonts dependency (use system fonts)
- Bind server to 127.0.0.1 only (was exposed on LAN)
- Add 1MB request body size limit
- Fix CORS to strict localhost matching

### Added

- Streamer mode — blur sensitive info during screen recordings
- Batch trash and restore operations in web dashboard
- Logo click and 'g' keyboard shortcut to go to dashboard
- Enhanced stats: avg cost per session, cost by day, top files, thinking ratio
- Collapsible sidebar with localStorage persistence
- Tab-based tier filtering in dashboard

### Fixed

- XSS vulnerabilities in dashboard (DOMPurify sanitization)
- Navigation: sidebar collapse, project switching, back button
- Author email in package.json

## [1.0.0] - 2026-02-27

### Added

- CLI with 12 commands: list, show, analyze, search, stats, cleanup, resume, tag, title, export, web, trash, cache
- Interactive web dashboard with 6 charts and 9 stat cards
- 4-tier session classification engine
- Deep analysis: tool usage, thinking metrics, files touched, auto-tags, sub-agent detection
- Full-text search with project and date filtering
- Safe cleanup with trash/restore manifest
- Export as JSON, CSV, or Markdown
- Cost estimation with per-model token pricing
- Custom metadata: titles, tags, favorites, notes (sidecar, never modifies originals)
- Keyboard shortcuts (j/k navigation, /, Enter, Esc, f, t, ?)
- Skills.sh integration
- CI/CD with GitHub Actions and npm Trusted Publishing (OIDC)

[3.0.0]: https://github.com/ArthurPcd/csesh/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/ArthurPcd/csesh/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/ArthurPcd/csesh/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/ArthurPcd/csesh/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/ArthurPcd/csesh/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/ArthurPcd/csesh/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ArthurPcd/csesh/releases/tag/v1.0.0
