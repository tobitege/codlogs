# Task Plan: Large-Session Hardening for codlogs

## Goal

Harden `codlogs` so browsing, filtering, detail inspection, and export remain responsive and predictable for very large Codex session files, including `500+ MB` sessions and `90+ MB` individual JSONL rows.

## Current Phase

Phase 8

## Phases

### Phase 1: Discovery Baseline

- [x] Confirm every current whole-file read path in `src/shared/codlogs-core.ts`
- [x] Confirm all UI/RPC entrypoints that trigger deep file processing
- [x] Record chokepoints and line references in `findings.md`
- [x] Record current behavior for browse, detail metrics, Markdown export, and HTML export
- **Status:** complete

### Phase 2: Safety Model and Thresholds

- [x] Add a central file-probe design covering `fs.stat`, first-line read, and cached file size
- [x] Define size thresholds and per-line byte caps
- [x] Define behavior for `full`, `partial`, and `skipped` analysis
- [x] Define browse-time behavior when cross-session-write scanning hits size limits
- [x] Record all thresholds and rationale in `findings.md`
- **Status:** complete

### Phase 3: Streaming Reader Foundation

- [x] Design a shared streaming JSONL reader with chunked decoding and line assembly
- [x] Define cancellation and progress semantics for streaming readers
- [x] Define oversized-line handling before `JSON.parse`
- [x] Replace whole-file parser call sites conceptually in plan
- **Status:** complete

### Phase 4: Browse and Filter Hardening

- [x] Keep first-line `session_meta` scan as the default listing path
- [x] Extend `SessionMetaMatch` with `fileSizeBytes`
- [x] Replace fallback content scans with bounded streaming scans and early exit
- [x] Return “unknown/skipped due to size” instead of forcing giant-file reads
- [x] Ensure one oversized session cannot stall folder filtering
- **Status:** complete

### Phase 5: Detail Metrics Hardening

- [x] Redefine `getSessionDetailMetrics` as safe and size-aware
- [x] Add explicit user-triggered deep analysis path for oversized sessions
- [x] Extend `SessionDetailMetrics` with analysis state and skip metadata
- [x] Change UI to show file size immediately and gate deep analysis for huge sessions
- **Status:** complete

### Phase 6: Export Pipeline Rewrite

- [x] Replace Markdown export whole-file read with streaming parse + streaming write
- [x] Replace HTML export whole-file read with streaming parse + streaming write
- [x] Preserve asset extraction while keeping only current asset payload in memory
- [x] Keep progress reporting, but base it on bytes consumed and stages
- [x] Fail fast on rows above export hard limit with row/file diagnostics
- **Status:** complete

### Phase 7: UI and CLI Surfacing

- [x] Show large-session warnings in the session list and detail panel
- [x] Show analysis state: `ready`, `partial`, `skipped`
- [x] Warn before exporting oversized sessions
- [x] Keep CLI default-safe and surface large-session errors clearly
- [x] Decide whether override flags are needed only after default-safe implementation exists
- **Status:** complete

### Phase 8: Verification

- [x] Add unit coverage for streaming line assembly and line-size guards
- [x] Add integration coverage for large-file browse, metrics, and export behavior
- [ ] Validate cancellation during large export
- [x] Validate giant-file behavior does not freeze normal browsing
- **Status:** in_progress

## Key Questions

1. Which thresholds keep normal sessions frictionless while protecting the app from pathological files?
2. Which paths must be fully exact, and where are partial/skipped results acceptable?
3. How should the UI communicate “too large to auto-analyze” without feeling broken?

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Use streaming file access instead of memory mapping | Portable and implementable in current Bun/Node stack without native complexity |
| Keep first-line metadata discovery | Already the safest and cheapest listing path |
| Size guards enabled by default | Prevents hangs by default for all users |
| Oversized sessions remain visible | Hiding them would lose useful history and confuse users |
| Detail analysis may be partial or skipped | Better than freezing the renderer on giant rows |
| Keep export safety strict and detail analysis bounded | Export is explicit heavy work; browsing must stay fast |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Skill template path in `templates/` missing | 1 | Resolved by using `assets/templates/` in installed skill layout |
| Vite tried to bundle the Node-heavy core into the renderer | 1 | Switched renderer imports back to pure `import type` and kept large-session threshold local in `App.tsx` |
| TypeScript rejected some `Buffer` overloads in the streaming reader | 1 | Replaced overloaded `Buffer.from`/`Buffer.concat` paths with explicit byte-copy helpers |

## Notes

- Update phase status as work completes.
- Record every threshold and guardrail decision in `findings.md`.
- Log build/test outcomes and any performance observations in `progress.md`.
