type SanitizedContentItem =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "output_text";
      text: string;
    };

export type SanitizedResponseItem =
  | {
      type: "message";
      role: "user" | "assistant";
      content: SanitizedContentItem[];
    }
  | {
      type: "reasoning";
      summary: Array<{
        type: "summary_text";
        text: string;
      }>;
      content: Array<{
        type: "text";
        text: string;
      }>;
      encrypted_content: null;
    }
  | {
      type: "local_shell_call";
      call_id: null;
      status: "completed" | "in_progress" | "incomplete";
      action: {
        type: "exec";
        command: string[];
        timeout_ms: null;
        working_directory: string | null;
        env: null;
        user: null;
      };
    }
  | {
      type: "web_search_call";
      status?: string;
      action?: unknown;
    };

export type ReconstructableThread = {
  turns: ReconstructableTurn[];
};

export type ReconstructableTurn = {
  items: ReconstructableThreadItem[];
};

export type ReconstructableThreadItem =
  | {
      type: "userMessage";
      content: ReconstructableUserInput[];
    }
  | {
      type: "agentMessage";
      text: string;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "reasoning";
      summary: string[];
      content: string[];
    }
  | {
      type: "commandExecution";
      command: string;
      cwd: string;
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | {
      type: "webSearch";
      query: string;
      action: unknown;
    }
  | {
      type: "enteredReviewMode";
      review: string;
    }
  | {
      type: "exitedReviewMode";
      review: string;
    }
  | {
      type:
        | "contextCompaction"
        | "fileChange"
        | "mcpToolCall"
        | "collabAgentToolCall"
        | "imageView";
    };

export type ReconstructableUserInput =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    }
  | {
      type: "skill";
      name: string;
      path: string;
    }
  | {
      type: "mention";
      name: string;
      path: string;
    };

export type SanitizedSessionStats = {
  droppedInputImageCount: number;
  droppedLocalImageCount: number;
  omittedThreadItemCounts: Record<string, number>;
  preservedCommandExecutionCount: number;
  preservedReasoningCount: number;
  reconstructedMessageCount: number;
};

export type ExtractedResponseItemMetadata = {
  timestamp: string | null;
  payloadType: string | null;
};

export type OriginalResponseItemSlot =
  | {
      kind: "sanitizable";
      timestamp: string | null;
      payloadType: string | null;
    }
  | {
      kind: "compaction";
      line: string;
      timestamp: string | null;
      payloadType: "compaction";
    }
  | {
      kind: "compacted";
      line: string;
    };

export type SanitizedResponseItemWriteEntry =
  | {
      kind: "sanitized";
      timestamp: string | null;
      payload: SanitizedResponseItem;
    }
  | {
      kind: "raw";
      line: string;
    };

const COMPACTION_TYPE_PATTERNS = ['"type":"compaction"', '"type": "compaction"'];
const ENCRYPTED_CONTENT_KEY = '"encrypted_content"';
const RESPONSE_ITEM_TYPE_PATTERNS = ['"type":"response_item"', '"type": "response_item"'];
const PAYLOAD_KEY = '"payload"';
const TIMESTAMP_KEY = '"timestamp"';
const TYPE_KEY = '"type"';
const IMAGE_PLACEHOLDER_TEXT = "<image removed>";
const LOCAL_IMAGE_PLACEHOLDER_TEXT = "<local image removed>";
const TOOL_ARGUMENTS_PLACEHOLDER_LABEL = "function call arguments";
const TOOL_INPUT_PLACEHOLDER_LABEL = "tool input";
const TOOL_OUTPUT_PLACEHOLDER_LABEL = "tool output";
const REASONING_BLOB_PLACEHOLDER_LABEL = "reasoning blob";
const TURN_CONTEXT_BLOB_PLACEHOLDER_LABEL = "turn context blob";
const IMAGE_OPEN_TAG_TEXT = "<image>";
const IMAGE_CLOSE_TAG_TEXT = "</image>";
const LOCAL_IMAGE_OPEN_TAG_PREFIX = "<image name=";
const BLOB_TEXT_THRESHOLD_BYTES = 4096;

