# Progress Log

## Session: 2026-03-16

### Phase 1: Discovery and Format Mapping

- **Status:** completed
- Actions taken:
  - Reviewed repo instructions and current README usage
  - Opened the `planning-with-files` skill and created today’s planning artifacts under `devlog/2026-03-16/`
  - Identified the shared core, CLI, renderer, and Electrobun RPC entrypoints involved in session handling
  - Confirmed current exports skip image content at render time but do not sanitize source JSONL
  - Verified that compaction rows are encrypted `response_item` payloads and cannot be directly rewritten by codlogs
  - Probed the Codex `app-server` protocol and confirmed it can reconstruct readable thread history from a rollout file path
  - Confirmed the reconstructed-history route can produce an image-free derived session copy
- Files created/modified:
  - `devlog/2026-03-16/task_plan.md`
  - `devlog/2026-03-16/findings.md`
  - `devlog/2026-03-16/progress.md`

### Phase 2: Desktop Feature Implementation

- **Status:** completed
- Actions taken:
  - Added `src/shared/sanitized-session.ts` with pure helpers for compaction extraction and reconstructed response-item generation
  - Added Bun-side background job support for text-only session copies
  - Added a desktop UI action to create a text-only copy and reveal/open its temp output folder
  - Wrote temp-folder artifacts consisting of `sanitized-session.jsonl`, `sanitization-report.json`, and extracted encrypted compaction blob files

### Phase 3: Upstream Compaction Investigation

- **Status:** completed
- Actions taken:
  - Read upstream Codex app-server, core, protocol, and API sources under `D:\github\codex-main\codex-rs`
  - Confirmed `ResponseItem::Compaction` is opaque and no local decrypt path is exposed
  - Confirmed Codex persists separate `RolloutItem::Compacted` entries with plaintext `replacement_history`
  - Confirmed resume/fork reconstruction prefers `replacement_history` over decrypting `encrypted_content`
  - Confirmed image-bearing user messages remain valid history items and can therefore survive inside replacement history
- Takeaway:
  - The best path to a more faithful sanitizer is likely to rewrite plaintext `compacted.replacement_history` in a derived copy rather than trying to decrypt opaque compaction blobs

### Phase 4: Sanitization Modal Refinement

- **Status:** completed
- Actions taken:
  - Replaced the one-click text-only copy action with a `Sanitize Session...` modal
  - Added explicit sanitization job options for creating a new JSONL copy
  - Kept image stripping explicit in the dialog and marked it as required for the current reconstructed-copy workflow
  - Updated the Bun RPC/job layer to respect the selected sanitization outputs
  - Kept the progress dialog and result banner, but renamed them from "text-only copy" to generic sanitized output wording

### Phase 5: Timestamp Preservation Fix

- **Status:** completed
- Actions taken:
  - Traced a regression where sanitized copies were assigning fresh timestamps based on generation time
  - Confirmed the app-server reconstructed thread omits item timestamps, so direct preservation is not possible from that API alone
  - Added a lightweight source-JSONL metadata scan to collect original `response_item` timestamps and payload types
  - Mapped reconstructed sanitized items back onto those original timestamps before writing the derived JSONL
  - Added regression tests for response-item metadata extraction and timestamp mapping

### Phase 6: Preserve Opaque Compaction Rows

- **Status:** completed
- Actions taken:
  - Confirmed the sanitized writer was dropping original opaque `response_item` compaction rows entirely
  - Changed the source scan to keep the original response-item sequence, including raw compaction lines
  - Updated the sanitized JSONL writer to interleave reconstructed sanitized rows with preserved raw compaction rows in original order
  - Added a regression test covering write-sequence preservation for compaction rows

### Phase 7: Preserve Sanitized `compacted` Rollout Rows

- **Status:** completed
- Actions taken:
  - Confirmed the sanitizer was still dropping rollout-level `type: "compacted"` rows entirely
  - Added a shared helper to parse and rewrite `payload.replacement_history` by stripping `input_image` items and replacing them with text markers
  - Updated the Bun-side source scan to preserve sanitized `compacted` rows in original sequence
  - Added regression tests for compacted-row sanitization and sequence preservation

### Phase 8: Preserve Original Rollout Order

- **Status:** completed
- Actions taken:
  - Confirmed the reconstructed-history writer cannot place `compacted` rows at their real historical positions once the thread has been compacted multiple times
  - Replaced the JSONL copy writer with a direct line-by-line rewrite of the source session
  - Kept line order intact while sanitizing `response_item` rows and `compacted.replacement_history` in place
  - Added a regression test for in-place response-item sanitization

### Phase 9: Strip Event-Message Image Payloads

- **Status:** completed
- Actions taken:
  - Investigated a new size regression where a sanitized copy grew to about 128 MB despite compacted-row rewriting
  - Confirmed the remaining large payloads were top-level `event_msg` rows with `payload.type: "user_message"` and base64 `images` arrays
  - Added in-place sanitization for `event_msg` user-message rows by clearing `images` and `local_images` and appending text placeholders to the message body
  - Wired the new sanitizer into the streaming JSONL writer while preserving original row order
  - Added a regression test covering inline-image `event_msg` rows

### Phase 10: Add Optional Blob-Stripping Mode

- **Status:** completed
- Actions taken:
  - Investigated a remaining 11 MB sanitized copy and confirmed the largest surviving row classes were tool payloads, encrypted reasoning blobs, token-count events, and repeated turn-context instruction dumps
  - Added a new `Strip all blobs` sanitization option to the desktop modal and RPC flow
  - Extended the JSONL sanitizer to optionally rewrite:
    - large `response_item/function_call` argument strings
    - large `response_item/custom_tool_call` input strings
    - large `response_item/function_call_output` and `custom_tool_call_output` output strings
    - large `response_item/reasoning.encrypted_content` blobs
    - `event_msg/token_count` payloads
    - large string fields inside `turn_context` payloads
  - Kept `type: "compacted"` rows and their `replacement_history` out of aggressive blob stripping so Codex compatibility stays closer to the earlier requirement
  - Updated the dialog copy to reflect that the JSONL writer preserves original line order rather than reconstructing from readable thread history
  - Added regression tests for tool-output stripping, reasoning-blob stripping, token-count stripping, and turn-context stripping

### Phase 11: Remove Compaction-Artifact Extraction

- **Status:** completed
- Actions taken:
  - Removed the `Extract original compaction blobs` option from the sanitize modal
  - Removed the matching RPC field and Bun-side extraction path
  - Simplified the sanitize job to write only the derived JSONL copy plus report, while still scanning the source for compaction-row counts
  - Updated wording so the UI describes a derived JSONL copy rather than a set of output artifacts

## Test Results

| Scenario | Command / Action | Expected | Actual | Status |
|----------|------------------|----------|--------|--------|
| Planning files created | `devlog/2026-03-16/` contains required files | Files present | Files present | pass |
| Shared helper tests | `bun test src/shared/codlogs-core.test.ts` | All tests pass | 17 pass / 0 fail | pass |
| Type check | `bun x tsc --noEmit` | No TypeScript errors | Passed | pass |
