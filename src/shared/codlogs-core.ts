import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type SessionKind = "live" | "archived";
export type ScopeMode = "repo" | "cwd" | "all";
export type PathStyle = "win" | "posix";

export type SessionIndexEntry = {
  threadName: string | null;
  updatedAt: string | null;
};

export type SessionMetaMatch = {
  kind: SessionKind;
  id: string;
  file: string;
  cwd: string;
  startedAt: string | null;
  updatedAt: string | null;
  threadName: string | null;
};

export type FindCodexSessionsOptions = {
  codexHome?: string | null;
  cwdOnly?: boolean;
  includeCrossSessionWrites?: boolean;
  targetDirectory?: string | null;
  currentWorkingDirectory?: string | null;
};

export type FindCodexSessionsResult = {
  codexHome: string;
  currentWorkingDirectory: string;
  requestedDirectory: string | null;
  scopeMode: ScopeMode;
  targetRoot: string | null;
  sessionCount: number;
  liveCount: number;
  archivedCount: number;
  sessions: SessionMetaMatch[];
};

export type SessionDetailMetrics = {
  interactionCount: number;
  toolCallCount: number;
  fileSizeBytes: number;
};

export type MarkdownExportOptions = {
  includeImages?: boolean;
  includeToolCallResults?: boolean;
  outputDirectory?: string | null;
};

export type HtmlExportOptions = {
  includeImages?: boolean;
  inlineImages?: boolean;
  includeToolCallResults?: boolean;
  outputDirectory?: string | null;
  outputPath?: string | null;
};

export type ExportProgress = {
  stage: "reading" | "parsing" | "rendering" | "writing";
  message: string;
  progressPercent: number;
};

type SessionIndexRecord = {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
};

type SessionMetaRecord = {
  type?: unknown;
  payload?: {
    id?: unknown;
    timestamp?: unknown;
    cwd?: unknown;
    originator?: unknown;
    cli_version?: unknown;
    source?: unknown;
    model_provider?: unknown;
  };
  timestamp?: unknown;
};

type ComparablePathAlias = {
  style: PathStyle;
  value: string;
  compareValue: string;
};

type JsonlRecord = {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
};

type SessionExportMetadata = {
  id: string;
  startedAt: string | null;
  cwd: string;
  originator: string | null;
  cliVersion: string | null;
  source: string | null;
  modelProvider: string | null;
};

type NormalizedMarkdownExportOptions = {
  includeImages: boolean;
  includeToolCallResults: boolean;
};

type NormalizedHtmlExportOptions = {
  includeImages: boolean;
  inlineImages: boolean;
  includeToolCallResults: boolean;
};

type ExportImageAsset = {
  fileName: string;
  data: Uint8Array;
};

type MarkdownImageAsset = ExportImageAsset;

type HtmlImageAsset = ExportImageAsset;

type MarkdownRenderContext = {
  assetDirectoryName: string;
  assets: MarkdownImageAsset[];
  nextImageIndex: number;
  options: NormalizedMarkdownExportOptions;
};

type HtmlRenderContext = {
  assetDirectoryName: string;
  assets: HtmlImageAsset[];
  nextImageIndex: number;
  options: NormalizedHtmlExportOptions;
};

type RenderedMessageContent = {
  text: string;
  imageMarkdown: string[];
};

type ExportRuntimeOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void | Promise<void>;
};

type ExportLoopProgressOptions = {
  stage: ExportProgress["stage"];
  startPercent: number;
  endPercent: number;
  message: string;
};

export const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");