export function extractCompactionEncryptedContentFromJsonlLine(
  line: string,
): string | null {
  if (!COMPACTION_TYPE_PATTERNS.some((pattern) => line.includes(pattern))) {
    return null;
  }

  const encryptedContentIndex = line.indexOf(ENCRYPTED_CONTENT_KEY);
  if (encryptedContentIndex < 0) {
    return null;
  }

  const colonIndex = line.indexOf(":", encryptedContentIndex + ENCRYPTED_CONTENT_KEY.length);
  if (colonIndex < 0) {
    return null;
  }

  const openingQuoteIndex = line.indexOf('"', colonIndex + 1);
  if (openingQuoteIndex < 0) {
    return null;
  }

  let cursor = openingQuoteIndex + 1;
  let previousWasEscape = false;
  let value = "";

  while (cursor < line.length) {
    const character = line[cursor];
    if (character === '"' && !previousWasEscape) {
      return value;
    }

    value += character;
    previousWasEscape = character === "\\" && !previousWasEscape;
    if (character !== "\\") {
      previousWasEscape = false;
    }
    cursor += 1;
  }

  return null;
}

export function extractResponseItemMetadataFromJsonlLine(
  line: string,
): ExtractedResponseItemMetadata | null {
  if (!RESPONSE_ITEM_TYPE_PATTERNS.some((pattern) => line.includes(pattern))) {
    return null;
  }

  const payloadIndex = line.indexOf(PAYLOAD_KEY);
  return {
    timestamp: extractJsonStringPropertyValue(line, TIMESTAMP_KEY),
    payloadType:
      payloadIndex >= 0 ? extractJsonStringPropertyValue(line, TYPE_KEY, payloadIndex) : null,
  };
}

export function mapSanitizedResponseItemTimestamps(
  responseItems: SanitizedResponseItem[],
  originalMetadata: ExtractedResponseItemMetadata[],
): Array<string | null> {
  const mappedTimestamps: Array<string | null> = [];
  let nextOriginalIndex = 0;

  for (const responseItem of responseItems) {
    let matchedIndex = -1;

    for (let index = nextOriginalIndex; index < originalMetadata.length; index += 1) {
      const candidate = originalMetadata[index];
      if (!candidate.timestamp) {
        continue;
      }

      if (candidate.payloadType === responseItem.type) {
        matchedIndex = index;
        break;
      }
    }

    if (matchedIndex >= 0) {
      mappedTimestamps.push(originalMetadata[matchedIndex]?.timestamp ?? null);
      nextOriginalIndex = matchedIndex + 1;
      continue;
    }

    while (nextOriginalIndex < originalMetadata.length) {
      const candidate = originalMetadata[nextOriginalIndex];
      nextOriginalIndex += 1;
      if (candidate?.timestamp) {
        mappedTimestamps.push(candidate.timestamp);
        matchedIndex = nextOriginalIndex - 1;
        break;
      }
    }

    if (matchedIndex < 0) {
      mappedTimestamps.push(null);
    }
  }

  return mappedTimestamps;
}

export function mergeSanitizedResponseItemsWithOriginalSequence(
  responseItems: SanitizedResponseItem[],
  originalSlots: OriginalResponseItemSlot[],
): SanitizedResponseItemWriteEntry[] {
  const entries: SanitizedResponseItemWriteEntry[] = [];
  let nextResponseItemIndex = 0;

  for (const slot of originalSlots) {
    if (slot.kind === "compaction" || slot.kind === "compacted") {
      entries.push({
        kind: "raw",
        line: slot.line,
      });
      continue;
    }

    const payload = responseItems[nextResponseItemIndex];
    if (!payload) {
      continue;
    }

    entries.push({
      kind: "sanitized",
      timestamp: slot.timestamp,
      payload,
    });
    nextResponseItemIndex += 1;
  }

  while (nextResponseItemIndex < responseItems.length) {
    entries.push({
      kind: "sanitized",
      timestamp: null,
      payload: responseItems[nextResponseItemIndex],
    });
    nextResponseItemIndex += 1;
  }

  return entries;
}

