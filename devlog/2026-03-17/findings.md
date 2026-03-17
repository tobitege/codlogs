# Findings

- `thread/resume` with `params.path` flows through `codex_message_processor.rs` into `RolloutRecorder::get_rollout_history`, which is one likely choke point for malformed JSONL.
- For normal Codex discovery and listing, rollout files are expected under `sessions/YYYY/MM/DD/` and use the canonical filename shape `rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`.
- Codex thread IDs are generated rather than content-derived. The current implementation in `codex-rs` uses UUIDv7 for new thread IDs.
- A sanitized file is much more likely to behave like a normal Codex session if the canonical filename suffix and rewritten `session_meta.id` match exactly.
- The safest "re-add" strategy is to create a fresh canonical rollout file with a fresh thread ID rather than reusing the original session identity in a second location.