const FIRST_LINE_READ_BYTES = 64 * 1024;
const FALLBACK_FILE_SCAN_CONCURRENCY = 16;
const RIPGREP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_NESTED_JSON_STRING_LENGTH = 512 * 1024;
const WINDOWS_PATH_CANDIDATE_REGEX =
  /(?:\\\\\?\\)?[a-zA-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g;
const WSL_UNC_PATH_CANDIDATE_REGEX =
  /\\\\wsl(?:\.localhost)?\\[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)*/gi;
const WSL_MOUNT_PATH_CANDIDATE_REGEX = /\/mnt\/[a-z](?:\/[^\s"'<>|`]+)*/gi;
const ENVIRONMENT_CWD_REGEX = /<cwd>([^<]+)<\/cwd>/gi;
const EXPORT_PROGRESS_PULSE_RECORD_INTERVAL = 100;

class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled.");
    this.name = "ExportCancelledError";
  }
}

export async function findCodexSessions(
  options: FindCodexSessionsOptions = {},
): Promise<FindCodexSessionsResult> {
  const normalizedTargetDirectory = normalizeOptionalPathInput(options.targetDirectory);
  const normalizedCodexHome = normalizeOptionalPathInput(options.codexHome);
  const currentWorkingDirectory = path.resolve(
    options.currentWorkingDirectory ?? process.cwd(),
  );
  const codexHome = resolveFilesystemPath(
    normalizedCodexHome ?? process.env.CODEX_HOME ?? DEFAULT_CODEX_HOME,
  );

  let requestedDirectory: string | null = null;
  let scopeMode: ScopeMode = "all";
  let targetRoot: string | null = null;
  let targetRootAliases: ComparablePathAlias[] | null = null;
  const includeCrossSessionWrites = options.includeCrossSessionWrites === true;

  if (normalizedTargetDirectory !== null) {
    requestedDirectory =
      normalizedTargetDirectory === undefined
        ? currentWorkingDirectory
        : resolveFilesystemPath(normalizedTargetDirectory);
    const repoRoot = options.cwdOnly ? null : await findRepoRoot(requestedDirectory);
    targetRoot = repoRoot ?? requestedDirectory;
    targetRootAliases = getComparablePathAliases(targetRoot);
    scopeMode = repoRoot ? "repo" : "cwd";
  }

  const sessionRoots = [
    { directory: path.join(codexHome, "sessions"), kind: "live" as const },
    { directory: path.join(codexHome, "archived_sessions"), kind: "archived" as const },
  ];

  const sessionIndex = await readSessionIndex(path.join(codexHome, "session_index.jsonl"));
  const sessionFiles = (
    await Promise.all(
      sessionRoots.map(async (root) => {
        const files = await collectJsonlFiles(root.directory);
        return files.map((file) => ({ file, kind: root.kind }));
      }),
    )
  ).flat();
  const candidateFiles = targetRootAliases
    ? await findCandidateSessionFiles(
        sessionRoots.map((root) => root.directory),
        sessionFiles.map((entry) => entry.file),
        targetRootAliases,
      )
    : null;

  const matches: SessionMetaMatch[] = [];
  for (const entry of sessionFiles) {
    if (candidateFiles && !candidateFiles.has(normalizeFileLookupPath(entry.file))) {
      continue;
    }

    const meta = await readSessionMeta(entry.file);
    if (!meta) {
      continue;
    }

    if (targetRootAliases) {
      const cwdMatches = matchesRootAliases(meta.cwd, targetRootAliases);
      if (
        !cwdMatches &&
        (!includeCrossSessionWrites ||
          !(await sessionTouchesRoot(entry.file, targetRootAliases, meta.cwd)))
      ) {
        continue;
      }
    }

    const indexEntry = sessionIndex.get(meta.id);
    matches.push({
      kind: entry.kind,
      id: meta.id,
      file: entry.file,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt: indexEntry?.updatedAt ?? null,
      threadName: indexEntry?.threadName ?? null,
    });
  }

  matches.sort(compareByNewestDesc);

  const liveCount = matches.filter((session) => session.kind === "live").length;
  return {
    codexHome,
    currentWorkingDirectory,
    requestedDirectory,
    scopeMode,
    targetRoot,
    sessionCount: matches.length,
    liveCount,
    archivedCount: matches.length - liveCount,
    sessions: matches,
  };
}

export async function getSessionDetailMetrics(
  inputPath: string,
): Promise<SessionDetailMetrics> {
  const sessionFilePath = resolveFilesystemPath(inputPath);
  if (!(await pathExists(sessionFilePath))) {
    throw new Error(`Session file not found: ${sessionFilePath}`);
  }

  const [stat, content] = await Promise.all([
    fs.stat(sessionFilePath),
    fs.readFile(sessionFilePath, "utf8"),
  ]);
  const records = parseJsonlRecords(content);
  let responseItemUserMessages = 0;
  let eventUserMessages = 0;
  let toolCallCount = 0;

  for (const record of records) {
    if (record.type === "response_item") {
      const item = asObject(record.payload);
      if (!item || typeof item.type !== "string") {
        continue;
      }

      if (item.type === "function_call" || item.type === "custom_tool_call") {
        toolCallCount += 1;
        continue;
      }

      if (item.type !== "message" || item.role !== "user") {
        continue;
      }

      const messageText = extractMessageLikeText(item.content);
      if (!looksLikeBootstrapContext(messageText)) {
        responseItemUserMessages += 1;
      }
      continue;
    }

    if (record.type === "event_msg") {
      const payload = asObject(record.payload);
      if (payload?.type === "user_message") {
        eventUserMessages += 1;
      }
    }
  }

  return {
    interactionCount:
      responseItemUserMessages > 0 ? responseItemUserMessages : eventUserMessages,
    toolCallCount,
    fileSizeBytes: stat.size,
  };
}

export async function exportSessionJsonlToMarkdown(
  inputPath: string,
  options: MarkdownExportOptions = {},
  runtimeOptions: ExportRuntimeOptions = {},
): Promise<string> {
  const sessionFilePath = resolveFilesystemPath(inputPath);
  if (!(await pathExists(sessionFilePath))) {
    throw new Error(`Session file not found: ${sessionFilePath}`);
  }

  if (path.extname(sessionFilePath).toLowerCase() !== ".jsonl") {
    throw new Error(`Expected a .jsonl file: ${sessionFilePath}`);
  }

  await reportExportProgress(runtimeOptions, {
    stage: "reading",
    message: "Reading session file...",
    progressPercent: 4,
  });
  const content = await fs.readFile(sessionFilePath, "utf8");
  const records = await parseJsonlRecordsForExport(content, runtimeOptions);
  const normalizedOptions = normalizeMarkdownExportOptions(options);
  const outputName = path.parse(sessionFilePath).name;
  const outputDirectory = normalizeOptionalPathInput(options.outputDirectory);
  const outputDirectoryPath = outputDirectory
    ? resolveFilesystemPath(outputDirectory)
    : path.dirname(sessionFilePath);
  const assetDirectoryName = `${outputName}.assets`;
  const { markdown, assets } = await buildMarkdownExport(
    sessionFilePath,
    records,
    normalizedOptions,
    assetDirectoryName,
    runtimeOptions,
  );
  await reportExportProgress(runtimeOptions, {
    stage: "writing",
    message: "Writing Markdown export...",
    progressPercent: 86,
  });
  await fs.mkdir(outputDirectoryPath, { recursive: true });
  const outputPath = path.join(outputDirectoryPath, `${outputName}.md`);
  await fs.writeFile(outputPath, markdown, "utf8");

  if (assets.length > 0) {
    await writeExportAssets(
      path.join(outputDirectoryPath, assetDirectoryName),
      assets,
      runtimeOptions,
      {
        stage: "writing",
        startPercent: 90,
        endPercent: 99,
        message: "Writing image assets...",
      },
    );
  }

  await reportExportProgress(runtimeOptions, {
    stage: "writing",
    message: "Markdown export ready.",
    progressPercent: 100,
  });
  return outputPath;
}

export async function exportSessionJsonlToHtml(
  inputPath: string,
  options: HtmlExportOptions = {},
  runtimeOptions: ExportRuntimeOptions = {},
): Promise<string> {
  const sessionFilePath = resolveFilesystemPath(inputPath);
  if (!(await pathExists(sessionFilePath))) {
    throw new Error(`Session file not found: ${sessionFilePath}`);
  }

  if (path.extname(sessionFilePath).toLowerCase() !== ".jsonl") {
    throw new Error(`Expected a .jsonl file: ${sessionFilePath}`);
  }

  await reportExportProgress(runtimeOptions, {
    stage: "reading",
    message: "Reading session file...",
    progressPercent: 4,
  });
  const content = await fs.readFile(sessionFilePath, "utf8");
  const records = await parseJsonlRecordsForExport(content, runtimeOptions);
  const normalizedOptions = normalizeHtmlExportOptions(options);
  const outputName = path.parse(sessionFilePath).name;
  const outputDirectory = normalizeOptionalPathInput(options.outputDirectory);
  const explicitOutputPath = normalizeOptionalPathInput(options.outputPath);
  const assetDirectoryName = `${outputName}.assets`;
  const outputPath = explicitOutputPath
    ? ensureHtmlOutputPath(resolveFilesystemPath(explicitOutputPath))
    : path.join(
        outputDirectory ? resolveFilesystemPath(outputDirectory) : path.dirname(sessionFilePath),
        `${outputName}.html`,
      );
  const outputDirectoryPath = path.dirname(outputPath);

  const { html, assets } = await buildHtmlExport(
    sessionFilePath,
    records,
    normalizedOptions,
    assetDirectoryName,
    runtimeOptions,
  );

  await reportExportProgress(runtimeOptions, {
    stage: "writing",
    message: "Writing HTML export...",
    progressPercent: 86,
  });
  await fs.mkdir(outputDirectoryPath, { recursive: true });
  await fs.writeFile(outputPath, html, "utf8");

  if (assets.length > 0) {
    await writeExportAssets(
      path.join(outputDirectoryPath, assetDirectoryName),
      assets,
      runtimeOptions,
      {
        stage: "writing",
        startPercent: 90,
        endPercent: 99,
        message: "Writing image assets...",
      },
    );
  }

  await reportExportProgress(runtimeOptions, {
    stage: "writing",
    message: "HTML export ready.",
    progressPercent: 100,
  });
  return outputPath;
}

async function reportExportProgress(
  runtimeOptions: ExportRuntimeOptions,
  progress: ExportProgress,
): Promise<void> {
  throwIfExportCancelled(runtimeOptions.signal);
  await runtimeOptions.onProgress?.({
    ...progress,
    progressPercent: Math.max(0, Math.min(100, Math.round(progress.progressPercent))),
  });
  throwIfExportCancelled(runtimeOptions.signal);
}

function throwIfExportCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ExportCancelledError();
  }
}

async function parseJsonlRecordsForExport(
  content: string,
  runtimeOptions: ExportRuntimeOptions,
): Promise<JsonlRecord[]> {
  const records: JsonlRecord[] = [];
  const lines = content.split(/\r?\n/);
  const totalLines = Math.max(lines.length, 1);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/^\uFEFF/, "").trim();
    if (!line) {
      if (shouldPulseExportProgress(index, totalLines)) {
        await pulseExportLoop(runtimeOptions, index + 1, totalLines, {
          stage: "parsing",
          startPercent: 10,
          endPercent: 28,
          message: "Parsing session records...",
        });
      }
      continue;
    }

    try {
      records.push(JSON.parse(line) as JsonlRecord);
    } catch {
      // Skip malformed lines so one bad record does not block the export.
    }

    if (shouldPulseExportProgress(index, totalLines)) {
      await pulseExportLoop(runtimeOptions, index + 1, totalLines, {
        stage: "parsing",
        startPercent: 10,
        endPercent: 28,
        message: "Parsing session records...",
      });
    }
  }

  await reportExportProgress(runtimeOptions, {
    stage: "parsing",
    message: "Session records parsed.",
    progressPercent: 28,
  });
  return records;
}