export function sanitizeCompactedRolloutLine(
  line: string,
  options?: {
    keepImagePlaceholders?: boolean;
    stripBlobContent?: boolean;
    stats?: SanitizedSessionStats;
  },
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asObject(parsed);
  if (!record || record.type !== "compacted") {
    return null;
  }

  const payload = asObject(record.payload);
  if (!payload || !Array.isArray(payload.replacement_history)) {
    return line;
  }

  const sanitizedReplacementHistory = payload.replacement_history.map((item) =>
    sanitizeReplacementHistoryResponseItem(item, {
      keepImagePlaceholders: options?.keepImagePlaceholders ?? true,
      stripBlobContent: false,
      stats: options?.stats ?? null,
    }),
  );

  return JSON.stringify({
    ...record,
    payload: {
      ...payload,
      replacement_history: sanitizedReplacementHistory,
    },
  });
}

export function sanitizeResponseItemJsonlLine(
  line: string,
  options?: {
    keepImagePlaceholders?: boolean;
    stripBlobContent?: boolean;
    stats?: SanitizedSessionStats;
  },
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asObject(parsed);
  if (!record || record.type !== "response_item") {
    return null;
  }

  const payload = asObject(record.payload);
  if (!payload || typeof payload.type !== "string") {
    return line;
  }

  const sanitizedPayload = sanitizeResponseItemPayload(payload, {
    keepImagePlaceholders: options?.keepImagePlaceholders ?? true,
    stripBlobContent: options?.stripBlobContent ?? false,
    stats: options?.stats ?? null,
  });

  if (sanitizedPayload !== payload) {
    return JSON.stringify({
      ...record,
      payload: sanitizedPayload,
    });
  }

  return line;
}

export function sanitizeEventMsgJsonlLine(
  line: string,
  options?: {
    keepImagePlaceholders?: boolean;
    stripBlobContent?: boolean;
    stats?: SanitizedSessionStats;
  },
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asObject(parsed);
  if (!record || record.type !== "event_msg") {
    return null;
  }

  const payload = asObject(record.payload);
  if (!payload || payload.type !== "user_message") {
    if (payload?.type === "token_count" && (options?.stripBlobContent ?? false)) {
      return JSON.stringify({
        ...record,
        payload: {
          type: "token_count",
        },
      });
    }

    return line;
  }

  const imageCount = Array.isArray(payload.images) ? payload.images.length : 0;
  const localImageCount = Array.isArray(payload.local_images) ? payload.local_images.length : 0;

  if (imageCount === 0 && localImageCount === 0) {
    return line;
  }

  if (options?.stats) {
    options.stats.droppedInputImageCount += imageCount;
    options.stats.droppedLocalImageCount += localImageCount;
  }

  const placeholderText = options?.keepImagePlaceholders ?? true
    ? buildEventMessagePlaceholderText(imageCount, localImageCount)
    : null;

  return JSON.stringify({
    ...record,
    payload: {
      ...payload,
      message: appendPlaceholderTextToMessage(
        typeof payload.message === "string" ? payload.message : null,
        placeholderText,
      ),
      images: [],
      local_images: [],
    },
  });
}

export function sanitizeTurnContextJsonlLine(
  line: string,
  options?: {
    stripBlobContent?: boolean;
  },
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asObject(parsed);
  if (!record || record.type !== "turn_context") {
    return null;
  }

  if (!(options?.stripBlobContent ?? false)) {
    return line;
  }

  const payload = asObject(record.payload);
  if (!payload) {
    return line;
  }

  return JSON.stringify({
    ...record,
    payload: sanitizeLargeStringsInValue(payload, TURN_CONTEXT_BLOB_PLACEHOLDER_LABEL),
  });
}

