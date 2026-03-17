# Task Plan

## Goal
Identify concrete parsing and validation failure points in `d:\github\codex-main` when resuming or loading a rollout JSONL by explicit path, with emphasis on stripped or sanitized JSONL contents rather than file discovery.

## Steps
- [in_progress] Trace the explicit-path resume/load call chain.
- [pending] Inspect rollout JSONL parsing and validation functions.
- [pending] Summarize concrete failure conditions with file paths and line numbers.

## Notes
- Working from `d:\github\codex-main\codex-rs\app-server` into `d:\github\codex-main\codex-rs\core`.
