# Progress

- Exported existing sessions with `opencode session export` (OpenCode 2.3.0) and read the importer and its schema in `anomalyco/opencode` at tag `v2.3.0` to learn the session file format.
- Added `src/shared/opencode-session.ts`: a converter from Codex rollout rows to OpenCode messages, without file access.
- Added `exportSessionJsonlToOpenCode` to `codlogs-core.ts`. It runs in the existing streaming export pipeline, so the file is published only when complete and a cancelled export keeps an earlier file.
- Moved the rule that hides instructions and the bootstrap context into `isHiddenExportMessage`, used by all three formats.
- Added `--opencode FILE` to the CLI and `Export OpenCode` to the desktop app (`startSessionOpenCodeExport` RPC).
- Added nine regression tests, including one that checks the output against the importer's requirements and one for the Node CLI.
- Documented the export in the README and set the version to 1.5.0.
- Fixed message times in the OpenCode export for a session whose metadata has no start time: every time was raised to the modification time of the session file. Found while porting the export to clodlogs; covered by a regression test.
- Left the rows that the Codex app writes when one of its pages is opened (`<external_codex_apps_open_page>`, 16 rows in 33 local sessions) out of every export format and out of the prompt count. Codex stores them as user messages, so they were exported as prompts and counted as prompts. The rule sits in `isHiddenExportMessage`, which all three formats use. Covered by a regression test.
- Merged the four open Dependabot branches into this branch (Electrobun 2.0.6, React and React DOM 19.3.1, @types/bun 1.4.4), so they are released with 1.5.0. All four versions are older than the seven-day minimum release age.

## Checks

- `bun run typecheck`: passed.
- `bun run test`: 66 tests passed.
- `bun run build:web`: passed.
- Round trip against the real importer: all 44 Codex sessions on this machine (up to 40 MB as a session file, 1096 model responses, 1017 tool calls, 25 images) were exported with images and tool calls, imported with `opencode session import` 2.3.0 into a separate OpenCode data directory, and exported again with `opencode session export`. Messages, title and token totals were identical in every case.
- After the dependency updates: `bun install --frozen-lockfile`, typecheck, tests, web build and the CLI check passed, and the desktop app started with Electrobun 2.0.6, listed all sessions with `Show All` and showed the `Export OpenCode` button.

## Not checked

- The session view in the OpenCode desktop or web interface.
- Continuing an imported session with a model in OpenCode.
- An export started from the buttons of the running desktop app.
- The packaged stable desktop bundle (`electrobun build --env=stable`); CI builds it.
