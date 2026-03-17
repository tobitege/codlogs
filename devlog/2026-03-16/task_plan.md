# Task Plan: Session Screenshot Stripping

## Goal

Add a codlogs feature that creates a sanitized copy of a Codex session JSONL in a temp subfolder, removes image payloads from the readable reconstructed history, extracts original encrypted compaction blobs for inspection, and leaves the source session unchanged.

## Current Phase

Phase 5

## Phases

### Phase 1: Discovery and Format Mapping

- [x] Inspect current session/export architecture and extension points
- [x] Identify safe output location and temp-folder rules
- [x] Determine how compaction rows are represented and whether they contain encoded nested JSON
- [x] Record constraints and unknowns in `findings.md`
- **Status:** completed

### Phase 2: Sanitization Design

- [x] Define the sanitizer API in shared helper code
- [x] Define what counts as image payload in reconstructed history items
- [x] Define output naming, temp-folder layout, and failure behavior
- [x] Confirm the feature reads original sessions only and writes copies elsewhere
- **Status:** completed

### Phase 3: Core Implementation

- [x] Implement temp-workspace creation under a subfolder
- [x] Implement compaction extraction into separate files
- [x] Implement reconstructed image-free JSONL copy generation
- [x] Emit a rebuilt sanitized JSONL copy without mutating the source file
- **Status:** completed

### Phase 4: Surfacing

- [x] Add desktop RPC support for the sanitizer job
- [x] Add a session detail UI action for creating the text-only copy
- [ ] Add a CLI entry point if the feature later needs to work outside the desktop app
- **Status:** completed

### Phase 5: Verification

- [x] Add tests for compaction extraction
- [x] Add tests for reconstructed image stripping
- [x] Verify original file remains unchanged and the output lands in a temp subfolder
- [x] Run typecheck and relevant test commands
- **Status:** completed

## Key Questions

1. Can codlogs directly decode compaction payloads from JSONL rows?
2. If not, what supported Codex API can reconstruct a usable text-only history?
3. How much non-message/tool context should a reconstructed copy preserve?
4. Do Codex rollout files persist any plaintext compaction structure that can be sanitized without decrypting `encrypted_content`?

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Never modify original session files | Matches the user requirement and keeps codlogs read-only |
| Write all generated artifacts to a temp output subfolder | Keeps rewritten output and extracted blobs isolated |
| Extract encrypted compaction blobs as opaque artifacts instead of pretending to decode them | The actual payloads are encrypted and older sessions do not expose raw extended history |
| Rebuild the copy from Codex `app-server` turn history | This is the supported path that removes screenshot payloads without mutating originals |
| Investigate `RolloutItem::Compacted.replacement_history` as the next higher-fidelity sanitization target | Upstream Codex persists plaintext replacement history even though `ResponseItem::Compaction` remains opaque |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Direct compaction rewrite blocked by encrypted payloads | Investigated extension bundle and app-server protocol | Switched to reconstructed text-only copy flow |
| Probe created a temporary derived session in the default Codex sessions folder | Used app-server to validate derived history behavior | Deleted the probe artifact and kept the product feature writing only to a temp subfolder |