export function reconstructSanitizedResponseItems(
  thread: ReconstructableThread,
  options?: {
    keepImagePlaceholders?: boolean;
  },
): {
  responseItems: SanitizedResponseItem[];
  stats: SanitizedSessionStats;
} {
  const responseItems: SanitizedResponseItem[] = [];
  const stats: SanitizedSessionStats = {
    droppedInputImageCount: 0,
    droppedLocalImageCount: 0,
    omittedThreadItemCounts: {},
    preservedCommandExecutionCount: 0,
    preservedReasoningCount: 0,
    reconstructedMessageCount: 0,
  };

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      switch (item.type) {
        case "userMessage": {
          const content = reconstructUserContent(item.content, stats, {
            keepImagePlaceholders: options?.keepImagePlaceholders ?? true,
          });
          if (content.length === 0) {
            continue;
          }

          responseItems.push({
            type: "message",
            role: "user",
            content,
          });
          stats.reconstructedMessageCount += 1;
          break;
        }
        case "agentMessage": {
          responseItems.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: item.text }],
          });
          stats.reconstructedMessageCount += 1;
          break;
        }
        case "plan": {
          responseItems.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `[Plan]\n${item.text}` }],
          });
          stats.reconstructedMessageCount += 1;
          break;
        }
        case "reasoning": {
          responseItems.push({
            type: "reasoning",
            summary: item.summary.map((text) => ({ type: "summary_text", text })),
            content: item.content.map((text) => ({ type: "text", text })),
            encrypted_content: null,
          });
          stats.preservedReasoningCount += 1;
          break;
        }
        case "commandExecution": {
          responseItems.push({
            type: "local_shell_call",
            call_id: null,
            status: mapCommandExecutionStatus(item.status),
            action: {
              type: "exec",
              command: [item.command],
              timeout_ms: null,
              working_directory: item.cwd || null,
              env: null,
              user: null,
            },
          });
          stats.preservedCommandExecutionCount += 1;
          break;
        }
        case "webSearch": {
          responseItems.push({
            type: "web_search_call",
            status: "completed",
            action: item.action,
          });
          break;
        }
        case "enteredReviewMode": {
          responseItems.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: `[Entered review mode]\n${item.review}`,
              },
            ],
          });
          stats.reconstructedMessageCount += 1;
          break;
        }
        case "exitedReviewMode": {
          responseItems.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: `[Exited review mode]\n${item.review}`,
              },
            ],
          });
          stats.reconstructedMessageCount += 1;
          break;
        }
        default: {
          stats.omittedThreadItemCounts[item.type] =
            (stats.omittedThreadItemCounts[item.type] ?? 0) + 1;
          break;
        }
      }
    }
  }

  return {
    responseItems,
    stats,
  };
}

function reconstructUserContent(
  content: ReconstructableUserInput[],
  stats: SanitizedSessionStats,
  options: {
    keepImagePlaceholders: boolean;
  },
): SanitizedContentItem[] {
  const reconstructed: SanitizedContentItem[] = [];

  for (const part of content) {
    switch (part.type) {
      case "text":
        if (part.text) {
          reconstructed.push({ type: "input_text", text: part.text });
        }
        break;
      case "image":
        stats.droppedInputImageCount += 1;
        if (options.keepImagePlaceholders) {
          reconstructed.push({ type: "input_text", text: "<image removed>" });
        }
        break;
      case "localImage":
        stats.droppedLocalImageCount += 1;
        if (options.keepImagePlaceholders) {
          reconstructed.push({ type: "input_text", text: "<local image removed>" });
        }
        break;
      case "skill":
        reconstructed.push({
          type: "input_text",
          text: `[Skill] ${part.name} (${part.path})`,
        });
        break;
      case "mention":
        reconstructed.push({
          type: "input_text",
          text: `[Mention] ${part.name} (${part.path})`,
        });
        break;
      default:
        break;
    }
  }

  return mergeAdjacentTextItems(reconstructed);
}

function mergeAdjacentTextItems(content: SanitizedContentItem[]): SanitizedContentItem[] {
  const merged: SanitizedContentItem[] = [];

  for (const item of content) {
    const previous = merged.at(-1);
    if (previous?.type === item.type) {
      previous.text = `${previous.text}\n${item.text}`;
      continue;
    }

    merged.push({ ...item });
  }

  return merged;
}

function mapCommandExecutionStatus(
  status: "inProgress" | "completed" | "failed" | "declined",
): "completed" | "in_progress" | "incomplete" {
  switch (status) {
    case "completed":
      return "completed";
    case "inProgress":
      return "in_progress";
    default:
      return "incomplete";
  }
}

function sanitizeReplacementHistoryResponseItem(
  item: unknown,
  options: {
    keepImagePlaceholders: boolean;
    stripBlobContent: boolean;
    stats: SanitizedSessionStats | null;
  },
): unknown {
  const record = asObject(item);
  if (!record || typeof record.type !== "string") {
    return item;
  }

  return sanitizeResponseItemPayload(record, options);
}

