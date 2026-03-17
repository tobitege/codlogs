import * as childProcess from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import {
  DEFAULT_CODEX_HOME,
  type ExportProgress,
  exportSessionJsonlToMarkdown,
  exportSessionJsonlToHtml,
  findCodexSessions,
  getSessionDetailMetrics,
} from "../shared/codlogs-core.ts";
import type { CodexerRPC, EnvironmentCapabilities } from "../shared/rpc.ts";
import {
  buildCodexCurrentDayRolloutPath,
  generateUuidV7String,
} from "../shared/codex-rollout.ts";
import { normalizeSessionTitle } from "../shared/session-title.ts";
import {
  extractCompactionEncryptedContentFromJsonlLine,
  sanitizeCompactedRolloutLine,
  sanitizeEventMsgJsonlLine,
  sanitizeResponseItemJsonlLine,
  sanitizeTurnContextJsonlLine,
  type SanitizedSessionStats,
} from "../shared/sanitized-session.ts";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const SETTINGS_FILE_NAME = "codlogs-settings.json";
const RPC_MAX_REQUEST_TIME_MS = 15 * 60 * 1000;

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: using Vite dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log("Vite dev server not running. Falling back to bundled mainview.");
    }
  }

  return "views://mainview/index.html";
}

function normalizeDialogResult(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function getAppWorkingDirectory(): string {
  const preferred =
    normalizeDialogResult(process.env.INIT_CWD) ??
    normalizeDialogResult(process.env.PWD) ??
    process.cwd();
  const normalized = path.resolve(preferred);
  const runtimeBuildMatch = normalized.match(
    /^(.*?)[\\/]build[\\/](?:dev|release)-[^\\/]+[\\/][^\\/]+[\\/]bin$/i,
  );
  return runtimeBuildMatch?.[1] ? path.resolve(runtimeBuildMatch[1]) : normalized;
}

function getStartingFolder(candidate: string | null): string {
  const trimmed = candidate?.trim() ?? "";
  return trimmed || getAppWorkingDirectory();
}

function getSuggestedExportFileName(
  sessionFilePath: string,
  extension: "html" | "md",
): string {
  return `${path.parse(sessionFilePath).name}.${extension}`;
}

function resolveCodexHomePath(codexHome: string | null | undefined): string {
  return path.resolve(codexHome ?? process.env.CODEX_HOME ?? DEFAULT_CODEX_HOME);
}

type AppSettings = {
  exportDirectory?: string | null;
  lastOpenedFolder?: string | null;
  windowFrame?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

type ExportJobStatus = {
  kind: "working" | "success" | "error" | "cancelled";
  progressPercent: number;
  stage: string;
  message: string;
  outputPath: string | null;
};

type ExportJobRecord = {
  controller: AbortController;
  status: ExportJobStatus;
};

type SanitizedCopyJobRecord = {
  controller: AbortController;
  status: ExportJobStatus;
};

type SessionMetaRecord = {
  timestamp?: string;
  type: string;
  payload?: Record<string, unknown>;
};

type SessionIndexRecord = {
  id: string;
  thread_name: string;
  updated_at: string;
};

const EXPORT_JOB_RETENTION_MS = 5 * 60 * 1000;
const exportJobs = new Map<string, ExportJobRecord>();
const sanitizedCopyJobs = new Map<string, SanitizedCopyJobRecord>();
const DEFAULT_WINDOW_FRAME = {
  width: 1600,
  height: 1000,
  x: 100,
  y: 60,
};

let settingsCache: AppSettings | null = null;
let settingsWriteQueue = Promise.resolve();

function asErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function scheduleExportJobCleanup(jobId: string): void {
  setTimeout(() => {
    exportJobs.delete(jobId);
  }, EXPORT_JOB_RETENTION_MS);
}

function getMissingExportJobStatus(): ExportJobStatus {
  return {
    kind: "error",
    progressPercent: 0,
    stage: "missing",
    message: "The export job is no longer available.",
    outputPath: null,
  };
}

function getMissingSanitizedCopyJobStatus(): ExportJobStatus {
  return {
    kind: "error",
    progressPercent: 0,
    stage: "missing",
    message: "The text-only copy job is no longer available.",
    outputPath: null,
  };
}

function getExportJobStatus(jobId: string): ExportJobStatus {
  return exportJobs.get(jobId)?.status ?? getMissingExportJobStatus();
}

function getSanitizedCopyJobStatus(jobId: string): ExportJobStatus {
  return sanitizedCopyJobs.get(jobId)?.status ?? getMissingSanitizedCopyJobStatus();
}

function setExportJobStatus(jobId: string, status: ExportJobStatus): void {
  const existing = exportJobs.get(jobId);
  if (!existing) {
    return;
  }

  existing.status = status;
}

function setSanitizedCopyJobStatus(jobId: string, status: ExportJobStatus): void {
  const existing = sanitizedCopyJobs.get(jobId);
  if (!existing) {
    return;
  }

  existing.status = status;
}

function updateExportJobProgress(jobId: string, progress: ExportProgress): void {
  setExportJobStatus(jobId, {
    kind: "working",
    progressPercent: progress.progressPercent,
    stage: progress.stage,
    message: progress.message,
    outputPath: null,
  });
}

function updateSanitizedCopyJobProgress(
  jobId: string,
  progressPercent: number,
  stage: string,
  message: string,
): void {
  setSanitizedCopyJobStatus(jobId, {
    kind: "working",
    progressPercent,
    stage,
    message,
    outputPath: null,
  });
}

function wasExportCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "ExportCancelledError";
}

async function canReadDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) {
      return false;
    }

    await fs.access(directoryPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findNearestExistingDirectory(targetPath: string): Promise<string | null> {
  let currentPath = path.resolve(targetPath);

  while (true) {
    try {
      const stat = await fs.stat(currentPath);
      return stat.isDirectory() ? currentPath : path.dirname(currentPath);
    } catch {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return null;
      }
      currentPath = parentPath;
    }
  }
}

