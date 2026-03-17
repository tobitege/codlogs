# Progress

- Started investigation of explicit-path rollout loading in `d:\github\codex-main`.
- Read `d:\github\codex-main\AGENTS.md`.
- Identified likely production entry points in `codex-rs/app-server/src/codex_message_processor.rs` and `codex-rs/core/src/rollout/recorder.rs`.
- Confirmed Codex rollout filenames are canonical `rollout-YYYY-MM-DDThh-mm-ss-<thread-id>.jsonl` and that `ThreadId::new()` is backed by UUIDv7 generation.
- Added a new sanitize modal option to re-add a sanitized copy into today's live Codex `sessions/YYYY/MM/DD` folder.
- Wired the sanitize RPC and Bun backend to accept `codexHome` plus `reAddToCurrentDay`.
- Added `src/shared/codex-rollout.ts` with helpers for:
  - canonical rollout timestamp formatting
  - UUIDv7 thread ID generation
  - current-day Codex session directory and rollout path creation
- Updated sanitized session writing so a single fresh thread ID is reused consistently in:
  - the canonical rollout filename
  - rewritten `session_meta.id`
  - the sanitization report
- Kept the existing temp-folder sanitized copy/report flow intact while allowing an additional live-session copy to be written in the same run.
- Avoided double-counting sanitization stats when both output targets are written during one sanitize job.
- Added regression coverage for the rollout naming helpers and re-ran the focused test suite plus TypeScript typecheck.
