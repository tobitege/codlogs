# Findings & Decisions

## Requirements

- Original Codex session files must remain unchanged
- Sanitization work must happen in a temp subfolder
- Compaction rows need separate handling because a single JSONL row can hold a very large payload
- The rewritten output should preserve a valid JSONL structure while stripping screenshot or image payloads

## Research Findings

- `src/shared/codlogs-core.ts` already has the streaming JSONL reader and is the right home for a sanitizer pipeline.
- Export rendering already knows how to ignore image content parts when building Markdown or HTML, but it does not rewrite JSONL.
- The current repo does not yet contain explicit compaction decode or re-encode logic.
- Real compaction rows are stored as `response_item` payloads shaped like `{"type":"compaction","encrypted_content":"gAAAAA..."}`.
- Codex exposes a supported `app-server` protocol with `thread/resume` and `thread/read`, but those APIs return a lossy reconstructed thread history rather than the original raw JSONL rows.
- The `app-server` can still load a rollout by path and reconstruct readable turn history, including user messages, agent messages, reasoning, and some tool-like items.
- A probe confirmed that older session files do not replay raw persisted items such as `raw_response_item` or `get_history_entry_response`, so encrypted compaction blobs remain opaque.
- A practical supported fallback is to rebuild a new image-free JSONL from Codex's reconstructed turn history or, more faithfully, rewrite the original JSONL line by line while preserving opaque compaction rows.

## Compaction Internals

- In upstream Codex sources, `ResponseItem::Compaction` is intentionally just an opaque `encrypted_content: String` field. No local decrypt or re-encode helper was found in `codex-rs`.
- Remote compaction uses the provider-facing `/responses/compact` endpoint and simply deserializes its `output: Vec<ResponseItem>` response. Codex does not locally decrypt the returned `compaction` item.
- Codex also persists a separate rollout item, `RolloutItem::Compacted`, with `message` plus optional plaintext `replacement_history: Vec<ResponseItem>`.
- `Session::replace_compacted_history(...)` persists that `CompactedItem` after replacing in-memory history, so rollouts can contain both:
  - opaque `response_item` compaction rows
  - plaintext `compacted` rows with replacement history
- Resume/fork reconstruction prefers `CompactedItem.replacement_history` when present, which means rollout recovery does not need to decrypt the opaque `response_item` compaction blob.
- User messages with `input_image` are still treated as normal user history by `event_mapping::parse_user_message(...)`, and image stripping only happens when the target model lacks image support. That means screenshot data can survive inside `replacement_history`.
- This makes it likely that a very large compaction line is coming from a `compacted` rollout entry with image-heavy `replacement_history`, not necessarily from the opaque `encrypted_content` field itself.

## Practical Implication

- True in-place editing of encrypted compaction payloads still looks infeasible.
- A more faithful sanitizer is possible without decryption:
  - rewrite `compacted` rollout entries by stripping images from `replacement_history`
  - rewrite ordinary `response_item` message and tool-output rows that carry images
  - leave opaque `response_item` compaction blobs unchanged, replace them with a marker, or omit them in the derived copy depending on compatibility needs

## Product Direction

- The sanitization feature should not look like a blind one-click transform because the outputs have compatibility tradeoffs.
- A modal with explicit sanitization choices is a better fit for the current implementation:
  - create sanitized JSONL copy
  - optionally use more aggressive blob stripping
- Image stripping is currently inherent to the reconstructed-copy flow, so the UI now presents it as an explicit but fixed part of the current mode instead of pretending it is a fully independent toggle.
- The reconstructed app-server thread items do not include per-item timestamps, so preserving original timestamps requires a second pass over the source JSONL and a best-effort mapping back onto reconstructed `response_item`s.
- Dropping original opaque compaction `response_item` rows makes the derived JSONL much less compatible with Codex resume behavior, so the sanitizer should preserve those rows verbatim and interleave them back into the rewritten response-item stream.
- Preserving only opaque `response_item` compactions is still insufficient for Codex compatibility because rollout-level `type: "compacted"` rows carry `replacement_history`, which Codex uses directly during reconstruction.
- A practical middle ground is to preserve `type: "compacted"` rows in the output stream while sanitizing image-bearing entries inside `payload.replacement_history`.
- Rebuilding a JSONL copy from app-server reconstructed history cannot preserve original rollout chronology after compactions. For a Codex-compatible derived JSONL, the writer must stream the original file in order and rewrite sanitizable lines in place.
- Even after in-place rewriting of `response_item` and `compacted` rows, large derived files can still remain if top-level `event_msg` rows are left untouched.
- Real rollout files can carry screenshot payloads in `event_msg` rows shaped like `{"type":"event_msg","payload":{"type":"user_message","images":["data:image/..."],"local_images":[...]}}`.
- Those `event_msg` user-message rows need their `images` and `local_images` arrays stripped in place as part of the JSONL sanitizer, otherwise base64 data survives and dominates output size.
- Once image-bearing rows are stripped, the next largest remaining payload classes are usually plain-text or opaque metadata blobs:
  - `response_item/function_call_output`
  - `response_item/reasoning`
  - `event_msg/token_count`
  - `turn_context`
  - `response_item/function_call`
  - `response_item/custom_tool_call`
- Those rows can still account for several megabytes even after image removal, so an optional aggressive `strip blobs` mode is useful for sessions where size matters more than resume fidelity.
- `type: "compacted"` rows are still special-cased: they must remain in place, and their `replacement_history` should only get image stripping, not aggressive blob stripping, to avoid breaking Codex resume expectations.

## Open Questions

- Whether future Codex versions will expose raw persisted history for resumed sessions
- Whether preserving more tool interactions in the reconstructed copy is worth the added complexity
- Whether the app should later offer a CLI surface for the same reconstruction flow

## Resources

- `src/shared/codlogs-core.ts`
- `src/shared/rpc.ts`
- `src/bun/index.ts`
- `src/mainview/App.tsx`
- `src/shared/sanitized-session.ts`
- `devlog/2026-03-16/app-server-ts/`
- `devlog/2026-03-16/app-server-schema/`