function shouldPulseExportProgress(index: number, total: number): boolean {
  return (
    index === 0 ||
    index + 1 === total ||
    (index + 1) % EXPORT_PROGRESS_PULSE_RECORD_INTERVAL === 0
  );
}

async function pulseExportLoop(
  runtimeOptions: ExportRuntimeOptions,
  completed: number,
  total: number,
  options: ExportLoopProgressOptions,
): Promise<void> {
  const progressRatio = total <= 0 ? 1 : completed / total;
  const progressPercent =
    options.startPercent + (options.endPercent - options.startPercent) * progressRatio;
  await reportExportProgress(runtimeOptions, {
    stage: options.stage,
    message: options.message,
    progressPercent,
  });
  await yieldForExportLoop();
}

async function yieldForExportLoop(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function writeExportAssets(
  assetDirectoryPath: string,
  assets: ExportImageAsset[],
  runtimeOptions: ExportRuntimeOptions,
  progressOptions: ExportLoopProgressOptions,
): Promise<void> {
  await fs.mkdir(assetDirectoryPath, { recursive: true });

  for (let index = 0; index < assets.length; index += 1) {
    throwIfExportCancelled(runtimeOptions.signal);
    const asset = assets[index];
    await fs.writeFile(path.join(assetDirectoryPath, asset.fileName), asset.data);
    await pulseExportLoop(runtimeOptions, index + 1, assets.length, progressOptions);
  }
}

function normalizeMarkdownExportOptions(
  options: MarkdownExportOptions,
): NormalizedMarkdownExportOptions {
  return {
    includeImages: options.includeImages === true,
    includeToolCallResults: options.includeToolCallResults === true,
  };
}

function normalizeHtmlExportOptions(
  options: HtmlExportOptions,
): NormalizedHtmlExportOptions {
  return {
    includeImages: options.includeImages === true,
    inlineImages: options.inlineImages !== false,
    includeToolCallResults: options.includeToolCallResults === true,
  };
}

function ensureHtmlOutputPath(outputPath: string): string {
  return path.extname(outputPath).toLowerCase() === ".html"
    ? outputPath
    : `${outputPath}.html`;
}

function normalizeOptionalPathInput(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function findRepoRoot(startDirectory: string): Promise<string | null> {
  try {
    const output = childProcess
      .execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: startDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();

    if (output) {
      return path.resolve(output);
    }
  } catch {
    // Fall back to walking upward for a .git entry.
  }

  let currentDirectory = startDirectory;
  while (true) {
    if (await pathExists(path.join(currentDirectory, ".git"))) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readSessionIndex(indexPath: string): Promise<Map<string, SessionIndexEntry>> {
  const index = new Map<string, SessionIndexEntry>();
  if (!(await pathExists(indexPath))) {
    return index;
  }

  const content = await fs.readFile(indexPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let parsed: SessionIndexRecord;
    try {
      parsed = JSON.parse(line) as SessionIndexRecord;
    } catch {
      continue;
    }

    if (typeof parsed.id !== "string") {
      continue;
    }

    index.set(parsed.id, {
      threadName: typeof parsed.thread_name === "string" ? parsed.thread_name : null,
      updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : null,
    });
  }

  return index;
}

async function collectJsonlFiles(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const files: string[] = [];
  const pendingDirectories = [directory];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) {
      continue;
    }

    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function readSessionMeta(
  filePath: string,
): Promise<{ id: string; cwd: string; startedAt: string | null } | null> {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine) {
    return null;
  }

  let parsed: SessionMetaRecord;
  try {
    parsed = JSON.parse(firstLine) as SessionMetaRecord;
  } catch {
    return null;
  }

  if (parsed.type !== "session_meta") {
    return null;
  }

  const payload = parsed.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (typeof payload.id !== "string" || typeof payload.cwd !== "string") {
    return null;
  }

  const startedAt =
    typeof payload.timestamp === "string"
      ? payload.timestamp
      : typeof parsed.timestamp === "string"
        ? parsed.timestamp
        : null;

  return {
    id: payload.id,
    cwd: payload.cwd,
    startedAt,
  };
}

async function findCandidateSessionFiles(
  searchRoots: string[],
  sessionFiles: string[],
  rootAliases: ComparablePathAlias[],
): Promise<Set<string>> {
  const searchNeedles = buildRootSearchNeedles(rootAliases);
  if (searchNeedles.length === 0) {
    return new Set();
  }

  const existingSearchRoots = (
    await Promise.all(
      searchRoots.map(async (searchRoot) => ((await pathExists(searchRoot)) ? searchRoot : null)),
    )
  ).filter((searchRoot): searchRoot is string => Boolean(searchRoot));

  const ripgrepMatches =
    existingSearchRoots.length > 0
      ? tryFindCandidateSessionFilesWithRipgrep(existingSearchRoots, searchNeedles)
      : null;
  if (ripgrepMatches) {
    return ripgrepMatches;
  }

  const matchedFiles = await filterWithConcurrency(
    sessionFiles,
    FALLBACK_FILE_SCAN_CONCURRENCY,
    async (sessionFile) => fileContainsAnyNeedle(sessionFile, searchNeedles),
  );
  return new Set(matchedFiles.map(normalizeFileLookupPath));
}

function tryFindCandidateSessionFilesWithRipgrep(
  searchRoots: string[],
  searchNeedles: string[],
): Set<string> | null {
  const args = ["-l", "-i", "-F", "--no-messages", "--glob", "*.jsonl"];
  for (const needle of searchNeedles) {
    args.push("-e", needle);
  }
  args.push(...searchRoots);

  const result = childProcess.spawnSync("rg", args, {
    encoding: "utf8",
    maxBuffer: RIPGREP_MAX_BUFFER_BYTES,
  });
  if (result.error) {
    return null;
  }

  if (result.status !== 0 && result.status !== 1) {
    return null;
  }

  const matchedFiles = `${result.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeFileLookupPath);
  return new Set(matchedFiles);
}

function buildRootSearchNeedles(rootAliases: ComparablePathAlias[]): string[] {
  const needles = new Set<string>();
  for (const alias of rootAliases) {
    addSearchNeedle(needles, alias.value);
    addSearchNeedle(needles, JSON.stringify(alias.value).slice(1, -1));
  }

  return [...needles];
}

function addSearchNeedle(target: Set<string>, needle: string): void {
  const trimmed = needle.trim();
  if (trimmed) {
    target.add(trimmed);
  }
}

async function fileContainsAnyNeedle(
  filePath: string,
  searchNeedles: string[],
): Promise<boolean> {
  const content = (await fs.readFile(filePath, "utf8")).toLowerCase();
  return searchNeedles.some((needle) => content.includes(needle.toLowerCase()));
}

async function filterWithConcurrency<T>(
  items: T[],
  concurrency: number,
  predicate: (item: T) => Promise<boolean>,
): Promise<T[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<boolean>(items.length).fill(false);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await predicate(items[currentIndex]);
      }
    }),
  );

  return items.filter((_, index) => results[index]);
}

function normalizeFileLookupPath(filePath: string): string {
  const resolvedPath = resolveFilesystemPath(filePath);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

async function sessionTouchesRoot(
  filePath: string,
  rootAliases: ComparablePathAlias[],
  primaryCwd: string,
): Promise<boolean> {
  if (matchesRootAliases(primaryCwd, rootAliases)) {
    return true;
  }

  const content = await fs.readFile(filePath, "utf8");
  const records = parseJsonlRecords(content);
  for (const record of records) {
    if (valueTouchesRoot(record, rootAliases)) {
      return true;
    }
  }

  return false;
}

async function readFirstLine(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = new Uint8Array(FIRST_LINE_READ_BYTES);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead === 0) {
      return null;
    }

    const content = Buffer.from(buffer.subarray(0, result.bytesRead)).toString("utf8");
    const newlineIndex = content.indexOf("\n");
    if (newlineIndex >= 0) {
      return content.slice(0, newlineIndex).trimEnd();
    }

    if (result.bytesRead < buffer.length) {
      return content.trimEnd();
    }

    throw new Error(`First line exceeded ${FIRST_LINE_READ_BYTES} bytes in ${filePath}`);
  } finally {
    await handle.close();
  }
}

function parseJsonlRecords(content: string): JsonlRecord[] {
  const records: JsonlRecord[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line) {
      continue;
    }

    try {
      records.push(JSON.parse(line) as JsonlRecord);
    } catch {
      // Skip malformed lines so one bad record does not block the export.
    }
  }

  return records;
}

function valueTouchesRoot(
  value: unknown,
  rootAliases: ComparablePathAlias[],
): boolean {
  if (typeof value === "string") {
    return stringTouchesRoot(value, rootAliases);
  }

  if (Array.isArray(value)) {
    return value.some((entry) => valueTouchesRoot(entry, rootAliases));
  }

  const objectValue = asObject(value);
  if (!objectValue) {
    return false;
  }

  return Object.values(objectValue).some((entry) => valueTouchesRoot(entry, rootAliases));
}

function stringTouchesRoot(
  value: string,
  rootAliases: ComparablePathAlias[],
): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (isAbsolutePathLike(trimmed) && matchesRootAliases(trimmed, rootAliases)) {
    return true;
  }

  for (const cwd of extractEnvironmentContextCwds(trimmed)) {
    if (matchesRootAliases(cwd, rootAliases)) {
      return true;
    }
  }

  for (const candidatePath of extractAbsolutePathCandidates(trimmed)) {
    if (matchesRootAliases(candidatePath, rootAliases)) {
      return true;
    }
  }

  if (looksLikeJsonStructuredText(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (valueTouchesRoot(parsed, rootAliases)) {
        return true;
      }
    } catch {
      // Ignore malformed nested JSON strings.
    }
  }

  return false;
}

function extractEnvironmentContextCwds(value: string): string[] {
  const matches: string[] = [];
  for (const match of value.matchAll(ENVIRONMENT_CWD_REGEX)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      matches.push(candidate);
    }
  }

  return matches;
}

function extractAbsolutePathCandidates(value: string): string[] {
  const candidates = new Set<string>();
  for (const regex of [
    WINDOWS_PATH_CANDIDATE_REGEX,
    WSL_UNC_PATH_CANDIDATE_REGEX,
    WSL_MOUNT_PATH_CANDIDATE_REGEX,
  ]) {
    for (const match of value.matchAll(regex)) {
      const candidate = match[0]?.trim();
      if (candidate) {
        candidates.add(candidate);
      }
    }
  }

  return [...candidates];
}

function isAbsolutePathLike(value: string): boolean {
  return (
    /^(?:\\\\\?\\)?[a-zA-Z]:\\/.test(value) ||
    /^\\\\wsl(?:\.localhost)?\\/.test(value) ||
    /^\/mnt\/[a-z](?:\/|$)/i.test(value)
  );
}

function looksLikeJsonStructuredText(value: string): boolean {
  if (value.length > MAX_NESTED_JSON_STRING_LENGTH) {
    return false;
  }

  return (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  );
}

async function buildHtmlExport(
  sessionFilePath: string,
  records: JsonlRecord[],
  options: NormalizedHtmlExportOptions,
  assetDirectoryName: string,
  runtimeOptions: ExportRuntimeOptions,
): Promise<{ html: string; assets: HtmlImageAsset[] }> {
  const sessionMeta = findSessionExportMetadata(records);
  if (!sessionMeta) {
    throw new Error(`No session_meta record found in ${sessionFilePath}`);
  }

  const transcriptSections: string[] = [];
  let omittedBootstrapMessages = 0;
  const renderContext: HtmlRenderContext = {
    assetDirectoryName,
    assets: [],
    nextImageIndex: 1,
    options,
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.type !== "response_item") {
      if (shouldPulseExportProgress(index, records.length)) {
        await pulseExportLoop(runtimeOptions, index + 1, records.length, {
          stage: "rendering",
          startPercent: 32,
          endPercent: 82,
          message: "Rendering HTML transcript...",
        });
      }
      continue;
    }

    const item = asObject(record.payload);
    if (!item || typeof item.type !== "string") {
      continue;
    }

    const rendered =
      item.type === "message"
        ? renderHtmlMessageEntry(record, item, renderContext)
        : options.includeToolCallResults && item.type === "function_call"
          ? renderHtmlToolCallEntry(record, item, "Tool Call")
          : options.includeToolCallResults && item.type === "function_call_output"
            ? renderHtmlToolOutputEntry(record, item, "Tool Output")
            : options.includeToolCallResults && item.type === "custom_tool_call"
              ? renderHtmlCustomToolCallEntry(record, item)
              : options.includeToolCallResults && item.type === "custom_tool_call_output"
                ? renderHtmlCustomToolOutputEntry(record, item)
                : item.type === "reasoning"
                  ? renderHtmlReasoningEntry(record, item)
                  : null;

    if (rendered === "bootstrap-omitted") {
      omittedBootstrapMessages += 1;
      continue;
    }

    if (rendered) {
      transcriptSections.push(numberMarkdownTranscriptEntry(rendered, transcriptSections.length + 1));
    }

    if (shouldPulseExportProgress(index, records.length)) {
      await pulseExportLoop(runtimeOptions, index + 1, records.length, {
        stage: "rendering",
        startPercent: 32,
        endPercent: 82,
        message: "Rendering HTML transcript...",
      });
    }
  }

  await reportExportProgress(runtimeOptions, {
    stage: "rendering",
    message: "HTML transcript rendered.",
    progressPercent: 82,
  });

  const title = sessionMeta.id;
  const styles = `
    :root {
      --bg: #f8f9fa;
      --text: #212529;
      --muted: #6c757d;
      --accent: #0d6efd;
      --user-bg: #e7f3ff;
      --assistant-bg: #ffffff;
      --border: #dee2e6;
      --shadow: 0 2px 4px rgba(0,0,0,0.05);
      --pre-bg: #f8f9fa;
    }
    html.dark {
      --bg: #212529;
      --text: #f8f9fa;
      --muted: #adb5bd;
      --accent: #3793ff;
      --user-bg: #2b3035;
      --assistant-bg: #343a40;
      --border: #495057;
      --shadow: 0 2px 4px rgba(0,0,0,0.3);
      --pre-bg: #1a1d20;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      color: var(--text);
      background: var(--bg);
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem 1rem;
      transition: background 0.2s, color 0.2s;
    }
    header {
      margin-bottom: 3rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
      position: relative;
    }
    .theme-toggle {
      position: absolute;
      top: 0;
      right: 0;
      padding: 0.5rem;
      cursor: pointer;
      background: none;
      border: 1px solid var(--border);
      border-radius: 0.25rem;
      color: var(--text);
      font-size: 0.8rem;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 1rem;
      font-size: 0.9rem;
      color: var(--muted);
    }
    .meta-item b { color: var(--text); }
    .transcript {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      counter-reset: bubble;
    }
    .bubble {
      counter-increment: bubble;
      max-width: 85%;
      padding: 1rem 1.25rem;
      border-radius: 1.25rem;
      box-shadow: var(--shadow);
      position: relative;
    }
    .bubble::before {
      content: "#" counter(bubble);
      position: absolute;
      top: -0.75rem;
      left: 1rem;
      padding: 0.15rem 0.45rem;
      border-radius: 999px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 0.7rem;
      font-weight: 700;
      line-height: 1;
    }
    .bubble-user {
      align-self: flex-end;
      background: var(--user-bg);
      border-bottom-right-radius: 0.25rem;
    }
    .bubble-assistant {
      align-self: flex-start;
      background: var(--assistant-bg);
      border-bottom-left-radius: 0.25rem;
      border: 1px solid var(--border);
    }
    .bubble-tool {
      align-self: center;
      background: var(--pre-bg);
      border: 1px dashed var(--border);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 0.85rem;
      max-width: 95%;
    }
    .bubble-reasoning {
      align-self: flex-start;
      background: rgba(255, 249, 219, 0.1);
      border: 1px solid #ffe066;
      font-style: italic;
      font-size: 0.9rem;
    }
    .bubble-header {
      font-size: 0.75rem;
      font-weight: bold;
      text-transform: uppercase;
      margin-bottom: 0.5rem;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
    }
    .bubble-content {
      word-break: break-word;
    }
    pre {
      background: var(--pre-bg);
      padding: 1rem;
      border-radius: 0.5rem;
      overflow-x: auto;
      border: 1px solid var(--border);
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9em;
    }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 0.5rem;
      margin: 0.5rem 0;
    }
  `;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Session - ${escapeHtml(title)}</title>
  <style>${styles}</style>
  <script>
    function toggleTheme() {
      const isDark = document.documentElement.classList.toggle("dark");
      localStorage.setItem("theme", isDark ? "dark" : "light");
    }
    if (localStorage.getItem("theme") === "dark" || (!localStorage.getItem("theme") && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
      document.documentElement.classList.add("dark");
    }
  </script>
</head>
<body>
  <header>
    <button class="theme-toggle" onclick="toggleTheme()">🌓 Theme</button>
    <h1>Codex Session Export</h1>
    <div class="meta-grid">
      <div class="meta-item"><b>ID:</b> ${escapeHtml(sessionMeta.id)}</div>
      <div class="meta-item"><b>Started:</b> ${escapeHtml(sessionMeta.startedAt ?? "unknown")}</div>
      <div class="meta-item"><b>CWD:</b> ${escapeHtml(sessionMeta.cwd)}</div>
      <div class="meta-item"><b>Originator:</b> ${escapeHtml(sessionMeta.originator ?? "unknown")}</div>
      <div class="meta-item"><b>CLI:</b> ${escapeHtml(sessionMeta.cliVersion ?? "unknown")}</div>
      <div class="meta-item"><b>Source:</b> ${escapeHtml(sessionMeta.source ?? "unknown")}</div>
      <div class="meta-item"><b>Model:</b> ${escapeHtml(sessionMeta.modelProvider ?? "unknown")}</div>
      <div class="meta-item"><b>Images:</b> ${escapeHtml(describeHtmlImageMode(options))}</div>
      <div class="meta-item"><b>Exported:</b> ${escapeHtml(new Date().toISOString())}</div>
    </div>
  </header>
  <div class="transcript">
    ${transcriptSections.join("\n")}
  </div>
</body>
</html>`;

  // Use a small delay to prevent blocking the event loop too long for very large sessions
  // but since we're in a worker-like environment (Bun RPC), the main issue is usually
  // just the sheer size of the string being passed back.
  
  return { html, assets: renderContext.assets };
}

function renderHtmlMessageEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
  context: HtmlRenderContext,
): string | "bootstrap-omitted" | null {
  const role = typeof item.role === "string" ? item.role : "unknown";
  if (role === "developer") {
    return null;
  }

  const renderedContent = renderHtmlMessageContent(item.content, context);
  if (!renderedContent.text && renderedContent.imageHtml.length === 0) {
    return null;
  }

  if (role === "user" && looksLikeBootstrapContext(renderedContent.text)) {
    return "bootstrap-omitted";
  }

  const phase = typeof item.phase === "string" ? ` [${item.phase}]` : "";
  const timestamp = formatTimestamp(record.timestamp);

  return `
    <div class="bubble bubble-${role}">
      <div class="bubble-header">
        <span>${toTitleCase(role)}${phase}</span>
        <span>${timestamp}</span>
      </div>
      <div class="bubble-content">
        ${renderedContent.text.split("\n\n").map(p => `<p>${escapeHtml(p)}</p>`).join("")}
        ${renderedContent.imageHtml.join("")}
      </div>
    </div>
  `;
}

function renderHtmlToolCallEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
  label: string,
): string {
  const toolName = typeof item.name === "string" ? item.name : "unknown-tool";
  const argumentsText = prettyStructuredText(item.arguments);
  return `
    <div class="bubble bubble-tool">
      <div class="bubble-header">
        <span>${escapeHtml(`${label}: ${toolName}`)}</span>
        <span>${escapeHtml(formatTimestamp(record.timestamp))}</span>
      </div>
      <pre><code>${escapeHtml(argumentsText)}</code></pre>
    </div>
  `;
}

function renderHtmlToolOutputEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
  label: string,
): string {
  const callId = typeof item.call_id === "string" ? ` (${item.call_id})` : "";
  const outputText = prettyStructuredText(item.output);
  return `
    <div class="bubble bubble-tool">
      <div class="bubble-header">
        <span>${escapeHtml(`${label}${callId}`)}</span>
        <span>${escapeHtml(formatTimestamp(record.timestamp))}</span>
      </div>
      <pre><code>${escapeHtml(outputText)}</code></pre>
    </div>
  `;
}

function renderHtmlCustomToolCallEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
): string {
  const toolName = typeof item.name === "string" ? item.name : "custom-tool";
  const status = typeof item.status === "string" ? ` [${item.status}]` : "";
  const inputText = prettyStructuredText(item.input);
  return `
    <div class="bubble bubble-tool">
      <div class="bubble-header">
        <span>${escapeHtml(`Custom Tool Call: ${toolName}${status}`)}</span>
        <span>${escapeHtml(formatTimestamp(record.timestamp))}</span>
      </div>
      <pre><code>${escapeHtml(inputText)}</code></pre>
    </div>
  `;
}

function renderHtmlCustomToolOutputEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
): string {
  const callId = typeof item.call_id === "string" ? ` (${item.call_id})` : "";
  const outputText = prettyStructuredText(item.output);
  return `
    <div class="bubble bubble-tool">
      <div class="bubble-header">
        <span>${escapeHtml(`Custom Tool Output${callId}`)}</span>
        <span>${escapeHtml(formatTimestamp(record.timestamp))}</span>
      </div>
      <pre><code>${escapeHtml(outputText)}</code></pre>
    </div>
  `;
}

function renderHtmlReasoningEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
): string | null {
  const summaries = Array.isArray(item.summary)
    ? item.summary.map(extractReasoningSummaryText).filter(Boolean)
    : [];
  if (summaries.length === 0) {
    return null;
  }

  return `
    <div class="bubble bubble-reasoning">
      <div class="bubble-header">
        <span>Reasoning Summary</span>
        <span>${formatTimestamp(record.timestamp)}</span>
      </div>
      <ul>
        ${summaries.map(s => `<li>${escapeHtml(s)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function renderHtmlMessageContent(
  content: unknown,
  context: HtmlRenderContext,
): { text: string; imageHtml: string[] } {
  if (!Array.isArray(content)) {
    return { text: "", imageHtml: [] };
  }

  const textChunks: string[] = [];
  const imageHtml: string[] = [];

  for (const item of content) {
    if (typeof item === "string") {
      textChunks.push(item);
      continue;
    }

    const contentPart = asObject(item);
    if (!contentPart) {
      continue;
    }

    if (context.options.includeImages) {
      const renderedImage = renderHtmlMessageImage(contentPart, context);
      if (renderedImage) {
        imageHtml.push(renderedImage);
        continue;
      }
    }

    if (looksLikeImageContentPart(contentPart)) {
      continue;
    }

    if (typeof contentPart.text === "string") {
      textChunks.push(contentPart.text);
      continue;
    }

    if (typeof contentPart.input_text === "string") {
      textChunks.push(contentPart.input_text);
      continue;
    }

    if (typeof contentPart.output_text === "string") {
      textChunks.push(contentPart.output_text);
      continue;
    }

    textChunks.push(prettyStructuredText(contentPart));
  }

  return {
    text: stripImagePlaceholderTags(textChunks.map((chunk) => chunk.trim()).filter(Boolean).join("\n\n")),
    imageHtml,
  };
}

function renderHtmlMessageImage(
  contentPart: Record<string, unknown>,
  context: HtmlRenderContext,
): string | null {
  if (!looksLikeImageContentPart(contentPart)) {
    return null;
  }

  const imageSource =
    typeof contentPart.image_url === "string"
      ? contentPart.image_url.trim()
      : typeof contentPart.url === "string"
        ? contentPart.url.trim()
        : "";
  if (!imageSource) {
    return null;
  }

  const imageReference = persistHtmlImageReference(imageSource, context);
  if (!imageReference) {
    return null;
  }

  const altText =
    typeof contentPart.alt_text === "string" && contentPart.alt_text.trim()
      ? contentPart.alt_text.trim()
      : `Image ${context.nextImageIndex - 1}`;
  return `<img src="${escapeHtml(imageReference)}" alt="${escapeHtml(altText)}">`;
}

function persistHtmlImageReference(
  imageSource: string,
  context: HtmlRenderContext,
): string | null {
  if (/^data:image\//i.test(imageSource)) {
    if (context.options.inlineImages) {
      return imageSource;
    }

    const asset = createImageAssetFromDataUrl(imageSource, context);
    if (!asset) {
      return null;
    }
    context.assets.push(asset);
    return `./${context.assetDirectoryName}/${asset.fileName}`;
  }

  return imageSource;
}

function describeHtmlImageMode(options: NormalizedHtmlExportOptions): string {
  if (!options.includeImages) {
    return "not included";
  }

  return options.inlineImages ? "embedded inline" : "saved to asset folder";
}

function escapeHtml(text: string): string {
  return stabilizeExportText(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function buildMarkdownExport(
  sessionFilePath: string,
  records: JsonlRecord[],
  options: NormalizedMarkdownExportOptions,
  assetDirectoryName: string,
  runtimeOptions: ExportRuntimeOptions,
): Promise<{ markdown: string; assets: MarkdownImageAsset[] }> {
  const sessionMeta = findSessionExportMetadata(records);
  if (!sessionMeta) {
    throw new Error(`No session_meta record found in ${sessionFilePath}`);
  }

  const transcriptSections: string[] = [];
  let omittedBootstrapMessages = 0;
  const renderContext: MarkdownRenderContext = {
    assetDirectoryName,
    assets: [],
    nextImageIndex: 1,
    options,
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.type !== "response_item") {
      if (shouldPulseExportProgress(index, records.length)) {
        await pulseExportLoop(runtimeOptions, index + 1, records.length, {
          stage: "rendering",
          startPercent: 32,
          endPercent: 82,
          message: "Rendering Markdown transcript...",
        });
      }
      continue;
    }

    const item = asObject(record.payload);
    if (!item || typeof item.type !== "string") {
      continue;
    }

    const rendered =
      item.type === "message"
        ? renderMessageEntry(record, item, renderContext)
        : options.includeToolCallResults && item.type === "function_call"
          ? renderToolCallEntry(record, item, "Tool Call")
          : options.includeToolCallResults && item.type === "function_call_output"
            ? renderToolOutputEntry(record, item, "Tool Output")
            : options.includeToolCallResults && item.type === "custom_tool_call"
              ? renderCustomToolCallEntry(record, item)
              : options.includeToolCallResults && item.type === "custom_tool_call_output"
                ? renderCustomToolOutputEntry(record, item)
                : item.type === "reasoning"
                  ? renderReasoningEntry(record, item)
                  : null;

    if (rendered === "bootstrap-omitted") {
      omittedBootstrapMessages += 1;
      continue;
    }

    if (rendered) {
      transcriptSections.push(rendered);
    }

    if (shouldPulseExportProgress(index, records.length)) {
      await pulseExportLoop(runtimeOptions, index + 1, records.length, {
        stage: "rendering",
        startPercent: 32,
        endPercent: 82,
        message: "Rendering Markdown transcript...",
      });
    }
  }

  await reportExportProgress(runtimeOptions, {
    stage: "rendering",
    message: "Markdown transcript rendered.",
    progressPercent: 82,
  });

  const headerLines = [
    "# Codex Session Export",
    "",
    `- Source JSONL: \`${sessionFilePath}\``,
    `- Session ID: \`${sessionMeta.id}\``,
    `- Started: ${sessionMeta.startedAt ?? "unknown"}`,
    `- CWD: \`${sessionMeta.cwd}\``,
    `- Originator: ${sessionMeta.originator ?? "unknown"}`,
    `- CLI Version: ${sessionMeta.cliVersion ?? "unknown"}`,
    `- Source: ${sessionMeta.source ?? "unknown"}`,
    `- Model Provider: ${sessionMeta.modelProvider ?? "unknown"}`,
    `- Included images: ${options.includeImages ? "yes" : "no"}`,
    `- Included tool calls and results: ${options.includeToolCallResults ? "yes" : "no"}`,
    `- Exported: ${new Date().toISOString()}`,
  ];

  if (omittedBootstrapMessages > 0) {
    headerLines.push(`- Omitted bootstrap messages: ${omittedBootstrapMessages}`);
  }

  headerLines.push("", "## Transcript", "");

  if (transcriptSections.length === 0) {
    headerLines.push("_No transcript items were found in the response stream._", "");
    return {
      markdown: headerLines.join("\n"),
      assets: renderContext.assets,
    };
  }

  return {
    markdown: `${headerLines.join("\n")}${transcriptSections.join("\n\n")}\n`,
    assets: renderContext.assets,
  };
}

function findSessionExportMetadata(records: JsonlRecord[]): SessionExportMetadata | null {
  for (const record of records) {
    if (record.type !== "session_meta") {
      continue;
    }

    const payload = asObject(record.payload);
    if (!payload || typeof payload.id !== "string" || typeof payload.cwd !== "string") {
      continue;
    }

    return {
      id: payload.id,
      startedAt:
        typeof payload.timestamp === "string"
          ? payload.timestamp
          : typeof record.timestamp === "string"
            ? record.timestamp
            : null,
      cwd: payload.cwd,
      originator: typeof payload.originator === "string" ? payload.originator : null,
      cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : null,
      source: typeof payload.source === "string" ? payload.source : null,
      modelProvider:
        typeof payload.model_provider === "string" ? payload.model_provider : null,
    };
  }

  return null;
}

function renderMessageEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
  context: MarkdownRenderContext,
): string | "bootstrap-omitted" | null {
  const role = typeof item.role === "string" ? item.role : "unknown";
  if (role === "developer") {
    return null;
  }

  const renderedContent = renderMessageContent(item.content, context);
  if (!renderedContent.text && renderedContent.imageMarkdown.length === 0) {
    return null;
  }

  if (role === "user" && looksLikeBootstrapContext(renderedContent.text)) {
    return "bootstrap-omitted";
  }

  const phase = typeof item.phase === "string" ? ` [${item.phase}]` : "";
  const sections: string[] = [];
  if (renderedContent.text) {
    sections.push(renderedContent.text);
  }
  if (renderedContent.imageMarkdown.length > 0) {
    sections.push(renderedContent.imageMarkdown.join("\n\n"));
  }

  return `### ${formatTimestamp(record.timestamp)} ${toTitleCase(role)}${phase}\n\n${sections.join("\n\n")}`;
}

function renderToolCallEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
  label: string,
): string {
  const toolName = typeof item.name === "string" ? item.name : "unknown-tool";
  const argumentsText = prettyStructuredText(item.arguments);
  return [
    `### ${formatTimestamp(record.timestamp)} ${label}: ${toolName}`,
    "",
    renderCodeBlock(argumentsText, "json"),
  ].join("\n");
}

function renderToolOutputEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
  label: string,
): string {
  const callId = typeof item.call_id === "string" ? ` (${item.call_id})` : "";
  const outputText = prettyStructuredText(item.output);
  return [
    `### ${formatTimestamp(record.timestamp)} ${label}${callId}`,
    "",
    renderCodeBlock(outputText, "text"),
  ].join("\n");
}

function renderCustomToolCallEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
): string {
  const toolName = typeof item.name === "string" ? item.name : "custom-tool";
  const status = typeof item.status === "string" ? ` [${item.status}]` : "";
  const inputText = prettyStructuredText(item.input);
  return [
    `### ${formatTimestamp(record.timestamp)} Custom Tool Call: ${toolName}${status}`,
    "",
    renderCodeBlock(inputText, "text"),
  ].join("\n");
}

function renderCustomToolOutputEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
): string {
  const callId = typeof item.call_id === "string" ? ` (${item.call_id})` : "";
  const outputText = prettyStructuredText(item.output);
  return [
    `### ${formatTimestamp(record.timestamp)} Custom Tool Output${callId}`,
    "",
    renderCodeBlock(outputText, "text"),
  ].join("\n");
}

function renderReasoningEntry(
  record: JsonlRecord,
  item: Record<string, unknown>,
): string | null {
  const summaries = Array.isArray(item.summary)
    ? item.summary.map(extractReasoningSummaryText).filter(Boolean)
    : [];
  if (summaries.length === 0) {
    return null;
  }

  return `### ${formatTimestamp(record.timestamp)} Reasoning Summary\n\n${summaries
    .map((summary) => `- ${summary}`)
    .join("\n")}`;
}

