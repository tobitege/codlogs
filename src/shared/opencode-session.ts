import { createHash } from "node:crypto";

// Converts Codex rollout rows into the session transfer document that
// `opencode session import` of OpenCode 2 accepts: { info, messages }.
// The shapes follow SessionTransfer.Data of OpenCode 2.3 (packages/schema).

export const OPENCODE_SESSION_FILE_SUFFIX = ".opencode.json";

const OPENCODE_DEFAULT_AGENT = "build";
const OPENCODE_DEFAULT_PROVIDER = "openai";
const OPENCODE_UNKNOWN_MODEL = "unknown";
const OPENCODE_ID_SUFFIX_LENGTH = 14;
const OPENCODE_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OPENCODE_ID_MAX_COUNTER = 0xfff;
const MAX_DERIVED_TITLE_LENGTH = 80;
const IMAGE_TAG_LINE_REGEX = /^[ \t]*<\/?image\b[^>\r\n]*>[ \t]*\r?$/gim;
const MISSING_TOOL_OUTPUT_MESSAGE = "No tool output was recorded in the Codex session.";

export type OpenCodeModelRef = {
  id: string;
  providerID: string;
};

export type OpenCodeTokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type OpenCodeOutcome = "succeeded" | "failed" | "interrupted";

export type OpenCodeFileAttachment = {
  data: string;
  mime: string;
  source: { type: "inline" };
  name: string;
};

export type OpenCodeToolContent =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name: string };

export type OpenCodeToolState =
  | {
      status: "completed";
      input: Record<string, unknown>;
      content: OpenCodeToolContent[];
    }
  | {
      status: "error";
      input: Record<string, unknown>;
      error: { type: string; message: string };
    };

export type OpenCodeAssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      state: OpenCodeToolState;
      time: { created: number; ran?: number; completed?: number };
    };

export type OpenCodeUserMessage = {
  id: string;
  type: "user";
  time: { created: number };
  text: string;
  files?: OpenCodeFileAttachment[];
};

export type OpenCodeAssistantMessage = {
  id: string;
  type: "assistant";
  time: { created: number; completed: number };
  agent: string;
  model: OpenCodeModelRef;
  content: OpenCodeAssistantContent[];
  finish: "stop" | "tool-calls";
};

export type OpenCodeCompactionMessage = {
  id: string;
  type: "compaction";
  time: { created: number };
  status: "completed";
  reason: "auto";
  summary: string;
};

export type OpenCodeIdleMessage = {
  id: string;
  type: "idle";
  time: { created: number };
  outcome: OpenCodeOutcome;
};

export type OpenCodeMessage =
  | OpenCodeUserMessage
  | OpenCodeAssistantMessage
  | OpenCodeCompactionMessage
  | OpenCodeIdleMessage;

export type OpenCodeSessionInfo = {
  id: string;
  projectID: string;
  model?: OpenCodeModelRef;
  cost: number;
  tokens: OpenCodeTokenUsage;
  outcome?: OpenCodeOutcome;
  time: { created: number; updated: number; idle?: number; viewed?: number };
  title: string;
  location: { directory: string };
  metadata: Record<string, string>;
};

export type OpenCodeSessionConverterOptions = {
  sessionId: string;
  cwd: string;
  startedAt: string | null;
  modelProvider: string | null;
  cliVersion: string | null;
  title: string | null;
  includeImages: boolean;
  includeToolCallResults: boolean;
  // Used for rows without a timestamp when the session start is unknown too.
  fallbackTimestampMs: number;
};

export type OpenCodeSessionConverter = {
  // Returns the messages that are complete after this row, in transcript order.
  push(record: { timestamp?: unknown; type?: unknown; payload?: unknown }): OpenCodeMessage[];
  finish(): { messages: OpenCodeMessage[]; info: OpenCodeSessionInfo };
};