async function canWriteDirectoryOrParent(directoryPath: string): Promise<boolean> {
  const candidate = await findNearestExistingDirectory(directoryPath);
  if (!candidate) {
    return false;
  }

  try {
    await fs.access(candidate, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isCommandAvailable(file: string, args: string[] = ["--version"]): boolean {
  const result = childProcess.spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

async function getEnvironmentCapabilities(
  codexHome: string | null,
): Promise<EnvironmentCapabilities> {
  const resolvedCodexHome = resolveCodexHomePath(codexHome);
  const codexHomeReadable = await canReadDirectory(resolvedCodexHome);
  const codexHomeWritable = await canWriteDirectoryOrParent(resolvedCodexHome);
  const gitAvailable = isCommandAvailable("git");
  const ripgrepAvailable = isCommandAvailable("rg");
  const notes: string[] = [];

  if (!codexHomeReadable) {
    notes.push(
      "Codex home is missing or not readable. Session browsing will stay empty until this path becomes available.",
    );
  }
  if (!codexHomeWritable) {
    notes.push("Codex home is not writable. Re-add session to current day is unavailable.");
  }
  if (!gitAvailable) {
    notes.push("git is not available. Repo-root detection falls back to walking parent folders.");
  }
  if (!ripgrepAvailable) {
    notes.push(
      "rg is not available. Content scans still work, but they fall back to a slower file-by-file search.",
    );
  }

  const overallKind: EnvironmentCapabilities["overallKind"] = !codexHomeReadable
    ? "error"
    : !codexHomeWritable || !gitAvailable || !ripgrepAvailable
      ? "warning"
      : "success";

  const summary =
    overallKind === "success"
      ? "All runtime capabilities are available."
      : overallKind === "error"
        ? "Codex home is not ready for normal session browsing."
        : "Some runtime capabilities are limited, but codlogs can still run.";

  return {
    codexHome: resolvedCodexHome,
    codexHomeReadable,
    codexHomeWritable,
    gitAvailable,
    ripgrepAvailable,
    overallKind,
    summary,
    notes,
  };
}

async function appendSessionIndexThreadName(options: {
  codexHome: string;
  threadId: string;
  threadName: string;
  updatedAt: string;
}): Promise<void> {
  const indexPath = path.join(options.codexHome, "session_index.jsonl");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const line = JSON.stringify({
    id: options.threadId,
    thread_name: options.threadName,
    updated_at: options.updatedAt,
  } satisfies SessionIndexRecord);
  await fs.appendFile(indexPath, `${line}\n`, "utf8");
}

async function renameSessionThreadName(options: {
  codexHome: string | null;
  threadId: string;
  threadName: string;
}): Promise<{ threadName: string }> {
  const resolvedCodexHome = resolveCodexHomePath(options.codexHome);
  const capabilities = await getEnvironmentCapabilities(options.codexHome);
  if (!capabilities.codexHomeWritable) {
    throw new Error("Codex home is not writable. Renaming sessions is unavailable.");
  }

  const normalizedThreadName = normalizeSessionTitle(options.threadName);
  if (!normalizedThreadName) {
    throw new Error("Please enter a session title.");
  }

  await appendSessionIndexThreadName({
    codexHome: resolvedCodexHome,
    threadId: options.threadId,
    threadName: normalizedThreadName,
    updatedAt: new Date().toISOString(),
  });
  return { threadName: normalizedThreadName };
}

function startExportJob(options: {
  format: "markdown" | "html";
  sessionFilePath: string;
  includeImages: boolean;
  inlineImages: boolean;
  includeToolCallResults: boolean;
  outputDirectory: string | null;
  outputPath: string | null;
}): { jobId: string } {
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  exportJobs.set(jobId, {
    controller,
    status: {
      kind: "working",
      progressPercent: 2,
      stage: "reading",
      message: `Preparing ${options.format === "markdown" ? "Markdown" : "HTML"} export...`,
      outputPath: null,
    },
  });

  void (async () => {
    try {
      const outputPath =
        options.format === "markdown"
          ? await exportSessionJsonlToMarkdown(
              options.sessionFilePath,
              {
                includeImages: options.includeImages,
                includeToolCallResults: options.includeToolCallResults,
                outputDirectory: options.outputDirectory,
              },
              {
                signal: controller.signal,
                onProgress: (progress) => updateExportJobProgress(jobId, progress),
              },
            )
          : await exportSessionJsonlToHtml(
              options.sessionFilePath,
              {
                includeImages: options.includeImages,
                inlineImages: options.inlineImages,
                includeToolCallResults: options.includeToolCallResults,
                outputDirectory: options.outputDirectory,
                outputPath: options.outputPath,
              },
              {
                signal: controller.signal,
                onProgress: (progress) => updateExportJobProgress(jobId, progress),
              },
            );
      setExportJobStatus(jobId, {
        kind: "success",
        progressPercent: 100,
        stage: "done",
        message: `${options.format === "markdown" ? "Markdown" : "HTML"} written to ${outputPath}`,
        outputPath,
      });
      Utils.showNotification({
        title: "codlogs export ready",
        body: path.basename(outputPath),
      });
    } catch (error) {
      if (wasExportCancelled(error)) {
        setExportJobStatus(jobId, {
          kind: "cancelled",
          progressPercent: getExportJobStatus(jobId).progressPercent,
          stage: "cancelled",
          message: "Export cancelled.",
          outputPath: null,
        });
      } else {
        setExportJobStatus(jobId, {
          kind: "error",
          progressPercent: getExportJobStatus(jobId).progressPercent,
          stage: "error",
          message: asErrorMessage(error),
          outputPath: null,
        });
        Utils.showNotification({
          title: "codlogs export failed",
          body: path.basename(options.sessionFilePath),
        });
      }
    } finally {
      scheduleExportJobCleanup(jobId);
    }
  })();

  return { jobId };
}

function cancelExportJob(jobId: string): { ok: boolean } {
  const existing = exportJobs.get(jobId);
  if (!existing || existing.status.kind !== "working") {
    return { ok: false };
  }

  existing.controller.abort();
  existing.status = {
    ...existing.status,
    message: "Cancelling export...",
  };
  return { ok: true };
}

async function getSettingsFilePath(): Promise<string> {
  const userDataDirectory = Utils.paths.userData;
  await fs.mkdir(userDataDirectory, { recursive: true });
  return path.join(userDataDirectory, SETTINGS_FILE_NAME);
}

async function readAppSettings(): Promise<AppSettings> {
  if (settingsCache) {
    return settingsCache;
  }

  try {
    const settingsPath = await getSettingsFilePath();
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as AppSettings;
    settingsCache = parsed && typeof parsed === "object" ? parsed : {};
    return settingsCache;
  } catch {
    settingsCache = {};
    return settingsCache;
  }
}

async function writeAppSettings(settings: AppSettings): Promise<void> {
  const settingsPath = await getSettingsFilePath();
  settingsCache = settings;
  settingsWriteQueue = settingsWriteQueue.then(() =>
    fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8"),
  );
  await settingsWriteQueue;
}

async function updateAppSettings(
  updater: (settings: AppSettings) => AppSettings | void,
): Promise<AppSettings> {
  const currentSettings = await readAppSettings();
  const nextSettings = { ...currentSettings };
  const updatedSettings = updater(nextSettings) ?? nextSettings;
  await writeAppSettings(updatedSettings);
  return updatedSettings;
}

async function getRememberedExportDirectory(): Promise<string | null> {
  const settings = await readAppSettings();
  return typeof settings.exportDirectory === "string"
    ? normalizeDialogResult(settings.exportDirectory)
    : null;
}

async function rememberExportDirectory(exportDirectory: string): Promise<void> {
  await updateAppSettings((settings) => {
    settings.exportDirectory = exportDirectory;
  });
}

function htmlExportNeedsAssetDirectory(options: {
  includeImages: boolean;
  inlineImages: boolean;
}): boolean {
  return options.includeImages && !options.inlineImages;
}

function runDialogProcess(
  file: string,
  args: string[],
): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
  });
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function pickSaveFilePathOnWindows(options: {
  startingFolder: string;
  suggestedFileName: string;
}): string | null {
  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.InitialDirectory = '${escapePowerShellString(options.startingFolder)}'
$dialog.FileName = '${escapePowerShellString(options.suggestedFileName)}'
$dialog.Filter = 'HTML files (*.html)|*.html|All files (*.*)|*.*'
$dialog.DefaultExt = 'html'
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.FileName
}
`.trim();
  const result = runDialogProcess("powershell", ["-NoProfile", "-STA", "-Command", script]);
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? "Could not open the Windows save dialog.");
  }

  return normalizeDialogResult(`${result.stdout ?? ""}`);
}

function pickSaveFilePathOnDarwin(options: {
  startingFolder: string;
  suggestedFileName: string;
}): string | null {
  const args = [
    "-e",
    `set defaultLocation to POSIX file "${escapeAppleScriptString(options.startingFolder)}"`,
    "-e",
    `set pickedFile to choose file name with prompt "Save HTML export as" default location defaultLocation default name "${escapeAppleScriptString(options.suggestedFileName)}"`,
    "-e",
    "POSIX path of pickedFile",
  ];
  const result = runDialogProcess("osascript", args);
  if (result.status === 1 && `${result.stderr ?? ""}`.includes("-128")) {
    return null;
  }
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? "Could not open the macOS save dialog.");
  }

  return normalizeDialogResult(`${result.stdout ?? ""}`);
}

function pickSaveFilePathOnLinux(options: {
  startingFolder: string;
  suggestedFileName: string;
}): string | null {
  const defaultPath = path.join(options.startingFolder, options.suggestedFileName);
  const zenityResult = runDialogProcess("zenity", [
    "--file-selection",
    "--save",
    "--confirm-overwrite",
    "--filename",
    defaultPath,
    "--file-filter=*.html",
  ]);
  if (!zenityResult.error && zenityResult.status === 0) {
    return normalizeDialogResult(`${zenityResult.stdout ?? ""}`);
  }
  if (!zenityResult.error && zenityResult.status === 1) {
    return null;
  }

  const kdialogResult = runDialogProcess("kdialog", [
    "--getsavefilename",
    defaultPath,
    "*.html | HTML files",
  ]);
  if (!kdialogResult.error && kdialogResult.status === 0) {
    return normalizeDialogResult(`${kdialogResult.stdout ?? ""}`);
  }
  if (!kdialogResult.error && kdialogResult.status === 1) {
    return null;
  }

  throw new Error(
    "Could not open a Linux save dialog. Install zenity or kdialog, or export with sidecar assets.",
  );
}

async function pickSaveFilePath(options: {
  sessionFilePath: string;
  startingFolder: string;
}): Promise<string | null> {
  const dialogOptions = {
    startingFolder: options.startingFolder,
    suggestedFileName: getSuggestedExportFileName(options.sessionFilePath, "html"),
  };

  switch (process.platform) {
    case "win32":
      return pickSaveFilePathOnWindows(dialogOptions);
    case "darwin":
      return pickSaveFilePathOnDarwin(dialogOptions);
    case "linux":
      return pickSaveFilePathOnLinux(dialogOptions);
    default:
      throw new Error(`Save dialogs are not supported on ${process.platform}.`);
  }
}

async function getRememberedOpenedFolder(): Promise<string | null> {
  const settings = await readAppSettings();
  return typeof settings.lastOpenedFolder === "string"
    ? normalizeDialogResult(settings.lastOpenedFolder)
    : null;
}

async function rememberOpenedFolder(folderPath: string): Promise<void> {
  await updateAppSettings((settings) => {
    settings.lastOpenedFolder = folderPath;
  });
  currentWorkingDirectoryPreference = folderPath;
}

function normalizeWindowFrame(
  value: AppSettings["windowFrame"] | undefined,
): typeof DEFAULT_WINDOW_FRAME {
  if (!value) {
    return DEFAULT_WINDOW_FRAME;
  }

  const { x, y, width, height } = value;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 640 ||
    height < 480
  ) {
    return DEFAULT_WINDOW_FRAME;
  }

  return {
    x,
    y,
    width,
    height,
  };
}

function scheduleSanitizedCopyJobCleanup(jobId: string): void {
  setTimeout(() => {
    sanitizedCopyJobs.delete(jobId);
  }, EXPORT_JOB_RETENTION_MS);
}

function cancelSanitizedCopyJob(jobId: string): { ok: boolean } {
  const existing = sanitizedCopyJobs.get(jobId);
  if (!existing || existing.status.kind !== "working") {
    return { ok: false };
  }

  existing.controller.abort();
  existing.status = {
    ...existing.status,
    message: "Cancelling text-only copy...",
  };
  return { ok: true };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const cancellationError = new Error("The operation was cancelled.");
    cancellationError.name = "ExportCancelledError";
    throw cancellationError;
  }
}

async function extractSessionMetaAndCompactionCount(
  sessionFilePath: string,
  signal: AbortSignal | undefined,
  onProgress: (progressPercent: number, message: string) => void,
): Promise<{
  sessionMetaLine: string;
  compactionCount: number;
}> {
  const sessionStat = await fs.stat(sessionFilePath);
  const lineReader = readline.createInterface({
    input: createReadStream(sessionFilePath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let sessionMetaLine = "";
  let lineNumber = 0;
  let bytesProcessed = 0;
  let lastProgressPercent = -1;
  let compactionCount = 0;
  for await (const line of lineReader) {
    throwIfAborted(signal);

    lineNumber += 1;
    bytesProcessed += Buffer.byteLength(line, "utf8") + 1;

    if (lineNumber === 1) {
      sessionMetaLine = line;
    } else {
      const encryptedContent = extractCompactionEncryptedContentFromJsonlLine(line);
      if (encryptedContent) {
        compactionCount += 1;
      }
    }

    const progressPercent =
      sessionStat.size > 0
        ? Math.min(34, 10 + Math.floor((bytesProcessed / sessionStat.size) * 24))
        : 34;
    if (progressPercent > lastProgressPercent) {
      lastProgressPercent = progressPercent;
      onProgress(
        progressPercent,
        compactionCount > 0
          ? `Scanned ${compactionCount} compaction row${compactionCount === 1 ? "" : "s"}...`
          : "Scanning JSONL structure...",
      );
    }
  }

  if (!sessionMetaLine) {
    throw new Error(`No session_meta record found in ${sessionFilePath}`);
  }

  return {
    sessionMetaLine,
    compactionCount,
  };
}

function buildSanitizedSessionMetaRecord(options: {
  sessionMetaLine: string;
  originalSessionPath: string;
  sanitizedSessionId: string;
  sanitizedOutputPath: string | null;
  readdedSessionPath: string | null;
  generatedAt: string;
  compactionCount: number;
  reconstructionStats: SanitizedSessionStats | null;
  chatName: string | null;
  stripImageContent: boolean;
  stripBlobContent: boolean;
  createJsonlCopy: boolean;
  reAddToCurrentDay: boolean;
}): SessionMetaRecord {
  let parsed = JSON.parse(options.sessionMetaLine) as SessionMetaRecord;
  if (parsed.type !== "session_meta" || !parsed.payload) {
    throw new Error("The session file does not start with a valid session_meta record.");
  }

  return {
    ...parsed,
    payload: {
      ...parsed.payload,
      id: options.sanitizedSessionId,
      source: "codlogs_sanitized_copy",
      codlogs_sanitized_copy: {
        generated_at: options.generatedAt,
        original_session_path: options.originalSessionPath,
        sanitized_output_path: options.sanitizedOutputPath,
        readded_session_path: options.readdedSessionPath,
        strip_image_content: options.stripImageContent,
        strip_blob_content: options.stripBlobContent,
        create_jsonl_copy: options.createJsonlCopy,
        re_add_to_current_day: options.reAddToCurrentDay,
        extracted_compaction_count: options.compactionCount,
        dropped_input_image_count: options.reconstructionStats?.droppedInputImageCount ?? 0,
        dropped_local_image_count: options.reconstructionStats?.droppedLocalImageCount ?? 0,
        omitted_thread_item_counts: options.reconstructionStats?.omittedThreadItemCounts ?? {},
        preserved_command_execution_count:
          options.reconstructionStats?.preservedCommandExecutionCount ?? 0,
        preserved_reasoning_count: options.reconstructionStats?.preservedReasoningCount ?? 0,
        reconstructed_message_count: options.reconstructionStats?.reconstructedMessageCount ?? 0,
      },
    },
  };
}

async function writeSanitizedSessionJsonl(options: {
  inputPath: string;
  outputPath: string;
  sessionMetaRecord: SessionMetaRecord;
  stripImageContent: boolean;
  stripBlobContent: boolean;
  stats?: SanitizedSessionStats;
  signal: AbortSignal | undefined;
  onProgress: (progressPercent: number, message: string) => void;
}): Promise<void> {
  const fileHandle = await fs.open(options.outputPath, "w");
  const inputStat = await fs.stat(options.inputPath);
  const lineReader = readline.createInterface({
    input: createReadStream(options.inputPath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  let bytesProcessed = 0;

  try {
    for await (const line of lineReader) {
      throwIfAborted(options.signal);
      lineNumber += 1;
      bytesProcessed += Buffer.byteLength(line, "utf8") + 1;

      if (lineNumber === 1) {
        await fileHandle.writeFile(`${JSON.stringify(options.sessionMetaRecord)}\n`, "utf8");
      } else {
        const sanitizedCompactedLine = sanitizeCompactedRolloutLine(line, {
          keepImagePlaceholders: options.stripImageContent,
          stripBlobContent: options.stripBlobContent,
          stats: options.stats,
        });
        if (sanitizedCompactedLine !== null) {
          await fileHandle.writeFile(`${sanitizedCompactedLine}\n`, "utf8");
        } else {
          const sanitizedTurnContextLine = sanitizeTurnContextJsonlLine(line, {
            stripBlobContent: options.stripBlobContent,
          });
          if (sanitizedTurnContextLine !== null) {
            await fileHandle.writeFile(`${sanitizedTurnContextLine}\n`, "utf8");
          } else {
            const sanitizedEventMsgLine = sanitizeEventMsgJsonlLine(line, {
              keepImagePlaceholders: options.stripImageContent,
              stripBlobContent: options.stripBlobContent,
              stats: options.stats,
            });
            if (sanitizedEventMsgLine !== null) {
              await fileHandle.writeFile(`${sanitizedEventMsgLine}\n`, "utf8");
            } else {
              const sanitizedResponseItemLine = sanitizeResponseItemJsonlLine(line, {
                keepImagePlaceholders: options.stripImageContent,
                stripBlobContent: options.stripBlobContent,
                stats: options.stats,
              });
              await fileHandle.writeFile(`${sanitizedResponseItemLine ?? line}\n`, "utf8");
            }
          }
        }
      }

      if (lineNumber % 25 === 0 || bytesProcessed >= inputStat.size) {
        const progressPercent =
          inputStat.size > 0
            ? 70 + Math.floor((bytesProcessed / inputStat.size) * 25)
            : 95;
        options.onProgress(
          Math.min(95, progressPercent),
          "Writing sanitized JSONL in original line order...",
        );
      }
    }
  } finally {
    lineReader.close();
    await fileHandle.close();
  }
}

async function createSanitizedSessionOutputDirectory(
  sessionFilePath: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeStem = path
    .parse(sessionFilePath)
    .name.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  const root = path.join(os.tmpdir(), "codlogs", "sanitized-sessions");
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, `${safeStem || "session"}-${timestamp}-`));
}

async function createSanitizedSessionCopy(
  sessionFilePath: string,
  options: {
    signal: AbortSignal;
    codexHome: string | null;
    chatName: string | null;
    stripImageContent: boolean;
    stripBlobContent: boolean;
    createJsonlCopy: boolean;
    reAddToCurrentDay: boolean;
    onProgress: (progressPercent: number, stage: string, message: string) => void;
  },
): Promise<{ primaryOutputPath: string; tempOutputDirectory: string }> {
  const outputDirectory = await createSanitizedSessionOutputDirectory(sessionFilePath);
  const sanitizedSessionPath = path.join(outputDirectory, "sanitized-session.jsonl");
  const reportPath = path.join(outputDirectory, "sanitization-report.json");
  const currentRunDate = new Date();
  const generatedAt = currentRunDate.toISOString();
  const sanitizedSessionId = generateUuidV7String(currentRunDate);
  const normalizedChatName = normalizeSessionTitle(options.chatName);
  const resolvedCodexHome = resolveCodexHomePath(options.codexHome);
  const readdedSessionPath = options.reAddToCurrentDay
    ? buildCodexCurrentDayRolloutPath(resolvedCodexHome, sanitizedSessionId, currentRunDate)
    : null;

  if (options.reAddToCurrentDay) {
    const capabilities = await getEnvironmentCapabilities(options.codexHome);
    if (!capabilities.codexHomeWritable) {
      throw new Error("Codex home is not writable. Re-add session to current day is unavailable.");
    }
    if (!normalizedChatName) {
      throw new Error("Please enter a chat name for the re-added session.");
    }
  }

  options.onProgress(6, "reading", "Preparing temporary output folder...");
  const { sessionMetaLine, compactionCount } = await extractSessionMetaAndCompactionCount(
    sessionFilePath,
    options.signal,
    (progressPercent: number, message: string) =>
      options.onProgress(progressPercent, "scanning", message),
  );

  let directSanitizationStats: SanitizedSessionStats | null = null;
  let writtenSanitizedSessionPath: string | null = null;
  let writtenReaddedSessionPath: string | null = null;
  let sessionMetaRecord: SessionMetaRecord | null = null;

  if (options.createJsonlCopy || options.reAddToCurrentDay) {
    directSanitizationStats = {
      droppedInputImageCount: 0,
      droppedLocalImageCount: 0,
      omittedThreadItemCounts: {},
      preservedCommandExecutionCount: 0,
      preservedReasoningCount: 0,
      reconstructedMessageCount: 0,
    };

    sessionMetaRecord = buildSanitizedSessionMetaRecord({
      sessionMetaLine,
      originalSessionPath: sessionFilePath,
      sanitizedSessionId,
      sanitizedOutputPath: options.createJsonlCopy ? sanitizedSessionPath : null,
      readdedSessionPath,
      generatedAt,
      compactionCount,
      reconstructionStats: directSanitizationStats,
      chatName: normalizedChatName,
      stripImageContent: options.stripImageContent,
      stripBlobContent: options.stripBlobContent,
      createJsonlCopy: options.createJsonlCopy,
      reAddToCurrentDay: options.reAddToCurrentDay,
    });
  }

  if (options.createJsonlCopy && sessionMetaRecord && directSanitizationStats) {
    options.onProgress(66, "writing", "Writing sanitized JSONL copy...");
    await writeSanitizedSessionJsonl({
      inputPath: sessionFilePath,
      outputPath: sanitizedSessionPath,
      sessionMetaRecord,
      stripImageContent: options.stripImageContent,
      stripBlobContent: options.stripBlobContent,
      stats: directSanitizationStats,
      signal: options.signal,
      onProgress: (progressPercent, message) =>
        options.onProgress(progressPercent, "writing", message),
    });
    writtenSanitizedSessionPath = sanitizedSessionPath;
  }

  if (
    options.reAddToCurrentDay &&
    readdedSessionPath &&
    sessionMetaRecord &&
    directSanitizationStats
  ) {
    options.onProgress(90, "writing", "Writing canonical Codex session copy...");
    await fs.mkdir(path.dirname(readdedSessionPath), { recursive: true });
    await writeSanitizedSessionJsonl({
      inputPath: sessionFilePath,
      outputPath: readdedSessionPath,
      sessionMetaRecord,
      stripImageContent: options.stripImageContent,
      stripBlobContent: options.stripBlobContent,
      stats: options.createJsonlCopy ? undefined : directSanitizationStats,
      signal: options.signal,
      onProgress: (progressPercent, message) =>
        options.onProgress(Math.max(90, progressPercent), "writing", message),
    });
    writtenReaddedSessionPath = readdedSessionPath;
    if (normalizedChatName) {
      await appendSessionIndexThreadName({
        codexHome: resolvedCodexHome,
        threadId: sanitizedSessionId,
        threadName: normalizedChatName,
        updatedAt: generatedAt,
      });
    }
  }

  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt,
        originalSessionPath: sessionFilePath,
        sanitizedSessionPath: writtenSanitizedSessionPath,
        readdedSessionPath: writtenReaddedSessionPath,
        sanitizedSessionId,
        chatName: normalizedChatName,
        options: {
          codexHome: resolvedCodexHome,
          stripImageContent: options.stripImageContent,
          stripBlobContent: options.stripBlobContent,
          createJsonlCopy: options.createJsonlCopy,
          reAddToCurrentDay: options.reAddToCurrentDay,
        },
        compactionCount,
        reconstructionStats: directSanitizationStats,
        note:
          "This copy preserves the original JSONL line order, keeps opaque compaction rows, sanitizes image-bearing response content plus compacted replacement history, and can optionally strip oversized tool or metadata blobs. When re-adding to the current day, codlogs writes a canonical rollout file with a fresh UUIDv7 thread ID in both the filename and session metadata.",
      },
      null,
      2,
    ),
    "utf8",
  );

  options.onProgress(
    100,
    "done",
    writtenReaddedSessionPath
      ? "Sanitized session copy is ready and was re-added to today's Codex sessions."
      : "Sanitized session copy is ready.",
  );
  return {
    primaryOutputPath: writtenReaddedSessionPath ?? outputDirectory,
    tempOutputDirectory: outputDirectory,
  };
}

function startSanitizedCopyJob(options: {
  sessionFilePath: string;
  codexHome: string | null;
  chatName: string | null;
  stripImageContent: boolean;
  stripBlobContent: boolean;
  createJsonlCopy: boolean;
  reAddToCurrentDay: boolean;
}): { jobId: string } {
  const jobId = crypto.randomUUID();
  const controller = new AbortController();
  sanitizedCopyJobs.set(jobId, {
    controller,
    status: {
      kind: "working",
      progressPercent: 2,
      stage: "reading",
      message: "Preparing sanitized session output...",
      outputPath: null,
    },
  });

  void (async () => {
    try {
      const output = await createSanitizedSessionCopy(options.sessionFilePath, {
        signal: controller.signal,
        codexHome: options.codexHome,
        chatName: options.chatName,
        stripImageContent: options.stripImageContent,
        stripBlobContent: options.stripBlobContent,
        createJsonlCopy: options.createJsonlCopy,
        reAddToCurrentDay: options.reAddToCurrentDay,
        onProgress: (progressPercent, stage, message) =>
          updateSanitizedCopyJobProgress(jobId, progressPercent, stage, message),
      });
      setSanitizedCopyJobStatus(jobId, {
        kind: "success",
        progressPercent: 100,
        stage: "done",
        message: options.reAddToCurrentDay
          ? `Sanitized session output written into ${output.tempOutputDirectory} and re-added as ${path.basename(output.primaryOutputPath)}`
          : `Sanitized session output written into ${output.tempOutputDirectory}`,
        outputPath: output.primaryOutputPath,
      });
      Utils.showNotification({
        title: "codlogs sanitized output ready",
        body: path.basename(output.primaryOutputPath),
      });
    } catch (error) {
      if (wasExportCancelled(error)) {
        setSanitizedCopyJobStatus(jobId, {
          kind: "cancelled",
          progressPercent: getSanitizedCopyJobStatus(jobId).progressPercent,
          stage: "cancelled",
          message: "Sanitized session job cancelled.",
          outputPath: null,
        });
      } else {
        setSanitizedCopyJobStatus(jobId, {
          kind: "error",
          progressPercent: getSanitizedCopyJobStatus(jobId).progressPercent,
          stage: "error",
          message: asErrorMessage(error),
          outputPath: null,
        });
        Utils.showNotification({
          title: "codlogs sanitization failed",
          body: path.basename(options.sessionFilePath),
        });
      }
    } finally {
      scheduleSanitizedCopyJobCleanup(jobId);
    }
  })();

  return { jobId };
}

async function getRememberedWindowFrame(): Promise<typeof DEFAULT_WINDOW_FRAME> {
  const settings = await readAppSettings();
  return normalizeWindowFrame(settings.windowFrame);
}

async function rememberWindowFrame(window: BrowserWindow<any>): Promise<void> {
  if (window.isMinimized() || window.isMaximized() || window.isFullScreen()) {
    return;
  }

  const frame = window.getFrame();
  await updateAppSettings((settings) => {
    settings.windowFrame = {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    };
  });
}

function setupWindowFramePersistence(window: BrowserWindow<any>): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    saveTimer = setTimeout(() => {
      saveTimer = null;
      void rememberWindowFrame(window);
    }, 150);
  };

  window.on("move", scheduleSave);
  window.on("resize", scheduleSave);
  window.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    void rememberWindowFrame(window);
  });
}

function refreshWindowLayout(window: BrowserWindow<any>): { ok: boolean } {
  if (window.isMinimized() || window.isMaximized() || window.isFullScreen()) {
    return { ok: false };
  }

  const frame = window.getFrame();
  const bounceHeight = Math.max(frame.height + 1, frame.height);

  window.setFrame(frame.x, frame.y, frame.width, bounceHeight);
  setTimeout(() => {
    window.setFrame(frame.x, frame.y, frame.width, frame.height);
  }, 16);

  return { ok: true };
}

let mainWindow: BrowserWindow<any>;
const rememberedOpenedFolder = await getRememberedOpenedFolder();
let currentWorkingDirectoryPreference =
  rememberedOpenedFolder ?? getAppWorkingDirectory();

const rpc = BrowserView.defineRPC<CodexerRPC>({
  maxRequestTime: RPC_MAX_REQUEST_TIME_MS,
  handlers: {
    requests: {
      loadSessions: async ({
        codexHome,
        targetDirectory,
        cwdOnly,
        includeCrossSessionWrites,
      }) =>
        findCodexSessions({
          codexHome,
          targetDirectory,
          cwdOnly,
          includeCrossSessionWrites,
          currentWorkingDirectory: currentWorkingDirectoryPreference,
        }).then(async (result) => {
          if (result.requestedDirectory) {
            await rememberOpenedFolder(result.requestedDirectory);
          }

          return result;
        }),
      pickDirectory: async ({ startingFolder }) => {
        const [chosenPath] = await Utils.openFileDialog({
          startingFolder: getStartingFolder(startingFolder ?? currentWorkingDirectoryPreference),
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });

        return {
          path: normalizeDialogResult(chosenPath),
        };
      },
      pickExportDirectory: async ({ sessionFilePath }) => {
        const rememberedDirectory = await getRememberedExportDirectory();
        const [chosenPath] = await Utils.openFileDialog({
          startingFolder:
            rememberedDirectory ??
            path.dirname(sessionFilePath) ??
            getAppWorkingDirectory(),
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });

        const selectedPath = normalizeDialogResult(chosenPath);
        if (selectedPath) {
          await rememberExportDirectory(selectedPath);
        }

        return {
          path: selectedPath,
        };
      },
      pickHtmlExportDestination: async ({
        sessionFilePath,
        includeImages,
        inlineImages,
      }) => {
        const rememberedDirectory = await getRememberedExportDirectory();
        const startingFolder =
          rememberedDirectory ?? path.dirname(sessionFilePath) ?? getAppWorkingDirectory();
        const selectionKind = htmlExportNeedsAssetDirectory({
          includeImages,
          inlineImages,
        })
          ? "directory"
          : "file";

        const selectedPath =
          selectionKind === "directory"
            ? normalizeDialogResult(
                (
                  await Utils.openFileDialog({
                    startingFolder,
                    canChooseFiles: false,
                    canChooseDirectory: true,
                    allowsMultipleSelection: false,
                  })
                )[0],
              )
            : await pickSaveFilePath({
                sessionFilePath,
                startingFolder,
              });

        if (selectedPath) {
          await rememberExportDirectory(
            selectionKind === "directory" ? selectedPath : path.dirname(selectedPath),
          );
        }

        return {
          path: selectedPath,
          selectionKind,
        };
      },
      getSessionDetailMetrics: async ({ sessionFilePath, forceDeepAnalysis }) =>
        getSessionDetailMetrics(sessionFilePath, {
          forceDeepAnalysis,
        }),
      getEnvironmentCapabilities: async ({ codexHome }) =>
        getEnvironmentCapabilities(codexHome),
      renameSessionThreadName: async ({ codexHome, threadId, threadName }) =>
        renameSessionThreadName({
          codexHome,
          threadId,
          threadName,
        }),
      startSessionMarkdownExport: async ({
        sessionFilePath,
        includeImages,
        includeToolCallResults,
        outputDirectory,
      }) =>
        startExportJob({
          format: "markdown",
          sessionFilePath,
          includeImages,
          inlineImages: false,
          includeToolCallResults,
          outputDirectory,
          outputPath: null,
        }),
      exportSessionMarkdown: async ({
        sessionFilePath,
        includeImages,
        includeToolCallResults,
        outputDirectory,
      }) => {
        const outputPath = await exportSessionJsonlToMarkdown(sessionFilePath, {
          includeImages,
          includeToolCallResults,
          outputDirectory,
        });
        Utils.showNotification({
          title: "codlogs export ready",
          body: path.basename(outputPath),
        });
        return { outputPath };
      },
      startSessionHtmlExport: async ({
        sessionFilePath,
        includeImages,
        inlineImages,
        includeToolCallResults,
        outputDirectory,
        outputPath,
      }) =>
        startExportJob({
          format: "html",
          sessionFilePath,
          includeImages,
          inlineImages,
          includeToolCallResults,
          outputDirectory,
          outputPath,
        }),
      startSessionSanitizedCopy: async ({
        sessionFilePath,
        codexHome,
        chatName,
        stripImageContent,
        stripBlobContent,
        createJsonlCopy,
        reAddToCurrentDay,
      }) =>
        startSanitizedCopyJob({
          sessionFilePath,
          codexHome,
          chatName,
          stripImageContent,
          stripBlobContent,
          createJsonlCopy,
          reAddToCurrentDay,
        }),
      getExportJobStatus: async ({ jobId }) => getExportJobStatus(jobId),
      getSanitizedCopyJobStatus: async ({ jobId }) => getSanitizedCopyJobStatus(jobId),
      cancelExportJob: async ({ jobId }) => cancelExportJob(jobId),
      cancelSanitizedCopyJob: async ({ jobId }) => cancelSanitizedCopyJob(jobId),
      revealPath: ({ path: targetPath }) => {
        Utils.showItemInFolder(targetPath);
        return { ok: true };
      },
      openPath: ({ path: targetPath }) => ({
        ok: Utils.openPath(targetPath),
      }),
      refreshWindowLayout: () => refreshWindowLayout(mainWindow),
    },
    messages: {},
  },
});

const url = await getMainViewUrl();
const initialFrame = await getRememberedWindowFrame();

mainWindow = new BrowserWindow({
  title: "codlogs",
  url,
  rpc,
  frame: initialFrame,
});

setupWindowFramePersistence(mainWindow);

mainWindow.webview.on("dom-ready", () => {
  console.log("codlogs mainview ready");
});

console.log(`codlogs started with ${url}`);
