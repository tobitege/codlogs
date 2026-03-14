import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AUTO_DETAIL_PARSE_LIMIT_BYTES,
  MAX_JSONL_LINE_BYTES_HARD,
  exportSessionJsonlToMarkdown,
  getSessionDetailMetrics,
} from "./codlogs-core.ts";

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
});