type PendingMessage = {
  message: OpenCodeMessage;
  // Tool calls of this assistant step that still wait for their output row.
  openCalls: number;
};

type PendingToolCall = {
  owner: PendingMessage;
  part: Extract<OpenCodeAssistantContent, { type: "tool" }>;
  input: Record<string, unknown>;
};

type ParsedImage = {
  mime: string;
  base64: string;
};

/**
 * Builds an identifier with OpenCode's layout: a prefix, twelve hex digits
 * holding the timestamp and a per-millisecond counter, and fourteen base62
 * characters. OpenCode draws those characters at random; here they come from
 * `seed`, so the same Codex session always yields the same identifiers and a
 * second import is reported as "Session already exists" instead of a duplicate.
 */
export function buildOpenCodeIdentifier(options: {
  prefix: "ses" | "msg";
  timestampMs: number;
  counter: number;
  descending: boolean;
  seed: string;
}): string {
  const current =
    BigInt(Math.max(0, Math.trunc(options.timestampMs))) * 0x1000n + BigInt(options.counter);
  const value = BigInt.asUintN(48, options.descending ? ~current : current);
  const digest = createHash("sha256").update(options.seed).digest();
  let suffix = "";
  for (let index = 0; index < OPENCODE_ID_SUFFIX_LENGTH; index += 1) {
    suffix += OPENCODE_ID_ALPHABET[digest[index] % OPENCODE_ID_ALPHABET.length];
  }

  return `${options.prefix}_${value.toString(16).padStart(12, "0")}${suffix}`;
}

