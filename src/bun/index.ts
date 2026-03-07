import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import {
  type ExportProgress,
  exportSessionJsonlToMarkdown,
  exportSessionJsonlToHtml,
  findCodexSessions,
  getSessionDetailMetrics,
} from "../shared/codlogs-core.ts";
import type { CodexerRPC } from "../shared/rpc.ts";

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

const EXPORT_JOB_RETENTION_MS = 5 * 60 * 1000;
const exportJobs = new Map<string, ExportJobRecord>();
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

function getExportJobStatus(jobId: string): ExportJobStatus {
  return exportJobs.get(jobId)?.status ?? getMissingExportJobStatus();
}

function setExportJobStatus(jobId: string, status: ExportJobStatus): void {
  const existing = exportJobs.get(jobId);
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

function wasExportCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "ExportCancelledError";
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
      getSessionDetailMetrics: async ({ sessionFilePath }) =>
        getSessionDetailMetrics(sessionFilePath),
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
      getExportJobStatus: async ({ jobId }) => getExportJobStatus(jobId),
      cancelExportJob: async ({ jobId }) => cancelExportJob(jobId),
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
