<p align="center">
  <img src="./codlogs.png" alt="codlogs" width="500">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=000000" alt="React">
  <img src="https://img.shields.io/badge/Electrobun-Desktop-7A5CFA" alt="Electrobun">
  <img src="https://img.shields.io/badge/@tobitege-000000?logo=x&logoColor=white" alt="X @tobitege">
</p>

# codlogs

`codlogs` is a read-only Codex session tool with two entry points:

- a global CLI for finding sessions and exporting one `.jsonl` session to Markdown or HTML
- an Electrobun desktop browser for scanning sessions, filtering by folder, and exporting the selected session to `.md` or `.html`

Planning and investigation artifacts for this repo live under `devlog/YYYY-MM-DD/`.

This repository uses Bun as its development package manager and commits `bun.lock`.
If you are working in this repo, use `bun install` instead of `npm install` or `pnpm install`.

## CLI

Install it globally from this folder:

```powershell
npm install -g d:\github\codlogs
```

Use either `codlogs` or `codlogs-sessions`:

```powershell
codlogs
codlogs d:\github\myDUDreamTool
codlogs /mnt/d/github/myDUDreamTool
codlogs --md C:\Users\tobitege\.codex\sessions\2026\03\06\session.jsonl
codlogs --html C:\Users\tobitege\.codex\sessions\2026\03\06\session.jsonl
codlogs --md C:\Users\tobitege\.codex\sessions\2026\03\06\session.jsonl --include-images --include-tool-results
```

Notes:

- the folder argument is optional; if omitted, the current working directory is used
- if the folder is inside a git repo, the CLI matches sessions for the repo root by default
- use `--cwd-only` to match only the folder tree you pass in
- use `--codex-home PATH` if your Codex data lives somewhere other than `%CODEX_HOME%` or `~/.codex`
- use `--include-images` with `--md` or `--html` to write embedded images into a sibling `.assets` folder
- use `--html` to export a session as a self-contained HTML transcript
- use `--include-tool-results` with `--md` or `--html` to include tool calls and tool outputs in the export
- Windows drive paths, WSL `/mnt/<drive>/...` paths, and WSL UNC paths are treated as aliases of the same repo

## Desktop App

The desktop browser uses [Electrobun](https://electrobun.dev/).

Prerequisites:

- Bun `>=1.3.9`
- Windows 11+ with WebView2 available for the embedded webview runtime

Run it locally:

```powershell
bun install
bun run start
```

For live UI reload while editing:

```powershell
bun run dev:hmr
```

Other useful commands:

```powershell
bun run build:web
bun run build
```

Notes:

- `bun run start` is the easiest local launch path because it builds the web assets first
- the first Electrobun run downloads its platform-specific core binaries
- the app defaults to the current folder tree on launch