function sanitizeContentItemArray(
  items: unknown[],
  options: {
    keepImagePlaceholders: boolean;
    stripBlobContent?: boolean;
    stats: SanitizedSessionStats | null;
  },
): unknown[] {
  const sanitizedItems: unknown[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const record = asObject(item);
    if (!record || typeof record.type !== "string") {
      sanitizedItems.push(item);
      continue;
    }

    if (record.type === "input_image") {
      const previous = asObject(sanitizedItems.at(-1));
      const previousText = typeof previous?.text === "string" ? previous.text : null;
      const next = asObject(items[index + 1]);
      const nextText = typeof next?.text === "string" ? next.text : null;
      const hasWrappingOpenTag = isImageOpenTagText(previousText) || isLocalImageOpenTagText(previousText);
      const hasWrappingCloseTag = isImageCloseTagText(nextText);
      const isLocalImage = isLocalImageOpenTagText(previousText);

      if (hasWrappingOpenTag) {
        sanitizedItems.pop();
      }
      if (hasWrappingCloseTag) {
        index += 1;
      }

      if (isLocalImage) {
        options.stats && (options.stats.droppedLocalImageCount += 1);
      } else {
        options.stats && (options.stats.droppedInputImageCount += 1);
      }

      if (options.keepImagePlaceholders) {
        sanitizedItems.push({
          type: "input_text",
          text: isLocalImage ? LOCAL_IMAGE_PLACEHOLDER_TEXT : IMAGE_PLACEHOLDER_TEXT,
        });
      }
      continue;
    }

    sanitizedItems.push(item);
  }

  return mergeAdjacentRawTextItems(sanitizedItems);
}

function sanitizeResponseItemPayload(
  payload: Record<string, any>,
  options: {
    keepImagePlaceholders: boolean;
    stripBlobContent: boolean;
    stats: SanitizedSessionStats | null;
  },
): Record<string, any> {
  let sanitizedPayload = payload;

  if (payload.type === "message" && Array.isArray(payload.content)) {
    const content = sanitizeContentItemArray(payload.content, options);
    if (content !== payload.content) {
      sanitizedPayload = {
        ...sanitizedPayload,
        content,
      };
    }
  }

  if (
    (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") &&
    Array.isArray(payload.output)
  ) {
    const output = sanitizeContentItemArray(payload.output, options);
    if (output !== payload.output) {
      sanitizedPayload = {
        ...sanitizedPayload,
        output,
      };
    }
  }

  if (options.stripBlobContent) {
    sanitizedPayload = sanitizeResponseItemBlobFields(sanitizedPayload);
  }

  return sanitizedPayload;
}

function sanitizeResponseItemBlobFields(payload: Record<string, any>): Record<string, any> {
  if (payload.type === "function_call" && typeof payload.arguments === "string") {
    if (shouldStripBlobString(payload.arguments)) {
      return {
        ...payload,
        arguments: formatRemovedBlobPlaceholder(
          TOOL_ARGUMENTS_PLACEHOLDER_LABEL,
          payload.arguments,
        ),
      };
    }
    return payload;
  }

  if (payload.type === "custom_tool_call" && typeof payload.input === "string") {
    if (shouldStripBlobString(payload.input)) {
      return {
        ...payload,
        input: formatRemovedBlobPlaceholder(TOOL_INPUT_PLACEHOLDER_LABEL, payload.input),
      };
    }
    return payload;
  }

  if (payload.type === "reasoning" && typeof payload.encrypted_content === "string") {
    if (shouldStripBlobString(payload.encrypted_content)) {
      return {
        ...payload,
        encrypted_content: formatRemovedBlobPlaceholder(
          REASONING_BLOB_PLACEHOLDER_LABEL,
          payload.encrypted_content,
        ),
      };
    }
    return payload;
  }

  if (
    (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") &&
    typeof payload.output === "string"
  ) {
    if (shouldStripBlobString(payload.output)) {
      return {
        ...payload,
        output: sanitizeToolOutputString(payload.output),
      };
    }
    return payload;
  }

  return payload;
}

function mergeAdjacentRawTextItems(items: unknown[]): unknown[] {
  const merged: unknown[] = [];

  for (const item of items) {
    const current = asObject(item);
    const previous = asObject(merged.at(-1));
    if (
      current?.type === "input_text" &&
      typeof current.text === "string" &&
      previous?.type === "input_text" &&
      typeof previous.text === "string"
    ) {
      previous.text = `${previous.text}\n${current.text}`;
      continue;
    }

    if (
      current?.type === "output_text" &&
      typeof current.text === "string" &&
      previous?.type === "output_text" &&
      typeof previous.text === "string"
    ) {
      previous.text = `${previous.text}\n${current.text}`;
      continue;
    }

    merged.push(cloneJsonValue(item));
  }

  return merged;
}

function buildEventMessagePlaceholderText(
  imageCount: number,
  localImageCount: number,
): string | null {
  const placeholders: string[] = [];

  for (let index = 0; index < imageCount; index += 1) {
    placeholders.push(IMAGE_PLACEHOLDER_TEXT);
  }

  for (let index = 0; index < localImageCount; index += 1) {
    placeholders.push(LOCAL_IMAGE_PLACEHOLDER_TEXT);
  }

  return placeholders.length > 0 ? placeholders.join("\n") : null;
}

function appendPlaceholderTextToMessage(
  message: string | null,
  placeholderText: string | null,
): string {
  if (!placeholderText) {
    return message ?? "";
  }

  if (!message) {
    return placeholderText;
  }

  return `${message}\n${placeholderText}`;
}

function sanitizeToolOutputString(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return formatRemovedBlobPlaceholder(TOOL_OUTPUT_PLACEHOLDER_LABEL, output);
  }

  const record = asObject(parsed);
  if (!record) {
    return formatRemovedBlobPlaceholder(TOOL_OUTPUT_PLACEHOLDER_LABEL, output);
  }

  const metadata = asObject(record.metadata);
  return JSON.stringify({
    output: formatRemovedBlobPlaceholder(TOOL_OUTPUT_PLACEHOLDER_LABEL, output),
    metadata:
      metadata && (metadata.exit_code !== undefined || metadata.duration_seconds !== undefined)
        ? {
            ...(metadata.exit_code !== undefined ? { exit_code: metadata.exit_code } : {}),
            ...(metadata.duration_seconds !== undefined
              ? { duration_seconds: metadata.duration_seconds }
              : {}),
          }
        : null,
  });
}

function sanitizeLargeStringsInValue(value: unknown, label: string): unknown {
  if (typeof value === "string") {
    return shouldStripBlobString(value) ? formatRemovedBlobPlaceholder(label, value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLargeStringsInValue(entry, label));
  }

  const record = asObject(value);
  if (!record) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, sanitizeLargeStringsInValue(entry, label)]),
  );
}