export function createOpenCodeSessionConverter(
  options: OpenCodeSessionConverterOptions,
): OpenCodeSessionConverter {
  const startedAtMs = parseTimestampMs(options.startedAt);
  const providerID = options.modelProvider?.trim() || OPENCODE_DEFAULT_PROVIDER;
  const queue: PendingMessage[] = [];
  const pendingCalls = new Map<string, PendingToolCall>();

  let lastTimestampMs = startedAtMs ?? options.fallbackTimestampMs;
  let firstRecordTimestampMs: number | null = null;
  let idTimestampMs = 0;
  let idCounter = 0;
  let messageCount = 0;
  let anonymousCallCount = 0;
  let imageCount = 0;
  let modelId: string | null = null;
  let firstUserText: string | null = null;
  let tokens: OpenCodeTokenUsage | null = null;
  let currentStep: PendingMessage | null = null;
  let currentStepHasOutput = false;
  let sawTurnEvents = false;
  let messagesSinceIdle = 0;
  let assistantStepsSinceIdle = 0;
  let lastIdleMs: number | null = null;
  let lastOutcome: OpenCodeOutcome | null = null;

  // Codex writes rows in order; a row without a usable timestamp takes the previous one.
  function resolveTimestamp(value: unknown): number {
    const parsed = parseTimestampMs(value);
    if (parsed !== null) {
      firstRecordTimestampMs ??= parsed;
      lastTimestampMs = Math.max(lastTimestampMs, parsed);
    }
    return lastTimestampMs;
  }

  function nextMessageId(timestampMs: number): string {
    if (timestampMs > idTimestampMs) {
      idTimestampMs = timestampMs;
      idCounter = 0;
    }
    idCounter += 1;
    if (idCounter > OPENCODE_ID_MAX_COUNTER) {
      idTimestampMs += 1;
      idCounter = 1;
    }
    messageCount += 1;
    return buildOpenCodeIdentifier({
      prefix: "msg",
      timestampMs: idTimestampMs,
      counter: idCounter,
      descending: false,
      seed: `codex:${options.sessionId}:message:${messageCount}`,
    });
  }

  function enqueue(message: OpenCodeMessage): PendingMessage {
    const pending = { message, openCalls: 0 };
    queue.push(pending);
    if (message.type !== "idle") {
      messagesSinceIdle += 1;
    }
    return pending;
  }

  function flush(): OpenCodeMessage[] {
    const ready: OpenCodeMessage[] = [];
    while (queue.length > 0 && queue[0] !== currentStep && queue[0].openCalls === 0) {
      ready.push(queue.shift()!.message);
    }
    return ready;
  }

  function closeStep(): void {
    if (!currentStep) {
      return;
    }
    const message = currentStep.message as OpenCodeAssistantMessage;
    message.finish = message.content.some((part) => part.type === "tool") ? "tool-calls" : "stop";
    currentStep = null;
    currentStepHasOutput = false;
  }

  // One assistant message is one model response. A response ends once one of
  // its tool calls has an output, so later content starts the next message.
  function openStep(timestampMs: number): OpenCodeAssistantMessage {
    if (currentStep && !currentStepHasOutput) {
      const message = currentStep.message as OpenCodeAssistantMessage;
      message.time.completed = Math.max(message.time.completed, timestampMs);
      return message;
    }

    closeStep();
    const message: OpenCodeAssistantMessage = {
      id: nextMessageId(timestampMs),
      type: "assistant",
      time: { created: timestampMs, completed: timestampMs },
      agent: OPENCODE_DEFAULT_AGENT,
      model: { id: modelId ?? OPENCODE_UNKNOWN_MODEL, providerID },
      content: [],
      finish: "stop",
    };
    currentStep = enqueue(message);
    assistantStepsSinceIdle += 1;
    return message;
  }

  function failOpenCalls(timestampMs: number): void {
    for (const call of pendingCalls.values()) {
      call.part.state = {
        status: "error",
        input: call.input,
        error: { type: "aborted", message: MISSING_TOOL_OUTPUT_MESSAGE },
      };
      call.part.time.completed = Math.max(call.part.time.created, timestampMs);
      call.owner.openCalls -= 1;
    }
    pendingCalls.clear();
  }

  function endTurn(timestampMs: number, outcome: OpenCodeOutcome): void {
    closeStep();
    // An output cannot arrive after its turn ended.
    failOpenCalls(timestampMs);
    if (messagesSinceIdle === 0) {
      return;
    }
    queue.push({
      message: { id: nextMessageId(timestampMs), type: "idle", time: { created: timestampMs }, outcome },
      openCalls: 0,
    });
    messagesSinceIdle = 0;
    assistantStepsSinceIdle = 0;
    lastIdleMs = timestampMs;
    lastOutcome = outcome;
  }

  function readImage(part: Record<string, unknown>): { image: ParsedImage; name: string } | null {
    const image = parseImagePart(part);
    if (!image) {
      return null;
    }
    imageCount += 1;
    return {
      image,
      name: `image-${String(imageCount).padStart(3, "0")}.${extensionForImageMime(image.mime)}`,
    };
  }

  function pushUserMessage(item: Record<string, unknown>, timestampMs: number): void {
    const parts = typeof item.content === "string" ? [item.content] : asArray(item.content);
    const texts: string[] = [];
    const files: OpenCodeFileAttachment[] = [];
    for (const value of parts) {
      const part = asObject(value);
      if (part && looksLikeImagePart(part)) {
        const parsed = options.includeImages ? readImage(part) : null;
        if (parsed) {
          files.push({
            data: parsed.image.base64,
            mime: parsed.image.mime,
            source: { type: "inline" },
            name: parsed.name,
          });
        }
        continue;
      }
      const text = cleanMessageText(typeof value === "string" ? value : readPartText(part));
      if (text) {
        texts.push(text);
      }
    }

    const text = texts.join("\n\n");
    if (!text && files.length === 0) {
      return;
    }

    closeStep();
    // Codex versions without turn events: an answered prompt ends with the next prompt.
    if (!sawTurnEvents && assistantStepsSinceIdle > 0) {
      endTurn(timestampMs, "succeeded");
    }
    firstUserText ??= text || null;
    enqueue({
      id: nextMessageId(timestampMs),
      type: "user",
      time: { created: timestampMs },
      text,
      ...(files.length > 0 ? { files } : {}),
    });
  }

  function pushAssistantText(item: Record<string, unknown>, timestampMs: number): void {
    const parts = typeof item.content === "string" ? [item.content] : asArray(item.content);
    const text = parts
      .map((value) => {
        const part = asObject(value);
        if (part && looksLikeImagePart(part)) {
          return "";
        }
        return typeof value === "string" ? value : readPartText(part);
      })
      .filter((entry) => entry.trim() !== "")
      .join("\n\n");
    if (text) {
      openStep(timestampMs).content.push({ type: "text", text });
    }
  }

  function pushReasoning(item: Record<string, unknown>, timestampMs: number): void {
    const text = asArray(item.summary)
      .map((entry) => (typeof entry === "string" ? entry : asObject(entry)?.text))
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .map((entry) => entry.trim())
      .join("\n\n");
    if (text) {
      openStep(timestampMs).content.push({ type: "reasoning", text });
    }
  }

  function pushToolCall(item: Record<string, unknown>, timestampMs: number): void {
    const input = readToolInput(item);
    let callId = typeof item.call_id === "string" && item.call_id ? item.call_id : null;
    if (!callId || pendingCalls.has(callId)) {
      anonymousCallCount += 1;
      callId = `${callId ?? "codex_call"}_${anonymousCallCount}`;
    }
    const part: PendingToolCall["part"] = {
      type: "tool",
      id: callId,
      name: readToolName(item),
      // Replaced when the output row arrives or the turn ends without one.
      state: {
        status: "error",
        input,
        error: { type: "aborted", message: MISSING_TOOL_OUTPUT_MESSAGE },
      },
      time: { created: timestampMs, ran: timestampMs },
    };
    openStep(timestampMs).content.push(part);
    currentStep!.openCalls += 1;
    pendingCalls.set(callId, { owner: currentStep!, part, input });
  }

  function pushToolOutput(item: Record<string, unknown>, timestampMs: number): void {
    const callId = typeof item.call_id === "string" ? item.call_id : null;
    const call = callId ? pendingCalls.get(callId) : undefined;
    if (!callId || !call) {
      return;
    }

    pendingCalls.delete(callId);
    call.part.state = {
      status: "completed",
      input: call.input,
      content: readToolOutputContent(item.output),
    };
    call.part.time.completed = Math.max(call.part.time.created, timestampMs);
    call.owner.openCalls -= 1;
    if (call.owner === currentStep) {
      const message = currentStep.message as OpenCodeAssistantMessage;
      message.time.completed = Math.max(message.time.completed, timestampMs);
      currentStepHasOutput = true;
    }
  }

  function readToolOutputContent(output: unknown): OpenCodeToolContent[] {
    const content: OpenCodeToolContent[] = [];
    if (typeof output === "string") {
      content.push({ type: "text", text: output });
    } else if (Array.isArray(output)) {
      for (const value of output) {
        const part = asObject(value);
        if (part && looksLikeImagePart(part)) {
          const parsed = options.includeImages ? readImage(part) : null;
          if (parsed) {
            content.push({
              type: "file",
              uri: `data:${parsed.image.mime};base64,${parsed.image.base64}`,
              mime: parsed.image.mime,
              name: parsed.name,
            });
          }
          continue;
        }
        const text = typeof value === "string" ? value : readPartText(part);
        if (text) {
          content.push({ type: "text", text });
        }
      }
    } else if (output !== undefined && output !== null) {
      const text = asObject(output)?.content;
      content.push({ type: "text", text: typeof text === "string" ? text : JSON.stringify(output) });
    }

    // OpenCode rejects a completed tool call without content.
    return content.length > 0 ? content : [{ type: "text", text: "" }];
  }

  function pushResponseItem(item: Record<string, unknown>, timestampMs: number): void {
    switch (item.type) {
      case "message":
        if (item.role === "user") {
          pushUserMessage(item, timestampMs);
        } else if (item.role === "assistant") {
          pushAssistantText(item, timestampMs);
        }
        return;
      case "reasoning":
        pushReasoning(item, timestampMs);
        return;
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call":
        if (options.includeToolCallResults) {
          pushToolCall(item, timestampMs);
        }
        return;
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output":
        if (options.includeToolCallResults) {
          pushToolOutput(item, timestampMs);
        }
        return;
      default:
        return;
    }
  }

  function buildInfo(): OpenCodeSessionInfo {
    const createdMs = startedAtMs ?? firstRecordTimestampMs ?? options.fallbackTimestampMs;
    const title =
      options.title?.trim() ||
      deriveTitle(firstUserText) ||
      `Codex session ${options.sessionId}`;
    return {
      id: buildOpenCodeIdentifier({
        prefix: "ses",
        timestampMs: createdMs,
        counter: 1,
        descending: true,
        seed: `codex:${options.sessionId}`,
      }),
      // The importer replaces this with the project of the directory it imports into.
      projectID: "global",
      ...(modelId ? { model: { id: modelId, providerID } } : {}),
      cost: 0,
      tokens: tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(lastOutcome ? { outcome: lastOutcome } : {}),
      time: {
        created: createdMs,
        updated: Math.max(createdMs, lastTimestampMs),
        ...(lastIdleMs !== null ? { idle: lastIdleMs, viewed: lastIdleMs } : {}),
      },
      title,
      location: { directory: options.cwd },
      metadata: {
        source: "codex",
        codexSessionId: options.sessionId,
        ...(options.cliVersion ? { codexCliVersion: options.cliVersion } : {}),
        exportedBy: "codlogs",
      },
    };
  }

  return {
    push(record) {
      const timestampMs = resolveTimestamp(record.timestamp);
      const payload = asObject(record.payload);
      if (!payload) {
        return [];
      }

      if (record.type === "response_item") {
        pushResponseItem(payload, timestampMs);
      } else if (record.type === "turn_context") {
        if (typeof payload.model === "string" && payload.model.trim()) {
          modelId = payload.model.trim();
        }
      } else if (record.type === "compacted") {
        // Older Codex versions store the summary as text; newer ones keep an opaque history.
        if (typeof payload.message === "string" && payload.message.trim()) {
          closeStep();
          enqueue({
            id: nextMessageId(timestampMs),
            type: "compaction",
            time: { created: timestampMs },
            status: "completed",
            reason: "auto",
            summary: payload.message,
          });
        }
      } else if (record.type === "event_msg") {
        if (payload.type === "token_count") {
          tokens = readTotalTokenUsage(payload) ?? tokens;
        } else if (payload.type === "task_started") {
          sawTurnEvents = true;
        } else if (payload.type === "task_complete") {
          sawTurnEvents = true;
          endTurn(timestampMs, asObject(payload.error) ? "failed" : "succeeded");
        } else if (payload.type === "turn_aborted") {
          sawTurnEvents = true;
          endTurn(timestampMs, "interrupted");
        }
      }

      return flush();
    },
    finish() {
      // A turn that Codex never closed was cut off; without turn events the last answer counts as complete.
      endTurn(lastTimestampMs, sawTurnEvents ? "interrupted" : "succeeded");
      return { messages: flush(), info: buildInfo() };
    },
  };
}

