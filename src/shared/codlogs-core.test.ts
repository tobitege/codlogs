import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AUTO_DETAIL_PARSE_LIMIT_BYTES,
  EXPORT_MAX_JSONL_LINE_BYTES,
  MAX_JSONL_LINE_BYTES_HARD,
  exportSessionJsonlToHtml,
  exportSessionJsonlToMarkdown,
  findCodexSessions,
  getSessionDetailMetrics,
  mergeErroredToolCallPatterns,
  readSessionErroredToolCalls,
  readSessionTokenUsage,
  type SessionErroredToolCallPattern,
} from "./codlogs-core.ts";
import {
  buildCodexCurrentDayRolloutPath,
  buildCodexRolloutFileName,
  formatCodexRolloutTimestamp,
  generateUuidV7String,
} from "./codex-rollout.ts";
import {
  type OriginalResponseItemSlot,
  type SanitizedResponseItem,
  extractCompactionEncryptedContentFromJsonlLine,
  extractResponseItemMetadataFromJsonlLine,
  mapSanitizedResponseItemTimestamps,
  mergeSanitizedResponseItemsWithOriginalSequence,
  reconstructSanitizedResponseItems,
  sanitizeCompactedRolloutLine,
  sanitizeEventMsgJsonlLine,
  sanitizeResponseItemJsonlLine,
  sanitizeTurnContextJsonlLine,
} from "./sanitized-session.ts";
import {
  MAX_SESSION_TITLE_LENGTH,
  normalizeSessionTitle,
  sanitizeSessionTitleInput,
} from "./session-title.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) {
      continue;
    }

    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

