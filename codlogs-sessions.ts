import * as path from "node:path";
import {
  DEFAULT_CODEX_HOME,
  exportSessionJsonlToHtml,
  exportSessionJsonlToMarkdown,
  findCodexSessions,
  type FindCodexSessionsResult,
} from "./src/shared/codlogs-core.ts";

type ParsedOptions = {
  codexHome: string;
  cwdOnly: boolean;
  includeImages: boolean;
  includeToolCallResults: boolean;
  htmlExportPath: string | null;
  json: boolean;
  markdownExportPath: string | null;
  targetDirectory: string | null;
};

async function main(): Promise<void> {
  const commandName = getCommandName();
  const options = parseArgs(process.argv.slice(2), commandName);

  if (options.markdownExportPath !== null) {
    const markdownPath = await exportSessionJsonlToMarkdown(options.markdownExportPath, {
      includeImages: options.includeImages,
      includeToolCallResults: options.includeToolCallResults,
    });
    console.log(`Wrote Markdown export: ${markdownPath}`);
    return;
  }

  if (options.htmlExportPath !== null) {
    const htmlPath = await exportSessionJsonlToHtml(options.htmlExportPath, {
      includeImages: options.includeImages,
      includeToolCallResults: options.includeToolCallResults,
    });
    console.log(`Wrote HTML export: ${htmlPath}`);
    return;
  }

  const result = await findCodexSessions({
    codexHome: options.codexHome,
    cwdOnly: options.cwdOnly,
    targetDirectory: options.targetDirectory ?? undefined,
    currentWorkingDirectory: process.cwd(),
  });

  if (options.json) {
    printJson(result);
    return;
  }

  printHumanReadable(result, commandName);
}

function parseArgs(args: string[], commandName: string): ParsedOptions {
  const options: ParsedOptions = {
    codexHome: process.env.CODEX_HOME || DEFAULT_CODEX_HOME,
    cwdOnly: false,
    includeImages: false,
    includeToolCallResults: false,
    htmlExportPath: null,
    json: false,
    markdownExportPath: null,
    targetDirectory: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (argument === "--cwd-only") {
      options.cwdOnly = true;
      continue;
    }

    if (argument === "--include-images") {
      options.includeImages = true;
      continue;
    }

    if (argument === "--include-tool-results") {
      options.includeToolCallResults = true;
      continue;
    }

    if (argument === "--md") {
      const nextArgument = args[index + 1];
      if (!nextArgument) {
        throw new Error("Missing value after --md");
      }

      options.markdownExportPath = nextArgument;
      index += 1;
      continue;
    }

    if (argument === "--html") {
      const nextArgument = args[index + 1];
      if (!nextArgument) {
        throw new Error("Missing value after --html");
      }

      options.htmlExportPath = nextArgument;
      index += 1;
      continue;
    }

    if (argument === "--codex-home") {
      const nextArgument = args[index + 1];
      if (!nextArgument) {
        throw new Error("Missing value after --codex-home");
      }

      options.codexHome = nextArgument;
      index += 1;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      printHelp(commandName);
      process.exit(0);
    }

    if (!argument.startsWith("-")) {
      if (options.targetDirectory !== null) {
        throw new Error(`Unexpected extra path argument: ${argument}`);
      }

      options.targetDirectory = argument;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (
    (options.markdownExportPath !== null || options.htmlExportPath !== null) &&
    options.targetDirectory !== null
  ) {
    throw new Error("Use either [folder] or an export flag, not both");
  }

  if (options.markdownExportPath !== null && options.htmlExportPath !== null) {
    throw new Error("Use either --md FILE or --html FILE, not both");
  }

  if ((options.markdownExportPath !== null || options.htmlExportPath !== null) && options.json) {
    throw new Error("--json cannot be combined with export flags");
  }

  if (
    options.markdownExportPath === null &&
    options.htmlExportPath === null &&
    (options.includeImages || options.includeToolCallResults)
  ) {
    throw new Error("--include-images and --include-tool-results require --md FILE or --html FILE");
  }

  return options;
}

function printHelp(commandName: string): void {
  console.log(
    [
      "Usage:",
      `  ${commandName} [folder] [--json] [--cwd-only] [--codex-home PATH]`,
      `  ${commandName} --md FILE.jsonl [--include-images] [--include-tool-results]`,
      `  ${commandName} --html FILE.jsonl [--include-images] [--include-tool-results]`,
      "",
      "Options:",
      "  folder                 Optional folder or repo to inspect. Defaults to the current directory.",
      "  --json                 Print machine-readable JSON.",
      "  --md FILE.jsonl        Convert one Codex session JSONL file into a same-named Markdown file.",
      "  --html FILE.jsonl      Convert one Codex session JSONL file into a same-named HTML file.",
      "  --include-images       With --md or --html, export embedded images into a sibling .assets folder.",
      "  --include-tool-results With --md or --html, include tool calls and tool outputs in the exported transcript.",
      "  --cwd-only             Match only the current folder tree, even if a git repo root exists.",
      "  --codex-home PATH      Override the Codex home folder. Defaults to %CODEX_HOME% or ~/.codex.",
      "  -h, --help             Show this help text.",
    ].join("\n"),
  );
}

function printJson(payload: FindCodexSessionsResult): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printHumanReadable(payload: FindCodexSessionsResult, commandName: string): void {
  console.log(`Current cwd : ${payload.currentWorkingDirectory}`);
  if (
    payload.requestedDirectory &&
    payload.requestedDirectory !== payload.currentWorkingDirectory
  ) {
    console.log(`Target dir  : ${payload.requestedDirectory}`);
  }
  console.log(`Search root : ${payload.targetRoot ?? "(all sessions)"}`);
  console.log(`Scope mode  : ${payload.scopeMode}`);
  console.log(`Codex home  : ${payload.codexHome}`);
  console.log(
    `Matches     : ${payload.sessionCount} (${payload.liveCount} live, ${payload.archivedCount} archived)`,
  );

  if (payload.sessions.length === 0) {
    console.log("");
    console.log(`No matching Codex sessions found. Try ${commandName} --json for raw output.`);
    return;
  }

  for (const session of payload.sessions) {
    const largeMarker = session.fileSizeBytes >= 64 * 1024 * 1024 ? "  [large]" : "";
    console.log("");
    console.log(
      `${session.updatedAt ?? session.startedAt ?? "unknown-time"}  ${padRight(session.kind, 8)}  ${session.threadName ?? "(untitled session)"}${largeMarker}`,
    );
    console.log(`  cwd : ${session.cwd}`);
    console.log(`  id  : ${session.id}`);
    console.log(`  size: ${formatFileSize(session.fileSizeBytes)}`);
    console.log(`  file: ${session.file}`);
  }
}

function padRight(value: string, length: number): string {
  return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}

function formatFileSize(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function getCommandName(): string {
  const envCommandName = process.env.CODEXER_COMMAND_NAME?.trim();
  if (envCommandName) {
    return envCommandName;
  }

  const invokedPath = process.argv[1] ? path.basename(process.argv[1]) : "codlogs-sessions";
  return invokedPath.replace(/\.(?:cjs|js|mjs|ts)$/i, "") || "codlogs-sessions";
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to find Codex sessions: ${message}`);
  process.exitCode = 1;
});