function readToolName(item: Record<string, unknown>): string {
  if (typeof item.name === "string" && item.name.trim()) {
    return item.name.trim();
  }
  return item.type === "local_shell_call" ? "shell" : "unknown-tool";
}

// OpenCode stores tool input as an object; Codex records JSON text, free text or an action object.
function readToolInput(item: Record<string, unknown>): Record<string, unknown> {
  const raw = item.type === "local_shell_call" ? item.action : item.arguments ?? item.input;
  const direct = asObject(raw);
  if (direct) {
    return direct;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = asObject(JSON.parse(trimmed));
        if (parsed) {
          return parsed;
        }
      } catch {
        // Not JSON: keep the text as written.
      }
    }
    return { input: raw };
  }
  return raw === undefined || raw === null ? {} : { input: raw };
}

function readTotalTokenUsage(payload: Record<string, unknown>): OpenCodeTokenUsage | null {
  const usage = asObject(asObject(payload.info)?.total_token_usage);
  if (!usage) {
    return null;
  }
  const input = asCount(usage.input_tokens);
  const output = asCount(usage.output_tokens);
  if (input === null || output === null) {
    return null;
  }
  // Codex counts cached input inside input and reasoning inside output; OpenCode keeps them apart.
  const cached = Math.min(asCount(usage.cached_input_tokens) ?? 0, input);
  const reasoning = Math.min(asCount(usage.reasoning_output_tokens) ?? 0, output);
  return {
    input: input - cached,
    output: output - reasoning,
    reasoning,
    cache: { read: cached, write: 0 },
  };
}