describe("session export regressions", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const message = (content: unknown, extra: Record<string, unknown> = {}) => ({
    type: "response_item",
    timestamp: "2026-09-14T10:00:00Z",
    payload: { type: "message", role: "user", content, ...extra },
  });
  async function fixture(rows: unknown[], name = "session"): Promise<string> {
    const directory = await createTempDir("codlogs-export-review-");
    const file = path.join(directory, `${name}.jsonl`);
    const meta = { type: "session_meta", payload: { id: "review", cwd: directory } };
    await fs.writeFile(file, [meta, ...rows].map(row => JSON.stringify(row)).join("\n"));
    return file;
  }

  test("escapes every HTML message and reasoning header field", async () => {
    const attack = '<img src=x onerror="alert(1)">';
    const file = await fixture([
      { ...message([{ text: "body" }], { role: attack, phase: attack }), timestamp: attack },
      { type: "response_item", timestamp: attack, payload: { type: "reasoning", summary: [{ text: attack }] } },
    ]);
    const html = await fs.readFile(await exportSessionJsonlToHtml(file), "utf8");
    expect(html).not.toContain(attack);
    expect(html).toContain("&lt;img");
    expect(html).toContain('class="bubble bubble-unknown"');
  });

  for (const format of ["markdown", "html"] as const) {
    const exporter = format === "markdown" ? exportSessionJsonlToMarkdown : exportSessionJsonlToHtml;
    const extension = format === "markdown" ? "md" : "html";

    test(`${format} preserves text/image order and indentation`, async () => {
      const file = await fixture([message([
        { text: "    first\n      second" },
        { type: "input_image", image_url: png },
        { text: "after image" },
      ])]);
      const output = await fs.readFile(await exporter(file, { includeImages: true }), "utf8");
      expect(output).toContain("    first\n      second");
      const imageOffset = output.indexOf(format === "markdown" ? "![Image" : "<img src=");
      expect(imageOffset).toBeGreaterThan(output.indexOf("    first"));
      expect(imageOffset).toBeLessThan(output.indexOf("after image"));
      if (format === "html") expect(output).toContain("white-space: pre-wrap");
    });

    test(`${format} keeps later user messages that quote bootstrap instructions`, async () => {
      const quoted = "Please explain <environment_context> and # AGENTS.md instructions.";
      const file = await fixture([
        message([{ text: "# AGENTS.md instructions for demo" }, { type: "input_image", image_url: png }]),
        message([{ text: "real question" }]),
        message([{ text: quoted }]),
      ]);
      const outputPath = await exporter(file, { includeImages: true });
      const output = await fs.readFile(outputPath, "utf8");
      expect(output).not.toContain("instructions for demo");
      expect(output).toContain("Please explain");
      expect(output).not.toContain("iVBORw0KGgo=");
      const names = await fs.readdir(path.dirname(file));
      expect(names.some(name => name.endsWith(".assets"))).toBe(false);
    });

    test(`${format} ignores non-object JSON and accepts UTF-8 BOM metadata`, async () => {
      const file = await fixture([null, false, [], 123, message([{ text: "kept" }])]);
      await fs.writeFile(file, `\uFEFF${await fs.readFile(file, "utf8")}\n{broken\n`);
      const output = await fs.readFile(await exporter(file), "utf8");
      expect(output).toContain("kept");
    });

    test(`${format} cancellation preserves existing transcript and sidecars`, async () => {
      const file = await fixture([message([{ text: "replacement" }, { type: "input_image", image_url: png }])]);
      const outputPath = file.replace(/\.jsonl$/, `.${extension}`);
      const assetDirectory = file.replace(/\.jsonl$/, ".assets");
      await fs.writeFile(outputPath, "previous export");
      await fs.mkdir(assetDirectory);
      const assetPath = path.join(assetDirectory, "image-001.png");
      await fs.writeFile(assetPath, "previous asset");
      const controller = new AbortController();
      await expect(exporter(file, { includeImages: true }, {
        signal: controller.signal,
        onProgress(progress) { if (progress.progressPercent === 96) controller.abort(); },
      })).rejects.toThrow();
      expect(await fs.readFile(outputPath, "utf8")).toBe("previous export");
      expect(await fs.readFile(assetPath, "utf8")).toBe("previous asset");
    });

    test(`${format} reports destination errors as promise rejection`, async () => {
      const file = await fixture([message([{ text: "body" }])]);
      const destination = file.replace(/\.jsonl$/, `.${extension}`);
      await fs.mkdir(destination);
      await expect(exporter(file)).rejects.toThrow();
      expect((await fs.stat(destination)).isDirectory()).toBe(true);
    });

    test(`${format} rejects unsafe image URLs and preserves ordinary URL-bearing text`, async () => {
      const file = await fixture([message([
        { type: "input_image", image_url: "javascript:alert(1)" },
        { type: "input_image", image_url: "file:///private/image.png" },
        { type: "input_text", text: "keep linked text", url: "https://example.com" },
        { type: "input_image", image_url: { url: png } },
      ])]);
      const output = await fs.readFile(await exporter(file, { includeImages: true }), "utf8");
      expect(output).not.toContain("javascript:");
      expect(output).not.toContain("file:///private");
      expect(output).toContain("keep linked text");
      expect(output).toContain(format === "markdown" ? "![Image 1]" : 'alt="Image 1"');
    });

    test(`${format} includes all tool types only when requested`, async () => {
      const file = await fixture([
        ...["function_call", "custom_tool_call"].map(type => ({ type: "response_item", payload: { type, name: "review-tool", arguments: "args", input: "input" } })),
        ...["function_call_output", "custom_tool_call_output"].map(type => ({ type: "response_item", payload: { type, call_id: "review-call", output: "tool result" } })),
      ]);
      const hidden = await fs.readFile(await exporter(file), "utf8");
      const included = await fs.readFile(await exporter(file, { includeToolCallResults: true }), "utf8");
      expect(hidden).not.toContain("review-tool");
      expect(hidden).not.toContain("tool result");
      expect(included).toContain("review-tool");
      expect(included).toContain("review-call");
      expect(included.match(/tool result/g)?.length).toBe(2);
    });

    test(`${format} stays successful after the committed output receives late cancellation`, async () => {
      const file = await fixture([message([{ text: "complete" }])]);
      const controller = new AbortController();
      const output = await exporter(file, {}, {
        signal: controller.signal,
        onProgress(progress) { if (progress.progressPercent === 100) controller.abort(); },
      });
      expect(await fs.readFile(output, "utf8")).toContain("complete");
    });
  }

  test("HTML inline and external images have successive labels", async () => {
    const file = await fixture([message([
      { type: "input_image", image_url: png },
      { type: "input_image", image_url: "https://example.com/image.png" },
      { type: "input_image", image_url: png },
    ])]);
    const html = await fs.readFile(await exportSessionJsonlToHtml(file, { includeImages: true }), "utf8");
    for (const index of [1, 2, 3]) expect(html).toContain(`alt="Image ${index}"`);
  });

  test("HTML sidecars follow the selected output name and cannot overwrite another export", async () => {
    const file = await fixture([message([{ type: "input_image", image_url: png }])], "source");
    const outputPath = path.join(path.dirname(file), "chosen (name) #1.html");
    await exportSessionJsonlToHtml(file, { includeImages: true, inlineImages: false, outputPath });
    const first = await fs.readFile(outputPath, "utf8");
    const src = first.match(/<img src="([^"]+)"/)?.[1];
    expect(src).toBeDefined();
    expect(src).toContain("chosen%20%28name%29%20%231.assets/");
    const imagePath = path.resolve(path.dirname(file), decodeURIComponent(src!));
    expect((await fs.readFile(imagePath)).toString("base64")).toBe("iVBORw0KGgo=");
    await exportSessionJsonlToHtml(file, { includeImages: true, inlineImages: false, outputPath });
    expect((await fs.readFile(imagePath)).toString("base64")).toBe("iVBORw0KGgo=");
  });

  test("Markdown image links encode punctuation and reject malformed base64", async () => {
    const file = await fixture([message([
      { type: "input_image", image_url: png, alt_text: "A [bracket] <tag>\nnext" },
      { type: "input_image", image_url: "data:image/png;base64,!!!" },
    ])], "name (x) #1");
    const markdown = await fs.readFile(await exportSessionJsonlToMarkdown(file, { includeImages: true }), "utf8");
    expect(markdown).toContain("name%20%28x%29%20%231.assets/");
    expect(markdown.match(/!\[/g)?.length).toBe(1);
    expect(markdown).not.toContain("<tag>");
  });

  test("Markdown code fences handle many tilde runs without argument overflow", async () => {
    const output = "~x".repeat(160000) + "\n~~~~\n";
    const file = await fixture([{ type: "response_item", payload: { type: "function_call_output", output } }]);
    const markdown = await fs.readFile(await exportSessionJsonlToMarkdown(file, { includeToolCallResults: true }), "utf8");
    expect(markdown).toContain(`~~~~~text\n${output}\n~~~~~`);
  });

  test("Node CLI writes HTML sidecars and handles large Markdown tool output", async () => {
    const output = "~x".repeat(160000) + "\n~~~~\n";
    const file = await fixture([
      message([{ type: "input_image", image_url: png }]),
      { type: "response_item", payload: { type: "function_call_output", output } },
    ]);
    const cli = path.resolve(import.meta.dir, "../../codlogs-sessions.ts");
    const run = (args: string[]) => execFileSync("node", ["--no-warnings", "--experimental-strip-types", cli, ...args], { windowsHide: true });
    run(["--html", file, "--include-images"]);
    const html = await fs.readFile(file.replace(/\.jsonl$/, ".html"), "utf8");
    expect(html).toContain("./session.assets/");
    expect(html).not.toContain(png);
    run(["--md", file, "--include-tool-results"]);
    const markdown = await fs.readFile(file.replace(/\.jsonl$/, ".md"), "utf8");
    expect(markdown).toContain(`~~~~~text\n${output}\n~~~~~`);
  });

  test("Markdown escapes generated headings and image labels", async () => {
    const file = await fixture([message([
      { type: "input_image", image_url: png, alt_text: "[label] *text*" },
    ], { phase: "\n# injected" })]);
    const markdown = await fs.readFile(await exportSessionJsonlToMarkdown(file, { includeImages: true }), "utf8");
    expect(markdown).toContain("![\\[label\\] \\*text\\*]");
    expect(markdown).not.toContain("\n# injected");
  });

  test("oversized export rows report their complete byte length and preserve an existing export", async () => {
    const file = await fixture([]);
    const outputPath = file.replace(/\.jsonl$/, ".md");
    await fs.writeFile(outputPath, "previous export");
    const handle = await fs.open(file, "a");
    const chunk = "x".repeat(1024 * 1024);
    try {
      await handle.writeFile("\n");
      for (let count = 0; count < EXPORT_MAX_JSONL_LINE_BYTES / chunk.length; count++) {
        await handle.writeFile(chunk);
      }
      await handle.writeFile(`${"x".repeat(73)}\n`);
    } finally {
      await handle.close();
    }
    await expect(exportSessionJsonlToMarkdown(file)).rejects.toMatchObject({
      name: "OversizedJsonlLineError", byteLength: EXPORT_MAX_JSONL_LINE_BYTES + 73,
    });
    expect(await fs.readFile(outputPath, "utf8")).toBe("previous export");
  }, 20000);
});