function shouldStripBlobString(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > BLOB_TEXT_THRESHOLD_BYTES;
}

function formatRemovedBlobPlaceholder(label: string, text: string): string {
  return `<${label} removed: ${Buffer.byteLength(text, "utf8")} bytes>`;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        cloneJsonValue(entry),
      ]),
    ) as T;
  }

  return value;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function isImageOpenTagText(text: string | null): boolean {
  return text === IMAGE_OPEN_TAG_TEXT;
}

function isImageCloseTagText(text: string | null): boolean {
  return text === IMAGE_CLOSE_TAG_TEXT;
}

function isLocalImageOpenTagText(text: string | null): boolean {
  return (
    typeof text === "string" &&
    text.startsWith(LOCAL_IMAGE_OPEN_TAG_PREFIX) &&
    text.endsWith(">")
  );
}

function extractJsonStringPropertyValue(
  line: string,
  key: string,
  startIndex = 0,
): string | null {
  const keyIndex = line.indexOf(key, startIndex);
  if (keyIndex < 0) {
    return null;
  }

  const colonIndex = line.indexOf(":", keyIndex + key.length);
  if (colonIndex < 0) {
    return null;
  }

  const openingQuoteIndex = line.indexOf('"', colonIndex + 1);
  if (openingQuoteIndex < 0) {
    return null;
  }

  let cursor = openingQuoteIndex + 1;
  let previousWasEscape = false;
  let value = "";

  while (cursor < line.length) {
    const character = line[cursor];
    if (character === '"' && !previousWasEscape) {
      return value;
    }

    value += character;
    previousWasEscape = character === "\\" && !previousWasEscape;
    if (character !== "\\") {
      previousWasEscape = false;
    }
    cursor += 1;
  }

  return null;
}
