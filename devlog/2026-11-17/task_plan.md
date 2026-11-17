# OpenCode session export

Goal: export a Codex session as a session file that `opencode session import` of OpenCode 2 accepts, as a third export format beside Markdown and HTML.

- Learn the OpenCode 2 session file format from a real `opencode session export` and from the importer's schema.
- Add a converter from Codex rollout rows to OpenCode messages (`src/shared/opencode-session.ts`).
- Drive it from the existing streaming export pipeline in `codlogs-core.ts` (atomic publish, progress, cancellation).
- Add `--opencode FILE` to the CLI and `Export OpenCode` to the desktop app.
- Add regression tests, document the format in the README, bump the version to 1.5.0.
- Check the result against the real OpenCode 2.3.0 importer with real Codex sessions.

Status: Complete.
