# Findings

## OpenCode 2 session file

- OpenCode 2 (checked: 2.3.0) has `opencode session export [session]` and `opencode session import <file> [--directory DIR]`. OpenCode 1 used a different layout (`info` plus messages with `parts`); that layout is not what version 2 writes.
- The file is one JSON document: `{ "info": Session.Info, "messages": SessionMessage.Info[] }` (`SessionTransfer.Data`, `packages/schema/src/session-transfer.ts` in `anomalyco/opencode`).
- `info` requires `id` (starts with `ses`), `projectID`, `cost`, `tokens`, `time.created`, `time.updated` and `location.directory`. Optional: `model`, `title`, `outcome`, `time.idle`, `time.viewed`, `metadata` and more.
- The importer replaces `projectID` and `location` with the project of the import directory, sets `time.updated` to the import time and adds `model.variant: "default"`. It answers a known session id with 409 ("Session already exists").
- Messages are a flat list with a `type`: `user`, `assistant`, `idle`, `compaction`, `system`, `synthetic`, `skill`, `shell`, `model-switched`, `agent-switched`, `location-switched`. Message ids start with `msg_` and are a global primary key.
- A `user` message has `text` and optional `files` (`data` as padded base64, `mime`, `source: { type: "inline" }`, `name`).
- An `assistant` message is one model response: `agent`, `model: { id, providerID }`, `content[]` with `text`, `reasoning` and `tool` parts, and `time.completed`. The importer drops an assistant message without `time.completed`.
- A `tool` part has `id`, `name`, `time.created` and a `state`: `completed` (object `input`, non-empty `content`) or `error` (object `input`, `error: { type, message }`). Tool content is `text` or `file` (`uri` as data URL, `mime`, `name`).
- An `idle` message ends a turn with `outcome` `succeeded`, `failed` or `interrupted`.
- Identifiers are a prefix, twelve hex digits (timestamp in ms times 4096 plus a per-millisecond counter; inverted for session ids) and fourteen random base62 characters.
- Token counts are disjoint: `input` excludes cached input, `output` excludes reasoning.
- The import reads the whole file into memory and posts it to the local server; a 40 MB file with images imported without problems.

## Codex rollout rows that matter

- `turn_context.model` names the model; `session_meta.model_provider` names the provider.
- `event_msg` `task_started`, `task_complete` and `turn_aborted` mark turns in current Codex versions; older sessions have none.
- A tool output row (`function_call_output`, `custom_tool_call_output`) directly follows its call; the next reasoning, message or call row belongs to the next model response.
- `event_msg` `token_count` carries cumulative totals in `info.total_token_usage`; input includes cached input and output includes reasoning.
- `compacted.message` is empty in current Codex versions (the replacement history is opaque); older versions stored a summary text there.
- Codex wraps an attached image in `<image name=[Image #1] ...>` and `</image>` marker lines inside the prompt text.

## Decisions

- Identifiers are derived from the Codex session id and the message position, so the same session always gets the same ids and a second import is reported as a conflict instead of creating a copy.
- The session info is written after the messages, because the token totals and the last timestamp are known only at the end of the single streaming pass.
- Instructions, developer messages and the bootstrap context are left out, as in the Markdown and HTML exports.
- `--include-images` and `--include-tool-results` keep their meaning; images are embedded in the file.
- Tool names are kept as Codex recorded them. OpenCode shows such calls but cannot run tools of these names.
