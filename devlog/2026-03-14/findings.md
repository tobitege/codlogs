# Findings & Decisions

## Requirements

- Browsing must not freeze because one session file is huge
- The tool must inspect file size before deep processing
- Deep processing must not read giant session files into one UTF-8 string
- Exports must not parse the entire file into one in-memory record array
- Large rows must be detected and handled explicitly
- The user must see clear warnings/status for oversized sessions

## Research Findings

- Discovery is already relatively safe because `readSessionMeta` uses only the first line.
- `getSessionDetailMetrics` currently does `fs.stat + fs.readFile + parseJsonlRecords`, so selecting a session can fully load giant files.
- Both export flows currently do `fs.readFile`, split into all lines, parse all lines, then render whole transcript output in memory.
- Cross-session-write fallback can still full-read files through `fileContainsAnyNeedle` and `sessionTouchesRoot`.
- The renderer eagerly requests detail metrics for the selected session, so giant files can be opened just by selection.
- Current listing flow already threads through `readFirstLine`, which is the right base to keep for giant-file-safe discovery.
- Implemented fix: `probeSessionFile(filePath)` now pairs `fs.stat` with first-line metadata parsing so listing includes `fileSizeBytes` without full-file reads.
- Implemented fix: `streamJsonlLines` and `streamJsonlRecords` now provide chunked line assembly, byte progress, cancellation checks, and oversized-row handling before `JSON.parse`.
- Implemented fix: detail metrics now return `analysisKind`, `skipReason`, `largestParsedLineBytes`, and `oversizedLineCount`, with automatic skip above `128 MiB` unless deep analysis is explicitly requested.
- Implemented fix: Markdown and HTML exports now stream input records and output writes instead of materializing full JSONL content or transcript arrays in memory.
- Implemented fix: the UI now shows large-session badges, size-aware analysis banners, and an explicit `Analyze Anyway` action rather than treating selection as permission to deeply inspect.

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Add `probeSessionFile(filePath)` | One cheap probe should govern all later safety decisions |
| Add `fileSizeBytes` to `SessionMetaMatch` | Lets UI and browse logic avoid reopening files just to learn size |
| Add analysis states to `SessionDetailMetrics` | Makes partial/skipped behavior explicit and testable |
| Use byte-based thresholds, not line-count thresholds | The failure mode is huge rows and huge files, not record count alone |
| Stream export input and output | Prevents multiple full-memory copies of the same session |
| Keep browsing exact on metadata but bounded on deep content scanning | Lets normal discovery stay fast without making giant-file fallback unsafe |
| Cache the first returned metrics object per session file | Keeps selection responsive and avoids repeated bounded scans while browsing |
| Keep large-session warnings in both the list and export dialog | Users need the warning before selection and again before a potentially heavy export |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| Current code conflates “selected session” with “safe to deeply inspect” | Split safe metrics from explicit deep analysis |
| Current fallback scan can degrade browsing when ripgrep is insufficient | Bound fallback scans by byte budget and early exit |
| Current exporters hold both parsed records and rendered transcript in memory | Replace with streaming transform/writer pipeline |
| Renderer build broke when a runtime import pulled the Node-heavy core into Vite | Keep renderer imports type-only and duplicate only the UI threshold constant locally |
| Node/Bun `Buffer` overloads conflicted with newer TypeScript typed-array generics | Use explicit byte-copy helpers in the streaming reader instead of overloaded `Buffer` helpers |

## Resources

- `src/shared/codlogs-core.ts`
- `src/mainview/App.tsx`
- `src/shared/rpc.ts`
- `src/bun/index.ts`
- `C:\Users\tobias\.codex\skills\planning-with-files\assets\templates`

## Visual/Browser Findings

- Session cards now surface large sessions directly with a size badge.
- Detail view now distinguishes `full`, `partial`, and `skipped` analysis through a banner instead of silently showing misleading “Loading...” states.
- Export dialog now warns when the selected session already exceeds the large-session threshold.