async function writeSessionMetaFile(options: {
  codexHome: string;
  rootName: "sessions" | "archived_sessions";
  folderDate: string;
  id: string;
  cwd: string;
  metadataTimestamp: string;
}): Promise<string> {
  const [year = "0000", month = "00", day = "00"] = options.folderDate.split("-");
  const sessionDirectory = path.join(options.codexHome, options.rootName, year, month, day);
  const sessionPath = path.join(sessionDirectory, `${options.id}.jsonl`);
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: options.id,
        cwd: options.cwd,
        timestamp: options.metadataTimestamp,
      },
    })}\n`,
  );
  return sessionPath;
}

describe("codex rollout naming helpers", () => {
  test("formats canonical rollout timestamps with local second precision", () => {
    const date = new Date(2026, 2, 17, 9, 8, 7, 654);

    expect(formatCodexRolloutTimestamp(date)).toBe("2026-03-17T09-08-07");
  });

  test("generates UUIDv7 thread ids", () => {
    const threadId = generateUuidV7String(
      new Date(2026, 2, 17, 9, 8, 7, 654),
      new Uint8Array([
        0x10, 0x11, 0x12, 0x13,
        0x14, 0x15, 0x16, 0x17,
        0x18, 0x19, 0x1a, 0x1b,
        0x1c, 0x1d, 0x1e, 0x1f,
      ]),
    );

    expect(threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("builds canonical current-day rollout paths", () => {
    const date = new Date(2026, 2, 17, 9, 8, 7, 654);
    const threadId = "0195a7d2-93f1-7abc-8def-0123456789ab";

    expect(buildCodexRolloutFileName(threadId, date)).toBe(
      "rollout-2026-03-17T09-08-07-0195a7d2-93f1-7abc-8def-0123456789ab.jsonl",
    );
    expect(buildCodexCurrentDayRolloutPath("C:\\Users\\tobias\\.codex", threadId, date)).toBe(
      path.join(
        "C:\\Users\\tobias\\.codex",
        "sessions",
        "2026",
        "03",
        "17",
        "rollout-2026-03-17T09-08-07-0195a7d2-93f1-7abc-8def-0123456789ab.jsonl",
      ),
    );
  });
});

describe("session title sanitization", () => {
  test("removes control and bidi characters and collapses whitespace", () => {
    expect(
      sanitizeSessionTitleInput("  Hello\u0000\tworld\u202E  from\r\nCodex  "),
    ).toBe("Hello world from Codex");
  });

  test("returns null for empty sanitized titles and caps length", () => {
    expect(normalizeSessionTitle(" \n\t ")).toBeNull();
    expect(
      sanitizeSessionTitleInput("x".repeat(MAX_SESSION_TITLE_LENGTH + 20)).length,
    ).toBe(MAX_SESSION_TITLE_LENGTH);
  });
});

describe("session discovery filters", () => {
  test("filters sessions by Codex folder date before metadata timestamps", async () => {
    const tempDir = await createTempDir("codlogs-date-filter-");
    const codexHome = path.join(tempDir, ".codex");
    const repoPath = path.join(tempDir, "repo");
    await fs.mkdir(repoPath, { recursive: true });

    await writeSessionMetaFile({
      codexHome,
      rootName: "sessions",
      folderDate: "2026-03-27",
      id: "folder-date-match",
      cwd: repoPath,
      metadataTimestamp: "2026-04-30T10:00:00.000Z",
    });
    await writeSessionMetaFile({
      codexHome,
      rootName: "sessions",
      folderDate: "2026-04-30",
      id: "metadata-only-match",
      cwd: repoPath,
      metadataTimestamp: "2026-03-27T10:00:00.000Z",
    });
    await writeSessionMetaFile({
      codexHome,
      rootName: "archived_sessions",
      folderDate: "2026-03-27",
      id: "archived-folder-date-match",
      cwd: repoPath,
      metadataTimestamp: "2026-04-30T11:00:00.000Z",
    });

    const result = await findCodexSessions({
      codexHome,
      currentWorkingDirectory: repoPath,
      dateFrom: "2026-03-27",
      dateTo: "2026-03-27",
    });

    expect(result.sessions.map((session) => session.id).sort()).toEqual([
      "archived-folder-date-match",
      "folder-date-match",
    ]);
  });
});

describe("large-session hardening", () => {
  test("skips automatic detail analysis for oversized files", async () => {
    const tempDir = await createTempDir("codlogs-large-session-");
    const sessionPath = path.join(tempDir, "too-large.jsonl");

    await fs.writeFile(sessionPath, "");
    await fs.truncate(sessionPath, AUTO_DETAIL_PARSE_LIMIT_BYTES + 1);

    const metrics = await getSessionDetailMetrics(sessionPath);

    expect(metrics.analysisKind).toBe("skipped");
    expect(metrics.fileSizeBytes).toBe(AUTO_DETAIL_PARSE_LIMIT_BYTES + 1);
    expect(metrics.skipReason).toContain("Automatic analysis is disabled");
    expect(metrics.interactionCount).toBe(0);
    expect(metrics.toolCallCount).toBe(0);
    expect(metrics.tokenUsage).toBeNull();
  });

  test("returns the latest cumulative token usage from token count rows", async () => {
    const tempDir = await createTempDir("codlogs-token-usage-");
    const sessionPath = path.join(tempDir, "token-usage.jsonl");

    const userMessage = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      timestamp: "2026-03-14T12:00:00.000Z",
    });
    const tokenCount = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 40657493,
            cached_input_tokens: 38628608,
            output_tokens: 138294,
            reasoning_output_tokens: 56128,
            total_tokens: 40795787,
          },
        },
      },
      timestamp: "2026-03-14T12:01:00.000Z",
    });

    await fs.writeFile(sessionPath, `${userMessage}\n${tokenCount}\n`);

    const metrics = await getSessionDetailMetrics(sessionPath);

    expect(metrics.interactionCount).toBe(1);
    expect(metrics.tokenUsage).toEqual({
      inputTokens: 40657493,
      cachedInputTokens: 38628608,
      outputTokens: 138294,
      reasoningOutputTokens: 56128,
      totalTokens: 40795787,
    });
  });

  test("scans token usage without parsing unrelated transcript rows", async () => {
    const tempDir = await createTempDir("codlogs-token-scan-");
    const sessionPath = path.join(tempDir, "token-scan.jsonl");

    const unrelatedRow = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "x".repeat(1024),
      },
    });
    const tokenCount = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 12,
            reasoning_output_tokens: 5,
            total_tokens: 112,
          },
        },
      },
    });

    await fs.writeFile(sessionPath, `${unrelatedRow}\n${tokenCount}\n`);

    const progressEvents: number[] = [];
    const result = await readSessionTokenUsage(sessionPath, {
      onProgress: (progress) => {
        progressEvents.push(progress.bytesProcessed);
      },
    });

    expect(result.tokenCountRows).toBe(1);
    expect(result.oversizedLineCount).toBe(0);
    expect(result.tokenUsage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 12,
      reasoningOutputTokens: 5,
      totalTokens: 112,
    });
    expect(progressEvents.at(-1)).toBe(result.fileSizeBytes);
  });

  test("groups errored tool calls by tool input and normalized error pattern", async () => {
    const tempDir = await createTempDir("codlogs-tool-error-scan-");
    const sessionPath = path.join(tempDir, "tool-errors.jsonl");
    const makeResponseItem = (payload: Record<string, unknown>, timestamp: string) =>
      JSON.stringify({
        type: "response_item",
        payload,
        timestamp,
      });

    const firstCall = makeResponseItem(
      {
        type: "function_call",
        call_id: "call_1",
        name: "functions.exec_command",
        arguments: JSON.stringify({ cmd: "rg missing src", shell: "pwsh" }),
      },
      "2026-03-14T12:00:00.000Z",
    );
    const firstOutput = makeResponseItem(
      {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({
          output: "ParserError: Unexpected token at D:\\github\\codlogs\\src\\file.ts:12:3",
          metadata: { exit_code: 1, duration_seconds: 0.5 },
        }),
      },
      "2026-03-14T12:00:03.000Z",
    );
    const secondCall = makeResponseItem(
      {
        type: "function_call",
        call_id: "call_2",
        name: "functions.exec_command",
        arguments: JSON.stringify({ shell: "pwsh", cmd: "rg missing src" }),
      },
      "2026-03-14T12:01:00.000Z",
    );
    const secondOutput = makeResponseItem(
      {
        type: "function_call_output",
        call_id: "call_2",
        output: JSON.stringify({
          output: "ParserError: Unexpected token at D:\\github\\codlogs\\src\\other.ts:99:7",
          metadata: { exit_code: 1, duration_seconds: 0.4 },
        }),
      },
      "2026-03-14T12:01:03.000Z",
    );
    const successCall = makeResponseItem(
      {
        type: "function_call",
        call_id: "call_3",
        name: "functions.exec_command",
        arguments: JSON.stringify({ cmd: "rg present src", shell: "pwsh" }),
      },
      "2026-03-14T12:02:00.000Z",
    );
    const successOutput = makeResponseItem(
      {
        type: "function_call_output",
        call_id: "call_3",
        output: JSON.stringify({
          output: "src\\file.ts:1:present",
          metadata: { exit_code: 0, duration_seconds: 0.2 },
        }),
      },
      "2026-03-14T12:02:03.000Z",
    );

    await fs.writeFile(
      sessionPath,
      `${firstCall}\n${firstOutput}\n${secondCall}\n${secondOutput}\n${successCall}\n${successOutput}\n`,
    );

    const progressEvents: number[] = [];
    const result = await readSessionErroredToolCalls(sessionPath, {
      onProgress: (progress) => {
        progressEvents.push(progress.bytesProcessed);
      },
    });

    expect(result.toolCallRows).toBe(3);
    expect(result.toolOutputRows).toBe(3);
    expect(result.erroredToolCallCount).toBe(2);
    expect(result.distinctErroredToolCalls).toHaveLength(1);
    expect(result.distinctErroredToolCalls[0]).toMatchObject({
      toolName: "functions.exec_command",
      callKind: "function",
      inputFingerprint: JSON.stringify({ cmd: "rg missing src", shell: "pwsh" }),
      errorKind: "exit_code",
      exitCode: 1,
      occurrences: 2,
      sessionCount: 1,
      firstTimestamp: "2026-03-14T12:00:03.000Z",
      lastTimestamp: "2026-03-14T12:01:03.000Z",
    });
    expect(result.distinctErroredToolCalls[0]?.argumentsPreview).toContain("rg missing src");
    expect(result.distinctErroredToolCalls[0]?.errorPattern).toBe(
      "exit 1: ParserError: Unexpected token at <path>:<n>:<n>",
    );
    expect(progressEvents.at(-1)).toBe(result.fileSizeBytes);
  });

  test("detects custom tool failures from explicit error objects", async () => {
    const tempDir = await createTempDir("codlogs-custom-tool-error-");
    const sessionPath = path.join(tempDir, "custom-tool-error.jsonl");
    const customCall = JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "custom_1",
        name: "imagegen",
        input: "make a chart",
      },
      timestamp: "2026-03-14T12:00:00.000Z",
    });
    const customOutput = JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "custom_1",
        output: {
          error: { message: "Remote renderer failed for request abc123" },
        },
      },
      timestamp: "2026-03-14T12:00:04.000Z",
    });

    await fs.writeFile(sessionPath, `${customCall}\n${customOutput}\n`);

    const result = await readSessionErroredToolCalls(sessionPath);

    expect(result.erroredToolCallCount).toBe(1);
    expect(result.distinctErroredToolCalls).toEqual([
      {
        toolName: "imagegen",
        callKind: "custom",
        inputFingerprint: "make a chart",
        argumentsPreview: "make a chart",
        errorPattern: "Remote renderer failed for request abc123",
        errorKind: "explicit_error",
        exitCode: null,
        occurrences: 1,
        sessionCount: 1,
        firstTimestamp: "2026-03-14T12:00:04.000Z",
        lastTimestamp: "2026-03-14T12:00:04.000Z",
        sampleOutput: JSON.stringify(
          {
            error: { message: "Remote renderer failed for request abc123" },
          },
          null,
          2,
        ),
      },
    ]);
  });

  test("does not treat successful tool messages as errors", async () => {
    const tempDir = await createTempDir("codlogs-tool-message-success-");
    const sessionPath = path.join(tempDir, "tool-message-success.jsonl");
    const call = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call_success",
        name: "functions.exec_command",
        arguments: JSON.stringify({ cmd: "echo ok" }),
      },
    });
    const output = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_success",
        output: {
          message: "completed",
          status: "success",
        },
      },
    });

    await fs.writeFile(sessionPath, `${call}\n${output}\n`);

    const result = await readSessionErroredToolCalls(sessionPath);

    expect(result.erroredToolCallCount).toBe(0);
    expect(result.distinctErroredToolCalls).toEqual([]);
  });

  test("does not let fallback error text override explicit success signals", async () => {
    const tempDir = await createTempDir("codlogs-tool-explicit-success-");
    const sessionPath = path.join(tempDir, "tool-explicit-success.jsonl");
    const rows: string[] = [];
    const cases = [
      {
        callId: "call_zero_errors",
        output: {
          status: "completed",
          output: "Tests passed with 0 errors.",
        },
      },
      {
        callId: "call_no_errors",
        output: {
          success: true,
          output: "No errors found.",
        },
      },
      {
        callId: "call_exit_zero_stderr",
        output: {
          exit_code: 0,
          stderr: "error: benign diagnostic emitted by a successful command",
          stdout: "ok",
        },
      },
    ];

    for (const testCase of cases) {
      rows.push(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: testCase.callId,
            name: "functions.exec_command",
            arguments: JSON.stringify({ cmd: "test command" }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: testCase.callId,
            output: testCase.output,
          },
        }),
      );
    }

    await fs.writeFile(sessionPath, `${rows.join("\n")}\n`);

    const result = await readSessionErroredToolCalls(sessionPath);

    expect(result.erroredToolCallCount).toBe(0);
    expect(result.distinctErroredToolCalls).toEqual([]);
  });

  test("detects locale-neutral command-construction fallback signatures", async () => {
    const tempDir = await createTempDir("codlogs-command-fallback-errors-");
    const sessionPath = path.join(tempDir, "command-fallback-errors.jsonl");
    const rows: string[] = [];
    const cases = [
      {
        callId: "missing_path_os_error",
        output: "tool-name: missing path (os error 2)",
      },
      {
        callId: "bad_path_os_error",
        output: "tool-name: invalid path syntax (os error 123)",
      },
      {
        callId: "powershell_parser_error",
        output:
          "ParserError:\nLine |\n   1 | foreach ($item in @(1)) { [pscustomobject]@{ Item = $item } } | Format-Table -AutoSize\n     |                                                                ~\n     | An empty pipe element is not allowed.",
      },
      {
        callId: "literal_home_path",
        output:
          "MethodInvocationException: Exception calling \"ReadAllBytes\" with \"1\" argument(s): \"Could not find a part of the path 'D:\\github\\codlogs\\$HOME\\.codex\\AGENTS.md'.\"",
      },
      {
        callId: "invalid_parameters",
        output: "Invalid parameters: expected exactly one search pattern.",
      },
    ];

    for (const testCase of cases) {
      rows.push(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: testCase.callId,
            name: "functions.exec_command",
            arguments: JSON.stringify({ cmd: testCase.callId }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: testCase.callId,
            output: testCase.output,
          },
        }),
      );
    }

    await fs.writeFile(sessionPath, `${rows.join("\n")}\n`);

    const result = await readSessionErroredToolCalls(sessionPath);

    expect(result.erroredToolCallCount).toBe(cases.length);
    expect(result.distinctErroredToolCalls).toHaveLength(cases.length);
    const errorPatterns = result.distinctErroredToolCalls.map(
      (pattern) => pattern.errorPattern,
    );
    expect(errorPatterns).toContain("tool-name: missing path (os error 2)");
    expect(errorPatterns).toContain("tool-name: invalid path syntax (os error 123)");
    expect(errorPatterns).toContain("ParserError:");
    expect(
      errorPatterns.some((pattern) =>
        pattern.startsWith(
          "MethodInvocationException: Exception calling \"ReadAllBytes\"",
        ),
      ),
    ).toBe(true);
    expect(errorPatterns).toContain(
      "Invalid parameters: expected exactly one search pattern.",
    );
  });

  test("merges repeated errored tool call patterns across sessions", () => {
    const firstPattern: SessionErroredToolCallPattern = {
      toolName: "functions.exec_command",
      callKind: "function",
      inputFingerprint: "{\"cmd\":\"bun test\"}",
      argumentsPreview: "{\"cmd\":\"bun test\"}",
      errorPattern: "exit 1: expected failure",
      errorKind: "exit_code",
      exitCode: 1,
      occurrences: 2,
      sessionCount: 1,
      firstTimestamp: "2026-03-14T12:00:00.000Z",
      lastTimestamp: "2026-03-14T12:05:00.000Z",
      sampleOutput: "expected failure",
    };
    const secondPattern: SessionErroredToolCallPattern = {
      ...firstPattern,
      occurrences: 1,
      sessionCount: 1,
      firstTimestamp: "2026-03-14T11:59:00.000Z",
      lastTimestamp: "2026-03-14T12:06:00.000Z",
      sampleOutput: "same pattern in another session",
    };
    const otherPattern: SessionErroredToolCallPattern = {
      ...firstPattern,
      inputFingerprint: "{\"cmd\":\"bun x tsc --noEmit\"}",
      argumentsPreview: "{\"cmd\":\"bun x tsc --noEmit\"}",
      errorPattern: "exit 2: type error",
      occurrences: 1,
      firstTimestamp: "2026-03-14T12:10:00.000Z",
      lastTimestamp: "2026-03-14T12:10:00.000Z",
      sampleOutput: "type error",
    };

    const merged = mergeErroredToolCallPatterns([
      firstPattern,
      secondPattern,
      otherPattern,
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      ...firstPattern,
      occurrences: 3,
      sessionCount: 2,
      firstTimestamp: "2026-03-14T11:59:00.000Z",
      lastTimestamp: "2026-03-14T12:06:00.000Z",
    });
    expect(merged[1]).toEqual(otherPattern);
  });

  test("returns partial detail metrics when a row exceeds the bounded line limit", async () => {
    const tempDir = await createTempDir("codlogs-oversized-row-");
    const sessionPath = path.join(tempDir, "oversized-row.jsonl");
    const fileHandle = await fs.open(sessionPath, "w");

    const userMessage = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello from a normal row" }],
      },
      timestamp: "2026-03-14T12:00:00.000Z",
    });

    try {
      await fileHandle.writeFile(`${userMessage}\n`);
      const oversizedRow = new Uint8Array(MAX_JSONL_LINE_BYTES_HARD + 1024);
      oversizedRow.fill(120);
      await fileHandle.writeFile(oversizedRow);
      await fileHandle.writeFile("\n");
    } finally {
      await fileHandle.close();
    }

    const metrics = await getSessionDetailMetrics(sessionPath, {
      forceDeepAnalysis: true,
    });

    expect(metrics.analysisKind).toBe("partial");
    expect(metrics.interactionCount).toBe(1);
    expect(metrics.toolCallCount).toBe(0);
    expect(metrics.oversizedLineCount).toBe(1);
    expect(metrics.largestParsedLineBytes).toBeGreaterThan(MAX_JSONL_LINE_BYTES_HARD);
    expect(metrics.skipReason).toContain("oversized row");
  }, 20000);

  test("streams markdown export for a normal session transcript", async () => {
    const tempDir = await createTempDir("codlogs-export-");
    const sessionPath = path.join(tempDir, "normal-session.jsonl");

    const sessionMeta = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "session-test-id",
        cwd: "D:\\github\\codlogs",
      },
      timestamp: "2026-03-14T12:00:00.000Z",
    });
    const userMessage = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello from the user" }],
      },
      timestamp: "2026-03-14T12:01:00.000Z",
    });
    const assistantMessage = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello from the assistant" }],
      },
      timestamp: "2026-03-14T12:02:00.000Z",
    });

    await fs.writeFile(
      sessionPath,
      `${sessionMeta}\n${userMessage}\n${assistantMessage}\n`,
      "utf8",
    );

    const outputPath = await exportSessionJsonlToMarkdown(sessionPath);
    const markdown = await fs.readFile(outputPath, "utf8");

    expect(outputPath.endsWith(".md")).toBe(true);
    expect(markdown).toContain("Hello from the user");
    expect(markdown).toContain("Hello from the assistant");
  });

  test("extracts encrypted compaction payloads without parsing the full row", () => {
    const line =
      '{"timestamp":"2026-03-16T12:00:00.000Z","type":"response_item","payload":{"type":"compaction","encrypted_content":"gAAAAABexamplePayload=="}}';

    expect(extractCompactionEncryptedContentFromJsonlLine(line)).toBe(
      "gAAAAABexamplePayload==",
    );
  });

  test("extracts response-item timestamp metadata without parsing the full row", () => {
    const line =
      '{"timestamp":"2026-03-16T12:01:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}';

    expect(extractResponseItemMetadataFromJsonlLine(line)).toEqual({
      timestamp: "2026-03-16T12:01:02.000Z",
      payloadType: "message",
    });
  });

  test("reconstructs a text-only history from readable thread items", () => {
    const reconstructed = reconstructSanitizedResponseItems({
      turns: [
        {
          items: [
            {
              type: "userMessage",
              content: [
                { type: "text", text: "Please explain this screenshot" },
                { type: "image", url: "data:image/png;base64,AAAA" },
              ],
            },
            {
              type: "reasoning",
              summary: ["Inspecting the screenshot"],
              content: ["The UI shows a warning banner."],
            },
            {
              type: "agentMessage",
              text: "The screenshot shows a warning banner about skipped analysis.",
            },
            {
              type: "commandExecution",
              command: "rg skipped src",
              cwd: "d:\\github\\codlogs",
              status: "completed",
            },
            {
              type: "contextCompaction",
            },
          ],
        },
      ],
    });

    expect(reconstructed.stats.droppedInputImageCount).toBe(1);
    expect(reconstructed.stats.preservedReasoningCount).toBe(1);
    expect(reconstructed.stats.preservedCommandExecutionCount).toBe(1);
    expect(reconstructed.stats.omittedThreadItemCounts.contextCompaction).toBe(1);
    expect(reconstructed.responseItems).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Please explain this screenshot\n<image removed>",
          },
        ],
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Inspecting the screenshot" }],
        content: [{ type: "text", text: "The UI shows a warning banner." }],
        encrypted_content: null,
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "The screenshot shows a warning banner about skipped analysis.",
          },
        ],
      },
      {
        type: "local_shell_call",
        call_id: null,
        status: "completed",
        action: {
          type: "exec",
          command: ["rg skipped src"],
          timeout_ms: null,
          working_directory: "d:\\github\\codlogs",
          env: null,
          user: null,
        },
      },
    ]);
  });

  test("maps reconstructed items back to original response-item timestamps", () => {
    const responseItems: SanitizedResponseItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thinking" }],
        content: [{ type: "text", text: "details" }],
        encrypted_content: null,
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    ];

    const timestamps = mapSanitizedResponseItemTimestamps(responseItems, [
      { timestamp: "2026-03-14T12:01:00.000Z", payloadType: "message" },
      { timestamp: "2026-03-14T12:01:30.000Z", payloadType: "compaction" },
      { timestamp: "2026-03-14T12:02:00.000Z", payloadType: "reasoning" },
      { timestamp: "2026-03-14T12:03:00.000Z", payloadType: "message" },
    ]);

    expect(timestamps).toEqual([
      "2026-03-14T12:01:00.000Z",
      "2026-03-14T12:02:00.000Z",
      "2026-03-14T12:03:00.000Z",
    ]);
  });

  test("keeps original compaction rows in the sanitized write sequence", () => {
    const responseItems: SanitizedResponseItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    ];
    const originalSlots: OriginalResponseItemSlot[] = [
      {
        kind: "sanitizable",
        timestamp: "2026-03-14T12:01:00.000Z",
        payloadType: "message",
      },
      {
        kind: "compaction",
        line: '{"timestamp":"2026-03-14T12:01:30.000Z","type":"response_item","payload":{"type":"compaction","encrypted_content":"gAAAAABexamplePayload=="}}',
        timestamp: "2026-03-14T12:01:30.000Z",
        payloadType: "compaction",
      },
      {
        kind: "sanitizable",
        timestamp: "2026-03-14T12:02:00.000Z",
        payloadType: "message",
      },
    ];
    const compactionLine =
      '{"timestamp":"2026-03-14T12:01:30.000Z","type":"response_item","payload":{"type":"compaction","encrypted_content":"gAAAAABexamplePayload=="}}';

    originalSlots[1] = {
      kind: "compaction",
      line: compactionLine,
      timestamp: "2026-03-14T12:01:30.000Z",
      payloadType: "compaction",
    };

    expect(
      mergeSanitizedResponseItemsWithOriginalSequence(responseItems, originalSlots),
    ).toEqual([
      {
        kind: "sanitized",
        timestamp: "2026-03-14T12:01:00.000Z",
        payload: responseItems[0],
      },
      {
        kind: "raw",
        line: compactionLine,
      },
      {
        kind: "sanitized",
        timestamp: "2026-03-14T12:02:00.000Z",
        payload: responseItems[1],
      },
    ]);
  });

  test("sanitizes compacted rollout replacement history while preserving the row", () => {
    const line = JSON.stringify({
      type: "compacted",
      payload: {
        message: "Context compacted.",
        replacement_history: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Look at this" },
              { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            ],
          },
          {
            type: "compaction",
            encrypted_content: "gAAAAABexamplePayload==",
          },
        ],
      },
    });

    expect(sanitizeCompactedRolloutLine(line)).toBe(
      JSON.stringify({
        type: "compacted",
        payload: {
          message: "Context compacted.",
          replacement_history: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Look at this\n<image removed>",
                },
              ],
            },
            {
              type: "compaction",
              encrypted_content: "gAAAAABexamplePayload==",
            },
          ],
        },
      }),
    );
  });

  test("does not blob-strip compacted replacement history when aggressive mode is enabled", () => {
    const encryptedContent = "g".repeat(7000);
    const line = JSON.stringify({
      type: "compacted",
      payload: {
        message: "Context compacted.",
        replacement_history: [
          {
            type: "reasoning",
            summary: [],
            content: null,
            encrypted_content: encryptedContent,
          },
        ],
      },
    });

    expect(
      sanitizeCompactedRolloutLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(line);
  });

  test("sanitizes response-item message rows in place without changing line order", () => {
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<image>" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "caption" },
        ],
      },
    });

    expect(sanitizeResponseItemJsonlLine(line)).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<image removed>\ncaption",
            },
          ],
        },
      }),
    );
  });

  test("sanitizes event-msg user-message rows with inline image arrays", () => {
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:02:30.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "please inspect",
        images: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
        local_images: ["C:\\temp\\capture.png"],
      },
    });

    expect(sanitizeEventMsgJsonlLine(line)).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:02:30.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message:
            "please inspect\n<image removed>\n<image removed>\n<local image removed>",
          images: [],
          local_images: [],
        },
      }),
    );
  });

  test("strips large response-item blobs when blob stripping is enabled", () => {
    const largeOutput = JSON.stringify({
      output: "x".repeat(6000),
      metadata: {
        exit_code: 0,
        duration_seconds: 1.25,
      },
    });
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:02:45.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_123",
        output: largeOutput,
      },
    });

    expect(
      sanitizeResponseItemJsonlLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:02:45.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_123",
          output: JSON.stringify({
            output: `<tool output removed: ${Buffer.byteLength(largeOutput, "utf8")} bytes>`,
            metadata: {
              exit_code: 0,
              duration_seconds: 1.25,
            },
          }),
        },
      }),
    );
  });

  test("strips encrypted reasoning blobs when blob stripping is enabled", () => {
    const encryptedContent = "g".repeat(7000);
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:03:00.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [],
        content: null,
        encrypted_content: encryptedContent,
      },
    });

    expect(
      sanitizeResponseItemJsonlLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:03:00.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [],
          content: null,
          encrypted_content: `<reasoning blob removed: ${Buffer.byteLength(encryptedContent, "utf8")} bytes>`,
        },
      }),
    );
  });

  test("strips token-count event payloads when blob stripping is enabled", () => {
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:03:15.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 12345,
          },
        },
      },
    });

    expect(
      sanitizeEventMsgJsonlLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:03:15.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
        },
      }),
    );
  });

  test("strips large turn-context instruction dumps when blob stripping is enabled", () => {
    const instructions = "rule\n".repeat(1500);
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:03:30.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn_123",
        cwd: "d:\\github\\codlogs",
        collaboration_mode: {
          mode: "default",
          settings: {
            developer_instructions: instructions,
          },
        },
      },
    });

    expect(
      sanitizeTurnContextJsonlLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:03:30.000Z",
        type: "turn_context",
        payload: {
          turn_id: "turn_123",
          cwd: "d:\\github\\codlogs",
          collaboration_mode: {
            mode: "default",
            settings: {
              developer_instructions: `<turn context blob removed: ${Buffer.byteLength(instructions, "utf8")} bytes>`,
            },
          },
        },
      }),
    );
  });

  test("keeps sanitized compacted rows in the write sequence", () => {
    const responseItems: SanitizedResponseItem[] = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "after compacted" }],
      },
    ];
    const compactedLine = JSON.stringify({
      type: "compacted",
      payload: {
        message: "Context compacted.",
        replacement_history: [],
      },
    });
    const originalSlots: OriginalResponseItemSlot[] = [
      {
        kind: "compacted",
        line: compactedLine,
      },
      {
        kind: "sanitizable",
        timestamp: "2026-03-14T12:02:00.000Z",
        payloadType: "message",
      },
    ];

    expect(
      mergeSanitizedResponseItemsWithOriginalSequence(responseItems, originalSlots),
    ).toEqual([
      {
        kind: "raw",
        line: compactedLine,
      },
      {
        kind: "sanitized",
        timestamp: "2026-03-14T12:02:00.000Z",
        payload: responseItems[0],
      },
    ]);
  });
});