function numberMarkdownTranscriptEntry(section: string, index: number): string {
  return section.replace(/^###\s+/, `### ${index}. `);
}

function extractReasoningSummaryText(entry: unknown): string {
  if (typeof entry === "string") {
    return entry.trim();
  }

  const item = asObject(entry);
  if (!item) {
    return "";
  }

  if (typeof item.text === "string") {
    return item.text.trim();
  }

  return "";
}

function renderMessageContent(
  content: unknown,
  context: MarkdownRenderContext,
): RenderedMessageContent {
  if (!Array.isArray(content)) {
    return {
      text: "",
      imageMarkdown: [],
    };
  }

  const textChunks: string[] = [];
  const imageMarkdown: string[] = [];

  for (const item of content) {
    if (typeof item === "string") {
      textChunks.push(item);
      continue;
    }

    const contentPart = asObject(item);
    if (!contentPart) {
      continue;
    }

    if (context.options.includeImages) {
      const renderedImage = renderMessageImage(contentPart, context);
      if (renderedImage) {
        imageMarkdown.push(renderedImage);
        continue;
      }
    }

    if (looksLikeImageContentPart(contentPart)) {
      continue;
    }

    if (typeof contentPart.text === "string") {
      textChunks.push(contentPart.text);
      continue;
    }

    if (typeof contentPart.input_text === "string") {
      textChunks.push(contentPart.input_text);
      continue;
    }

    if (typeof contentPart.output_text === "string") {
      textChunks.push(contentPart.output_text);
      continue;
    }

    textChunks.push(prettyStructuredText(contentPart));
  }

  return {
    text: stripImagePlaceholderTags(
      textChunks
    .map((chunk) => chunk.trim())
      .filter(Boolean)
      .join("\n\n"),
    ),
    imageMarkdown,
  };
}

function stripImagePlaceholderTags(text: string): string {
  return text
    .replace(/^\s*<\/?image>\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMessageLikeText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const textChunks: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      textChunks.push(item);
      continue;
    }

    const contentPart = asObject(item);
    if (!contentPart || looksLikeImageContentPart(contentPart)) {
      continue;
    }

    if (typeof contentPart.text === "string") {
      textChunks.push(contentPart.text);
      continue;
    }

    if (typeof contentPart.input_text === "string") {
      textChunks.push(contentPart.input_text);
      continue;
    }

    if (typeof contentPart.output_text === "string") {
      textChunks.push(contentPart.output_text);
      continue;
    }

    textChunks.push(prettyStructuredText(contentPart));
  }

  return stripImagePlaceholderTags(
    textChunks
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .join("\n\n"),
  );
}

function renderMessageImage(
  contentPart: Record<string, unknown>,
  context: MarkdownRenderContext,
): string | null {
  if (!looksLikeImageContentPart(contentPart)) {
    return null;
  }

  const imageSource =
    typeof contentPart.image_url === "string"
      ? contentPart.image_url.trim()
      : typeof contentPart.url === "string"
        ? contentPart.url.trim()
        : "";
  if (!imageSource) {
    return null;
  }

  const imageReference = persistImageReference(imageSource, context);
  if (!imageReference) {
    return null;
  }

  const altText =
    typeof contentPart.alt_text === "string" && contentPart.alt_text.trim()
      ? contentPart.alt_text.trim()
      : `Image ${context.nextImageIndex - 1}`;
  return `![${escapeMarkdownText(altText)}](${imageReference})`;
}

function looksLikeImageContentPart(contentPart: Record<string, unknown>): boolean {
  const partType = typeof contentPart.type === "string" ? contentPart.type.toLowerCase() : "";
  return (
    partType.includes("image") ||
    typeof contentPart.image_url === "string" ||
    typeof contentPart.url === "string"
  );
}

function persistImageReference(
  imageSource: string,
  context: MarkdownRenderContext,
): string | null {
  if (/^data:image\//i.test(imageSource)) {
    const asset = createImageAssetFromDataUrl(imageSource, context);
    if (!asset) {
      return null;
    }

    context.assets.push(asset);
    return `./${context.assetDirectoryName}/${asset.fileName}`;
  }

  return imageSource;
}

function createImageAssetFromDataUrl(
  dataUrl: string,
  context: { nextImageIndex: number },
): ExportImageAsset | null {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i);
  if (!match) {
    return null;
  }

  const mimeType = (match[1] ?? "image/png").toLowerCase();
  const extension = extensionForMimeType(mimeType);
  if (!extension) {
    return null;
  }

  try {
    const data = Uint8Array.from(Buffer.from(match[2], "base64"));
    const fileName = `image-${String(context.nextImageIndex).padStart(3, "0")}.${extension}`;
    context.nextImageIndex += 1;
    return {
      fileName,
      data,
    };
  } catch {
    return null;
  }
}

function extensionForMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return null;
  }
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\[\]()]/g, "\\$&");
}

function stabilizeExportText(value: string): string {
  let output = "";

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0d
    ) {
      output += value[index];
      continue;
    }

    if (
      (codeUnit >= 0x00 && codeUnit <= 0x1f) ||
      (codeUnit >= 0x7f && codeUnit <= 0x9f)
    ) {
      output += `\\u${codeUnit.toString(16).padStart(4, "0")}`;
      continue;
    }

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
        continue;
      }

      output += `\\u${codeUnit.toString(16).padStart(4, "0")}`;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      output += `\\u${codeUnit.toString(16).padStart(4, "0")}`;
      continue;
    }

    output += value[index];
  }

  return output;
}