function readPartText(part: Record<string, unknown> | null): string {
  if (!part) {
    return "";
  }
  for (const key of ["text", "input_text", "output_text"]) {
    const value = part[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return JSON.stringify(part);
}

// Codex wraps each attached image in <image ...> and </image> marker lines.
function cleanMessageText(text: string): string {
  const cleaned = text.replace(IMAGE_TAG_LINE_REGEX, "");
  // Drop the blank lines the markers leave behind, but keep the indentation of the first line.
  return cleaned.trim() ? cleaned.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd() : "";
}

function deriveTitle(text: string | null): string | null {
  const line = text
    ?.split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) {
    return null;
  }
  return line.length > MAX_DERIVED_TITLE_LENGTH
    ? `${line.slice(0, MAX_DERIVED_TITLE_LENGTH - 3).trimEnd()}...`
    : line;
}

function looksLikeImagePart(part: Record<string, unknown>): boolean {
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return (
    type === "image" ||
    type === "input_image" ||
    type === "output_image" ||
    type === "image_url" ||
    part.image_url !== undefined
  );
}

// Only embedded images can travel inside the session file.
function parseImagePart(part: Record<string, unknown>): ParsedImage | null {
  const imageUrl = asObject(part.image_url);
  const source =
    typeof part.image_url === "string"
      ? part.image_url
      : typeof imageUrl?.url === "string"
        ? imageUrl.url
        : typeof part.url === "string"
          ? part.url
          : null;
  if (source === null) {
    return typeof part.data === "string" && typeof part.mimeType === "string"
      ? buildImage(part.mimeType, part.data)
      : null;
  }

  const trimmed = source.trim();
  const separator = trimmed.indexOf(",");
  if (separator < 0 || trimmed.slice(0, 5).toLowerCase() !== "data:") {
    return null;
  }
  const header = trimmed.slice(5, separator).toLowerCase();
  if (!header.endsWith(";base64")) {
    return null;
  }
  return buildImage(header.slice(0, header.indexOf(";")), trimmed.slice(separator + 1));
}

function buildImage(mimeType: string, data: string): ParsedImage | null {
  const mime = mimeType.trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(mime)) {
    return null;
  }
  // OpenCode accepts only padded base64 without line breaks.
  const compact = data.replace(/\s+/g, "").replace(/=+$/, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+$/.test(compact)) {
    return null;
  }
  return { mime, base64: compact + "=".repeat((4 - (compact.length % 4)) % 4) };
}

function extensionForImageMime(mime: string): string {
  const subtype = mime.slice("image/".length);
  if (subtype === "jpeg") {
    return "jpg";
  }
  if (subtype === "svg+xml") {
    return "svg";
  }
  return subtype.replace(/[^a-z0-9]/g, "") || "img";
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
