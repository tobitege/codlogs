import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import {
  exportSessionJsonlToMarkdown,
  exportSessionJsonlToHtml,
  findCodexSessions,
} from "../shared/codex-core.ts";
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

type AppSettings = {
  exportDirectory?: string | null;
};

type ExportJobStatus = {
  kind: "working" | "success" | "error";
  message: string;
  outputPath: string | null;
};

const EXPORT_JOB_RETENTION_MS = 5 * 60 * 1000;
const exportJobs = new Map<string, ExportJobStatus>();

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
    message: "The export job is no longer available.",
    outputPath: null,
  };
}

function startHtmlExportJob(options: {
  sessionFilePath: string;
  includeImages: boolean;
  includeToolCallResults: boolean;
  outputDirectory: string | null;
}): { jobId: string } {
  const jobId = crypto.randomUUID();
  exportJobs.set(jobId, {
    kind: "working",
    message: "Creating HTML export...",
    outputPath: null,
  });

  void (async () => {
    try {
      const outputPath = await exportSessionJsonlToHtml(options.sessionFilePath, {
        includeImages: options.includeImages,
        includeToolCallResults: options.includeToolCallResults,
        outputDirectory: options.outputDirectory,
      });
      exportJobs.set(jobId, {
        kind: "success",
        message: `HTML written to ${outputPath}`,
        outputPath,
      });
      Utils.showNotification({
        title: "codlogs export ready",
        body: path.basename(outputPath),
      });
    } catch (error) {
      exportJobs.set(jobId, {
        kind: "error",
        message: asErrorMessage(error),
        outputPath: null,
      });
      Utils.showNotification({
        title: "codlogs export failed",
        body: path.basename(options.sessionFilePath),
      });
    } finally {
      scheduleExportJobCleanup(jobId);
    }
  })();

  return { jobId };
}

async function getSettingsFilePath(): Promise<string> {
  const userDataDirectory = Utils.paths.userData;
  await fs.mkdir(userDataDirectory, { recursive: true });
  return path.join(userDataDirectory, SETTINGS_FILE_NAME);
}

async function readAppSettings(): Promise<AppSettings> {
  try {
    const settingsPath = await getSettingsFilePath();
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as AppSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAppSettings(settings: AppSettings): Promise<void> {
  const settingsPath = await getSettingsFilePath();
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

async function getRememberedExportDirectory(): Promise<string | null> {
  const settings = await readAppSettings();
  return typeof settings.exportDirectory === "string"
    ? normalizeDialogResult(settings.exportDirectory)
    : null;
}

async function rememberExportDirectory(exportDirectory: string): Promise<void> {
  const settings = await readAppSettings();
  settings.exportDirectory = exportDirectory;
  await writeAppSettings(settings);
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

const rpc = BrowserView.defineRPC<CodexerRPC>({
  maxRequestTime: RPC_MAX_REQUEST_TIME_MS,
  handlers: {
    requests: {
      loadSessions: async ({ codexHome, targetDirectory, cwdOnly }) =>
        findCodexSessions({
          codexHome,
          targetDirectory,
          cwdOnly,
          currentWorkingDirectory: getAppWorkingDirectory(),
        }),
      pickDirectory: async ({ startingFolder }) => {
        const [chosenPath] = await Utils.openFileDialog({
          startingFolder: getStartingFolder(startingFolder),
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
        includeToolCallResults,
        outputDirectory,
      }) =>
        startHtmlExportJob({
          sessionFilePath,
          includeImages,
          includeToolCallResults,
          outputDirectory,
        }),
      getExportJobStatus: async ({ jobId }) =>
        exportJobs.get(jobId) ?? getMissingExportJobStatus(),
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

mainWindow = new BrowserWindow({
  title: "codlogs",
  url,
  rpc,
  frame: {
    width: 1600,
    height: 1000,
    x: 100,
    y: 60,
  },
});

mainWindow.webview.on("dom-ready", () => {
  console.log("codlogs mainview ready");
});

console.log(`codlogs started with ${url}`);