function looksLikeBootstrapContext(text: string): boolean {
  return (
    text.includes("# AGENTS.md instructions") ||
    text.includes("<environment_context>") ||
    text.includes("<permissions instructions>") ||
    text.includes("<collaboration_mode>")
  );
}

function prettyStructuredText(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return value;
    }

    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }

  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value, null, 2);
}

function renderCodeBlock(text: string, language: string): string {
  const stabilizedText = stabilizeExportText(text || "(empty)");
  const longestFenceRun = Math.max(
    0,
    ...Array.from(stabilizedText.matchAll(/~+/g), (match) => match[0].length),
  );
  const fence = "~".repeat(Math.max(3, longestFenceRun + 1));
  return `${fence}${language}\n${stabilizedText}\n${fence}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function formatTimestamp(value: unknown): string {
  return typeof value === "string" ? value : "unknown-time";
}

function toTitleCase(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function matchesRootAliases(
  candidatePath: string,
  rootAliases: ComparablePathAlias[],
): boolean {
  const candidateAliases = getComparablePathAliases(candidatePath);
  for (const candidateAlias of candidateAliases) {
    for (const rootAlias of rootAliases) {
      if (candidateAlias.style !== rootAlias.style) {
        continue;
      }

      if (
        isSamePathOrChildForStyle(
          candidateAlias.compareValue,
          rootAlias.compareValue,
          candidateAlias.style,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function isSamePathOrChildForStyle(
  candidatePath: string,
  rootPath: string,
  style: PathStyle,
): boolean {
  const relativePath =
    style === "win"
      ? path.win32.relative(rootPath, candidatePath)
      : path.posix.relative(rootPath, candidatePath);

  const isAbsolute =
    style === "win"
      ? path.win32.isAbsolute(relativePath)
      : path.posix.isAbsolute(relativePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute);
}

function getComparablePathAliases(inputPath: string): ComparablePathAlias[] {
  const trimmed = inputPath.trim();
  const aliases = new Map<string, ComparablePathAlias>();

  const addAlias = (style: PathStyle, candidateValue: string | null): void => {
    if (!candidateValue) {
      return;
    }

    const normalized =
      style === "win"
        ? normalizeWindowsPath(candidateValue)
        : normalizePosixPath(candidateValue);
    if (!normalized) {
      return;
    }

    const compareValue =
      style === "win" ? normalizeWindowsComparisonPath(normalized) : normalized;
    aliases.set(`${style}:${compareValue}`, { style, value: normalized, compareValue });
  };

  const windowsPath = normalizeWindowsPath(trimmed);
  if (windowsPath) {
    addAlias("win", windowsPath);
    addAlias("posix", windowsDrivePathToWslMount(windowsPath));
  }

  const wslMountPath = normalizeWslMountPath(trimmed);
  if (wslMountPath) {
    addAlias("posix", wslMountPath);
    addAlias("win", wslMountPathToWindowsDrive(wslMountPath));
  }

  const wslUncPath = parseWslUncPath(trimmed);
  if (wslUncPath) {
    addAlias("win", wslUncPath.winPath);
    addAlias("posix", wslUncPath.posixPath);
    addAlias(
      "win",
      wslMountPathToWindowsDrive(normalizeWslMountPath(wslUncPath.posixPath)),
    );
  }

  const posixPath = normalizeAbsolutePosixPath(trimmed);
  if (posixPath) {
    addAlias("posix", posixPath);
  }

  if (aliases.size === 0) {
    if (process.platform === "win32") {
      addAlias("win", path.win32.resolve(trimmed));
    } else {
      addAlias("posix", path.posix.resolve(trimmed));
    }
  }

  return [...aliases.values()];
}

export function resolveFilesystemPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (process.platform === "win32") {
    return (
      normalizeWindowsPath(trimmed) ??
      wslMountPathToWindowsDrive(normalizeWslMountPath(trimmed)) ??
      parseWslUncPath(trimmed)?.winPath ??
      path.resolve(trimmed)
    );
  }

  return (
    normalizeAbsolutePosixPath(trimmed) ??
    windowsDrivePathToWslMount(normalizeWindowsPath(trimmed)) ??
    parseWslUncPath(trimmed)?.posixPath ??
    path.resolve(trimmed)
  );
}

function normalizeWindowsPath(inputPath: string): string | null {
  const slashNormalized = inputPath.replace(/\//g, "\\");
  if (!/^(?:[a-zA-Z]:\\|\\\\|[a-zA-Z]:$)/.test(slashNormalized)) {
    return null;
  }

  return trimTrailingWindowsSeparators(path.win32.normalize(slashNormalized));
}

function normalizeWindowsComparisonPath(inputPath: string): string {
  return inputPath.toLowerCase();
}

function normalizePosixPath(inputPath: string): string | null {
  if (!inputPath.startsWith("/")) {
    return null;
  }

  return trimTrailingPosixSeparators(path.posix.normalize(inputPath));
}

function normalizeAbsolutePosixPath(inputPath: string): string | null {
  return normalizePosixPath(inputPath);
}

function normalizeWslMountPath(inputPath: string): string | null {
  const normalized = normalizeAbsolutePosixPath(inputPath);
  if (!normalized || !/^\/mnt\/[a-z](?:\/|$)/i.test(normalized)) {
    return null;
  }

  return normalized;
}

function windowsDrivePathToWslMount(inputPath: string | null): string | null {
  if (!inputPath) {
    return null;
  }

  const match = inputPath.match(/^([a-z]):\\?(.*)$/i);
  if (!match) {
    return null;
  }

  const driveLetter = match[1].toLowerCase();
  const remainder = match[2].replace(/\\/g, "/");
  return remainder ? `/mnt/${driveLetter}/${remainder}` : `/mnt/${driveLetter}`;
}

function wslMountPathToWindowsDrive(inputPath: string | null): string | null {
  if (!inputPath) {
    return null;
  }

  const match = inputPath.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (!match) {
    return null;
  }

  const driveLetter = match[1].toLowerCase();
  const remainder = (match[2] ?? "").replace(/\//g, "\\");
  return remainder ? `${driveLetter}:\\${remainder}` : `${driveLetter}:\\`;
}

function parseWslUncPath(inputPath: string): { winPath: string; posixPath: string } | null {
  const slashNormalized = inputPath.replace(/\//g, "\\");
  const match = slashNormalized.match(/^\\\\wsl(?:\.localhost)?\\[^\\]+(?:\\(.*))?$/i);
  if (!match) {
    return null;
  }

  const parts = slashNormalized.split("\\").filter(Boolean);
  if (parts.length < 3) {
    return null;
  }

  const remainder = parts.slice(2).join("\\");
  const posixPath = remainder ? `/${remainder.replace(/\\/g, "/")}` : "/";
  return {
    winPath: slashNormalized,
    posixPath,
  };
}

function trimTrailingWindowsSeparators(inputPath: string): string {
  const parsed = path.win32.parse(inputPath);
  if (inputPath === parsed.root) {
    return inputPath;
  }

  return inputPath.replace(/[\\]+$/, "");
}

function trimTrailingPosixSeparators(inputPath: string): string {
  if (inputPath === "/") {
    return inputPath;
  }

  return inputPath.replace(/\/+$/, "");
}

function compareByNewestDesc(left: SessionMetaMatch, right: SessionMetaMatch): number {
  const leftTime = Date.parse(left.updatedAt ?? left.startedAt ?? "");
  const rightTime = Date.parse(right.updatedAt ?? right.startedAt ?? "");

  if (!Number.isNaN(leftTime) || !Number.isNaN(rightTime)) {
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  }

  return right.file.localeCompare(left.file);
}
