import { Electroview } from "electrobun/view";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  FindCodexSessionsResult,
  SessionDetailMetrics,
  SessionMetaMatch,
} from "../shared/codlogs-core.ts";
import type { CodexerRPC, EnvironmentCapabilities } from "../shared/rpc.ts";
import { sanitizeSessionTitleInput } from "../shared/session-title.ts";

type BrowseMode = "all" | "folder";

type AppliedQuery = {
  browseMode: BrowseMode;
  targetDirectory: string | null;
  cwdOnly: boolean;
  includeCrossSessionWrites: boolean;
};

type ExportState = {
  kind: "idle" | "working" | "success" | "error" | "cancelled";
  progressPercent: number;
  stage: string;
  message: string;
  outputPath: string | null;
};

type SanitizedCopyState = {
  kind: "idle" | "working" | "success" | "error" | "cancelled";
  progressPercent: number;
  stage: string;
  message: string;
  outputPath: string | null;
};

type ExportFormat = "markdown" | "html";

type ExportDialogState = {
  format: ExportFormat;
};

type SanitizedCopyDialogState = {
  chatName: string;
  stripImageContent: boolean;
  stripBlobContent: boolean;
  createJsonlCopy: boolean;
  reAddToCurrentDay: boolean;
};

type RenameDialogState = {
  sessionId: string;
  sessionLabel: string;
  title: string;
};

type SessionDetailMetricsState = {
  kind: "idle" | "loading" | "ready" | "error";
  metrics: SessionDetailMetrics | null;
  errorMessage: string | null;
};

type EnvironmentCapabilitiesState = {
  kind: "idle" | "loading" | "ready" | "error";
  capabilities: EnvironmentCapabilities | null;
  errorMessage: string | null;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const LARGE_SESSION_WARNING_BYTES = 64 * 1024 * 1024;
const RPC_MAX_REQUEST_TIME_MS = 15 * 60 * 1000;
const REPOSITORY_URL = "https://github.com/tobitege/codlogs";

const rpc = Electroview.defineRPC<CodexerRPC>({
  maxRequestTime: RPC_MAX_REQUEST_TIME_MS,
  handlers: {
    requests: {},
    messages: {},
  },
});

const electroview = new Electroview({ rpc });

function describeScope(
  result: FindCodexSessionsResult | null,
  browseMode: BrowseMode,
): string {
  if (!result) {
    return "Loading";
  }

  if (browseMode === "all" || result.scopeMode === "all") {
    return "All sessions";
  }

  return result.scopeMode === "repo" ? "Repo root" : "Folder tree";
}

function getSessionTitle(session: SessionMetaMatch): string {
  const threadName = session.threadName?.trim();
  if (threadName) {
    return threadName;
  }

  return formatDisplayFileName(basename(session.file)).replace(/\.jsonl$/i, "");
}

function sanitizeSessionTitleDraft(value: string | null | undefined): string {
  return sanitizeSessionTitleInput(value);
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function truncateGuidText(value: string): string {
  return value
    .replace(
      /\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b/g,
      (guid) => `${guid.slice(0, 10)}...`,
    )
    .replace(/\b([0-9a-fA-F]{10})[0-9a-fA-F]{8,}\b/g, "$1...");
}

function formatDisplayFileName(fileName: string): string {
  const extensionMatch = fileName.match(/(\.[^.]+)$/);
  const extension = extensionMatch?.[1] ?? "";
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${truncateGuidText(stem)}${extension}`;
}

function formatDisplayPath(value: string): string {
  const lastSeparatorIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (lastSeparatorIndex < 0) {
    return formatDisplayFileName(value);
  }

  return `${value.slice(0, lastSeparatorIndex + 1)}${formatDisplayFileName(value.slice(lastSeparatorIndex + 1))}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : timestampFormatter.format(parsed);
}

function formatFileSize(value: number | null): string {
  if (value === null) {
    return "Loading...";
  }

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

function formatInteractionSummary(
  metricsState: SessionDetailMetricsState,
): string {
  if (metricsState.kind === "error") {
    return "Unavailable";
  }

  if (metricsState.kind === "loading" || metricsState.kind === "idle") {
    return "Loading...";
  }

  const interactionCount = metricsState.metrics?.interactionCount ?? null;
  const toolCallCount = metricsState.metrics?.toolCallCount ?? null;
  if (interactionCount === null || toolCallCount === null) {
    return "Unavailable";
  }

  const promptLabel = `${interactionCount} ${interactionCount === 1 ? "prompt" : "prompts"}`;
  const toolCallLabel = `${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`;
  return metricsState.metrics?.analysisKind === "partial"
    ? `${promptLabel} / ${toolCallLabel} (partial)`
    : `${promptLabel} / ${toolCallLabel}`;
}

function matchesSearch(session: SessionMetaMatch, query: string): boolean {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return true;
  }

  const threadName = session.threadName ?? "";
  const folderName = basename(session.cwd);

  return [
    threadName,
    folderName,
    session.kind,
  ].some((field) => field.toLowerCase().includes(trimmedQuery));
}

function asErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isLargeSession(session: SessionMetaMatch | null): boolean {
  return (session?.fileSizeBytes ?? 0) >= LARGE_SESSION_WARNING_BYTES;
}

function getMetricsFileSize(
  metricsState: SessionDetailMetricsState,
  activeSession: SessionMetaMatch | null,
): number | null {
  return metricsState.metrics?.fileSizeBytes ?? activeSession?.fileSizeBytes ?? null;
}

function getAnalysisBannerCopy(
  metricsState: SessionDetailMetricsState,
  activeSession: SessionMetaMatch | null,
): { kind: "warning" | "notice"; title: string; message: string } | null {
  if (metricsState.kind === "error") {
    return {
      kind: "warning",
      title: "Session analysis unavailable",
      message: metricsState.errorMessage ?? "Could not inspect this session safely.",
    };
  }

  if (metricsState.kind !== "ready" || !metricsState.metrics) {
    return null;
  }

  if (metricsState.metrics.analysisKind === "skipped") {
    return {
      kind: "warning",
      title: "Large session analysis skipped",
      message:
        metricsState.metrics.skipReason ??
        `This session is ${formatFileSize(getMetricsFileSize(metricsState, activeSession))}. Deep analysis is opt-in so browsing stays responsive.`,
    };
  }

  if (metricsState.metrics.analysisKind === "partial") {
    return {
      kind: "notice",
      title: "Partial analysis",
      message:
        metricsState.metrics.skipReason ??
        "Some oversized JSONL rows were skipped to keep this inspection bounded.",
    };
  }

  if (isLargeSession(activeSession)) {
    return {
      kind: "notice",
      title: "Large session",
      message: `This session is ${formatFileSize(activeSession?.fileSizeBytes ?? null)}. Export is supported, but deep operations may take longer than normal.`,
    };
  }

  return null;
}

function GitHubMark(props: { className?: string }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49C4 14.09 3.48 13.22 3.32 12.77c-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.11 0 0 .67-.21 2.2.82a7.66 7.66 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.91.08 2.11.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function getRequestedFolderTarget(folderPath: string): string {
  return folderPath.trim() || "";
}

function getRpc() {
  if (!electroview.rpc) {
    throw new Error("Electroview RPC is not available.");
  }

  return electroview.rpc;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function formatExportLabel(format: ExportFormat): string {
  return format === "markdown" ? "Markdown" : "HTML";
}

function formatExportStateTitle(kind: ExportState["kind"]): string {
  switch (kind) {
    case "working":
      return "Exporting...";
    case "success":
      return "Export complete";
    case "error":
      return "Export failed";
    case "cancelled":
      return "Export cancelled";
    default:
      return "Ready to export";
  }
}

function formatSanitizedCopyStateTitle(
  kind: SanitizedCopyState["kind"],
): string {
  switch (kind) {
    case "working":
      return "Creating sanitized output...";
    case "success":
      return "Sanitized output ready";
    case "error":
      return "Sanitization failed";
    case "cancelled":
      return "Sanitization cancelled";
    default:
      return "Ready";
  }
}

function htmlExportUsesFilePicker(
  includeImages: boolean,
  inlineImages: boolean,
): boolean {
  return !includeImages || inlineImages;
}

function getExportDestinationHint(
  format: ExportFormat,
  includeImages: boolean,
  inlineImages: boolean,
): string {
  if (format === "markdown") {
    return "Choose a folder and codlogs will write the Markdown file into it.";
  }

  return htmlExportUsesFilePicker(includeImages, inlineImages)
    ? "Save a single self-contained HTML file."
    : "Choose a folder and codlogs will write the HTML file plus a sibling .assets folder.";
}

function formatAvailabilityLabel(available: boolean): string {
  return available ? "Available" : "Unavailable";
}

function App() {
  const [result, setResult] = useState<FindCodexSessionsResult | null>(null);
  const [codexHome, setCodexHome] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [cwdOnly, setCwdOnly] = useState(false);
  const [includeCrossSessionWrites, setIncludeCrossSessionWrites] = useState(false);
  const [appliedQuery, setAppliedQuery] = useState<AppliedQuery>({
    browseMode: "folder",
    targetDirectory: "",
    cwdOnly: false,
    includeCrossSessionWrites: false,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [showLiveSessions, setShowLiveSessions] = useState(true);
  const [showArchivedSessions, setShowArchivedSessions] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sessionDetailMetricsByFile, setSessionDetailMetricsByFile] = useState<
    Record<string, SessionDetailMetrics>
  >({});
  const [sessionDetailMetricsState, setSessionDetailMetricsState] =
    useState<SessionDetailMetricsState>({
      kind: "idle",
      metrics: null,
      errorMessage: null,
    });
  const [environmentCapabilitiesState, setEnvironmentCapabilitiesState] =
    useState<EnvironmentCapabilitiesState>({
      kind: "idle",
      capabilities: null,
      errorMessage: null,
    });
  const [environmentExpanded, setEnvironmentExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState>({
    kind: "idle",
    progressPercent: 0,
    stage: "idle",
    message: "",
    outputPath: null,
  });
  const [sanitizedCopyState, setSanitizedCopyState] = useState<SanitizedCopyState>({
    kind: "idle",
    progressPercent: 0,
    stage: "idle",
    message: "",
    outputPath: null,
  });
  const [exportImages, setExportImages] = useState(false);
  const [exportInlineImages, setExportInlineImages] = useState(true);
  const [exportToolCallResults, setExportToolCallResults] = useState(false);
  const [exportDialog, setExportDialog] = useState<ExportDialogState | null>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null);
  const [sanitizedCopyDialog, setSanitizedCopyDialog] =
    useState<SanitizedCopyDialogState | null>(null);
  const codexHomeRef = useRef(codexHome);
  const folderPathRef = useRef(folderPath);
  const loadRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const environmentRequestIdRef = useRef(0);
  const exportRequestIdRef = useRef(0);
  const sanitizedCopyRequestIdRef = useRef(0);
  const activeExportJobIdRef = useRef<string | null>(null);
  const activeSanitizedCopyJobIdRef = useRef<string | null>(null);
  const initialWindowRefreshDoneRef = useRef(false);
  const [exportCancelPending, setExportCancelPending] = useState(false);
  const [sanitizedCopyCancelPending, setSanitizedCopyCancelPending] = useState(false);
  const [renameSessionPending, setRenameSessionPending] = useState(false);

  const deferredSearchQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    void loadSessions("", "folder");
  }, []);

  useEffect(() => {
    codexHomeRef.current = codexHome;
  }, [codexHome]);

  useEffect(() => {
    folderPathRef.current = folderPath;
  }, [folderPath]);

  useEffect(() => {
    if (!exportDialog) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExportDialog(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [exportDialog]);

  useEffect(() => {
    if (!sanitizedCopyDialog) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSanitizedCopyDialog(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sanitizedCopyDialog]);

  useEffect(() => {
    if (!renameDialog || renameSessionPending) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRenameDialog(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [renameDialog, renameSessionPending]);

  useEffect(() => {
    if (environmentCapabilitiesState.kind === "ready") {
      setEnvironmentExpanded(environmentCapabilitiesState.capabilities?.overallKind !== "success");
      return;
    }

    if (environmentCapabilitiesState.kind === "error") {
      setEnvironmentExpanded(true);
    }
  }, [
    environmentCapabilitiesState.kind,
    environmentCapabilitiesState.capabilities?.overallKind,
    environmentCapabilitiesState.capabilities?.codexHome,
  ]);

  const filteredSessions = (result?.sessions ?? []).filter((session) => {
    if (session.kind === "live" && !showLiveSessions) {
      return false;
    }

    if (session.kind === "archived" && !showArchivedSessions) {
      return false;
    }

    return matchesSearch(session, deferredSearchQuery);
  });
  const activeSession =
    filteredSessions.find((session) => session.file === selectedFile) ??
    filteredSessions[0] ??
    null;
  const activeSessionDetailMetrics =
    activeSession ? sessionDetailMetricsByFile[activeSession.file] ?? null : null;
  const activeSessionFileSize = getMetricsFileSize(sessionDetailMetricsState, activeSession);
  const analysisBanner = getAnalysisBannerCopy(sessionDetailMetricsState, activeSession);

  useEffect(() => {
    const hasSelectedSession = filteredSessions.some(
      (session) => session.file === selectedFile,
    );
    const nextSelection = filteredSessions[0]?.file ?? null;
    if (!hasSelectedSession && nextSelection !== selectedFile) {
      startTransition(() => {
        setSelectedFile(nextSelection);
      });
    }
  }, [filteredSessions, selectedFile]);

  useEffect(() => {
    if (!activeSession) {
      setSessionDetailMetricsState({
        kind: "idle",
        metrics: null,
        errorMessage: null,
      });
      return;
    }

    if (activeSessionDetailMetrics) {
      setSessionDetailMetricsState({
        kind: "ready",
        metrics: activeSessionDetailMetrics,
        errorMessage: null,
      });
      return;
    }

    void requestSessionDetailMetrics(activeSession.file, false);
  }, [activeSession, activeSessionDetailMetrics]);

  async function requestSessionDetailMetrics(
    sessionFilePath: string,
    forceDeepAnalysis: boolean,
  ): Promise<void> {
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;

    setSessionDetailMetricsState({
      kind: "loading",
      metrics: null,
      errorMessage: null,
    });

    try {
      const metrics = await getRpc().request.getSessionDetailMetrics({
        sessionFilePath,
        forceDeepAnalysis,
      });

      if (requestId !== detailRequestIdRef.current) {
        return;
      }

      setSessionDetailMetricsByFile((current) => ({
        ...current,
        [sessionFilePath]: metrics,
      }));
      setSessionDetailMetricsState({
        kind: "ready",
        metrics,
        errorMessage: null,
      });
    } catch (detailError) {
      if (requestId !== detailRequestIdRef.current) {
        return;
      }

      setSessionDetailMetricsState({
        kind: "error",
        metrics: null,
        errorMessage: asErrorMessage(detailError),
      });
    }
  }

  async function refreshEnvironmentCapabilities(
    nextCodexHome: string | null,
  ): Promise<void> {
    const requestId = environmentRequestIdRef.current + 1;
    environmentRequestIdRef.current = requestId;
    setEnvironmentCapabilitiesState((current) => ({
      kind: "loading",
      capabilities: current.capabilities,
      errorMessage: null,
    }));

    try {
      const capabilities = await getRpc().request.getEnvironmentCapabilities({
        codexHome: nextCodexHome,
      });

      if (requestId !== environmentRequestIdRef.current) {
        return;
      }

      setEnvironmentCapabilitiesState({
        kind: "ready",
        capabilities,
        errorMessage: null,
      });
    } catch (capabilityError) {
      if (requestId !== environmentRequestIdRef.current) {
        return;
      }

      setEnvironmentCapabilitiesState({
        kind: "error",
        capabilities: null,
        errorMessage: asErrorMessage(capabilityError),
      });
    }
  }

  async function loadSessions(
    targetDirectory: string | null,
    nextBrowseMode: BrowseMode,
    nextCwdOnly = cwdOnly,
    nextIncludeCrossSessionWrites = includeCrossSessionWrites,
  ): Promise<void> {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);

    try {
      const nextResult = await getRpc().request.loadSessions({
        codexHome: codexHome.trim() || null,
        targetDirectory,
        cwdOnly: nextCwdOnly,
        includeCrossSessionWrites: nextIncludeCrossSessionWrites,
      });

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setResult(nextResult);
      setAppliedQuery({
        browseMode: nextBrowseMode,
        targetDirectory,
        cwdOnly: nextCwdOnly,
        includeCrossSessionWrites: nextIncludeCrossSessionWrites,
      });
      if (!codexHomeRef.current.trim()) {
        setCodexHome(nextResult.codexHome);
      }
      if (!folderPathRef.current.trim()) {
        setFolderPath(nextResult.currentWorkingDirectory);
      }
      setSelectedFile((current) =>
        current && nextResult.sessions.some((session) => session.file === current)
          ? current
          : nextResult.sessions[0]?.file ?? null,
      );
      if (!initialWindowRefreshDoneRef.current) {
        initialWindowRefreshDoneRef.current = true;
        void getRpc().request.refreshWindowLayout({});
      }
      void refreshEnvironmentCapabilities(nextResult.codexHome);
    } catch (loadError) {
      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setError(asErrorMessage(loadError));
      void refreshEnvironmentCapabilities(codexHome.trim() || null);
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function pickFolder(): Promise<void> {
    try {
      const { path } = await getRpc().request.pickDirectory({
        startingFolder: folderPath.trim() || null,
      });

      if (!path) {
        return;
      }

      setFolderPath(path);
      void loadSessions(path, "folder", cwdOnly, includeCrossSessionWrites);
    } catch (pickError) {
      setError(asErrorMessage(pickError));
    }
  }

  function openExportDialog(format: ExportFormat): void {
    if (!activeSession || exportState.kind === "working") {
      return;
    }

    setExportDialog({ format });
  }

  function openRenameDialog(session: SessionMetaMatch): void {
    if (
      exportState.kind === "working" ||
      sanitizedCopyState.kind === "working" ||
      renameSessionPending ||
      !canRenameSessions
    ) {
      return;
    }

    setRenameDialog({
      sessionId: session.id,
      sessionLabel: getSessionTitle(session),
      title: sanitizeSessionTitleDraft(getSessionTitle(session)),
    });
  }

  function openSanitizedCopyDialog(): void {
    if (!activeSession || sanitizedCopyState.kind === "working") {
      return;
    }

    setSanitizedCopyDialog({
      chatName: sanitizeSessionTitleDraft(
        activeSession.threadName?.trim() || getSessionTitle(activeSession),
      ),
      stripImageContent: true,
      stripBlobContent: false,
      createJsonlCopy: true,
      reAddToCurrentDay: false,
    });
  }

  async function submitRenameDialog(): Promise<void> {
    if (!renameDialog || renameSessionPending) {
      return;
    }

    const sanitizedTitle = sanitizeSessionTitleDraft(renameDialog.title);
    if (!sanitizedTitle) {
      return;
    }

    setRenameSessionPending(true);
    try {
      await getRpc().request.renameSessionThreadName({
        codexHome: codexHome.trim() || null,
        threadId: renameDialog.sessionId,
        threadName: sanitizedTitle,
      });
      setRenameDialog(null);
      await loadSessions(
        appliedQuery.targetDirectory,
        appliedQuery.browseMode,
        appliedQuery.cwdOnly,
        appliedQuery.includeCrossSessionWrites,
      );
    } catch (renameError) {
      setError(asErrorMessage(renameError));
    } finally {
      setRenameSessionPending(false);
    }
  }

  async function submitExportDialog(): Promise<void> {
    if (!exportDialog) {
      return;
    }

    const { format } = exportDialog;
    setExportDialog(null);
    await exportActiveSession(format);
  }

  async function submitSanitizedCopyDialog(): Promise<void> {
    if (!sanitizedCopyDialog) {
      return;
    }

    const dialogOptions = {
      ...sanitizedCopyDialog,
      chatName: sanitizeSessionTitleDraft(sanitizedCopyDialog.chatName),
    };
    setSanitizedCopyDialog(null);
    await createSanitizedCopy(dialogOptions);
  }

  async function exportActiveSession(format: ExportFormat): Promise<void> {
    if (!activeSession) {
      return;
    }

    const exportRequestId = exportRequestIdRef.current + 1;
    exportRequestIdRef.current = exportRequestId;
    activeExportJobIdRef.current = null;
    setExportCancelPending(false);
    let outputDirectory: string | null = null;
    let outputPath: string | null = null;
    const label = formatExportLabel(format);

    try {
      if (format === "markdown") {
        const response = await getRpc().request.pickExportDirectory({
          sessionFilePath: activeSession.file,
        });
        outputDirectory = response.path;
      } else {
        const response = await getRpc().request.pickHtmlExportDestination({
          sessionFilePath: activeSession.file,
          includeImages: exportImages,
          inlineImages: exportInlineImages,
        });
        if (response.selectionKind === "directory") {
          outputDirectory = response.path;
        } else {
          outputPath = response.path;
        }
      }
    } catch (pickError) {
      setExportState({
        kind: "error",
        progressPercent: 0,
        stage: "error",
        message: asErrorMessage(pickError),
        outputPath: null,
      });
      return;
    }

    if (!outputDirectory && !outputPath) {
      setExportState({
        kind: "idle",
        progressPercent: 0,
        stage: "idle",
        message: "Export cancelled.",
        outputPath: null,
      });
      return;
    }

    setExportState({
      kind: "working",
      progressPercent: 4,
      stage: "starting",
      message: `Preparing ${label} export...`,
      outputPath: null,
    });

    try {
      if (format === "markdown") {
        const { jobId } = await getRpc().request.startSessionMarkdownExport({
          sessionFilePath: activeSession.file,
          includeImages: exportImages,
          includeToolCallResults: exportToolCallResults,
          outputDirectory,
        });
        activeExportJobIdRef.current = jobId;
      } else {
        const { jobId } = await getRpc().request.startSessionHtmlExport({
          sessionFilePath: activeSession.file,
          includeImages: exportImages,
          inlineImages: exportInlineImages,
          includeToolCallResults: exportToolCallResults,
          outputDirectory,
          outputPath,
        });
        activeExportJobIdRef.current = jobId;
      }

      while (exportRequestId === exportRequestIdRef.current && activeExportJobIdRef.current) {
        const jobId = activeExportJobIdRef.current;
        if (!jobId) {
          break;
        }
        const status = await getRpc().request.getExportJobStatus({ jobId });
        if (exportRequestId !== exportRequestIdRef.current) {
          return;
        }

        if (status.kind === "cancelled") {
          activeExportJobIdRef.current = null;
          setExportCancelPending(false);
          setExportState({
            kind: "cancelled",
            progressPercent: status.progressPercent,
            stage: status.stage,
            message: status.message,
            outputPath: null,
          });
          return;
        }

        setExportState(status);
        if (status.kind !== "working") {
          activeExportJobIdRef.current = null;
          setExportCancelPending(false);
          return;
        }

        await delay(400);
      }
    } catch (exportError) {
      if (exportRequestId !== exportRequestIdRef.current) {
        return;
      }

      activeExportJobIdRef.current = null;
      setExportCancelPending(false);
      setExportState({
        kind: "error",
        progressPercent: 0,
        stage: "error",
        message: asErrorMessage(exportError),
        outputPath: null,
      });
    }
  }

  async function cancelActiveExport(): Promise<void> {
    const jobId = activeExportJobIdRef.current;
    if (!jobId || exportCancelPending) {
      return;
    }

    setExportCancelPending(true);
    setExportState((current) =>
      current.kind === "working"
        ? {
            ...current,
            message: "Cancelling export...",
          }
        : current,
    );

    try {
      await getRpc().request.cancelExportJob({ jobId });
    } catch (cancelError) {
      setExportCancelPending(false);
      setExportState({
        kind: "error",
        progressPercent: 0,
        stage: "error",
        message: asErrorMessage(cancelError),
        outputPath: null,
      });
    }
  }

  async function createSanitizedCopy(options: SanitizedCopyDialogState): Promise<void> {
    if (!activeSession || sanitizedCopyState.kind === "working") {
      return;
    }

    const requestId = sanitizedCopyRequestIdRef.current + 1;
    sanitizedCopyRequestIdRef.current = requestId;
    activeSanitizedCopyJobIdRef.current = null;
    setSanitizedCopyCancelPending(false);
    setSanitizedCopyState({
      kind: "working",
      progressPercent: 4,
      stage: "starting",
      message: "Preparing sanitized session output...",
      outputPath: null,
    });

    try {
      const { jobId } = await getRpc().request.startSessionSanitizedCopy({
        sessionFilePath: activeSession.file,
        codexHome: codexHome.trim() || null,
        chatName: options.chatName.trim() || null,
        stripImageContent: options.stripImageContent,
        stripBlobContent: options.stripBlobContent,
        createJsonlCopy: options.createJsonlCopy,
        reAddToCurrentDay: options.reAddToCurrentDay,
      });
      activeSanitizedCopyJobIdRef.current = jobId;

      while (
        requestId === sanitizedCopyRequestIdRef.current &&
        activeSanitizedCopyJobIdRef.current
      ) {
        const activeJobId = activeSanitizedCopyJobIdRef.current;
        if (!activeJobId) {
          break;
        }

        const status = await getRpc().request.getSanitizedCopyJobStatus({
          jobId: activeJobId,
        });
        if (requestId !== sanitizedCopyRequestIdRef.current) {
          return;
        }

        if (status.kind === "cancelled") {
          activeSanitizedCopyJobIdRef.current = null;
          setSanitizedCopyCancelPending(false);
          setSanitizedCopyState({
            kind: "cancelled",
            progressPercent: status.progressPercent,
            stage: status.stage,
            message: status.message,
            outputPath: null,
          });
          return;
        }

        setSanitizedCopyState(status);
        if (status.kind !== "working") {
          activeSanitizedCopyJobIdRef.current = null;
          setSanitizedCopyCancelPending(false);
          if (status.kind === "success") {
            await loadSessions(
              appliedQuery.targetDirectory,
              appliedQuery.browseMode,
              appliedQuery.cwdOnly,
              appliedQuery.includeCrossSessionWrites,
            );
          }
          return;
        }

        await delay(400);
      }
    } catch (sanitizedCopyError) {
      if (requestId !== sanitizedCopyRequestIdRef.current) {
        return;
      }

      activeSanitizedCopyJobIdRef.current = null;
      setSanitizedCopyCancelPending(false);
      setSanitizedCopyState({
        kind: "error",
        progressPercent: 0,
        stage: "error",
        message: asErrorMessage(sanitizedCopyError),
        outputPath: null,
      });
    }
  }

  async function cancelSanitizedCopy(): Promise<void> {
    const jobId = activeSanitizedCopyJobIdRef.current;
    if (!jobId || sanitizedCopyCancelPending) {
      return;
    }

    setSanitizedCopyCancelPending(true);
    setSanitizedCopyState((current) =>
      current.kind === "working"
        ? {
            ...current,
            message: "Cancelling sanitization...",
          }
        : current,
    );

    try {
      await getRpc().request.cancelSanitizedCopyJob({ jobId });
    } catch (cancelError) {
      setSanitizedCopyCancelPending(false);
      setSanitizedCopyState({
        kind: "error",
        progressPercent: 0,
        stage: "error",
        message: asErrorMessage(cancelError),
        outputPath: null,
      });
    }
  }

  async function revealPath(targetPath: string | null): Promise<void> {
    if (!targetPath) {
      return;
    }

    try {
      await getRpc().request.revealPath({ path: targetPath });
    } catch (revealError) {
      setError(asErrorMessage(revealError));
    }
  }

  async function openPath(targetPath: string | null): Promise<void> {
    if (!targetPath) {
      return;
    }

    try {
      const response = await getRpc().request.openPath({ path: targetPath });
      if (!response.ok) {
        setError(`Could not open ${targetPath}`);
      }
    } catch (openError) {
      setError(asErrorMessage(openError));
    }
  }

  function handleLoadAll(): void {
    void loadSessions(null, "all", cwdOnly);
  }

  function handleFilterByFolder(): void {
    void loadSessions(
      getRequestedFolderTarget(folderPath),
      "folder",
      cwdOnly,
      includeCrossSessionWrites,
    );
  }

  function handleRefresh(): void {
    void loadSessions(
      appliedQuery.targetDirectory,
      appliedQuery.browseMode,
      appliedQuery.cwdOnly,
      appliedQuery.includeCrossSessionWrites,
    );
  }

  function handleSessionCardKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    sessionFile: string,
  ): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedFile(sessionFile);
    }
  }

  function handleAnalyzeLargeSession(): void {
    if (!activeSession || sessionDetailMetricsState.kind === "loading") {
      return;
    }

    void requestSessionDetailMetrics(activeSession.file, true);
  }

  const environmentCapabilities = environmentCapabilitiesState.capabilities;
  const canReAddToCurrentDay = environmentCapabilities?.codexHomeWritable === true;
  const canRenameSessions = environmentCapabilities?.codexHomeWritable === true;
  const isCodlogsSanitizedSession = activeSession?.source === "codlogs_sanitized_copy";
  const renameSessionDisabledReason =
    environmentCapabilitiesState.kind === "error"
      ? environmentCapabilitiesState.errorMessage ?? "Environment capability check failed."
      : environmentCapabilitiesState.kind === "loading"
        ? "Checking whether codlogs can write session titles..."
        : canRenameSessions
          ? null
          : "Codex home is not writable, so codlogs cannot rename sessions.";
  const reAddToCurrentDayDisabledReason =
    environmentCapabilitiesState.kind === "error"
      ? environmentCapabilitiesState.errorMessage ?? "Environment capability check failed."
      : environmentCapabilitiesState.kind === "loading"
        ? "Checking whether codlogs can write into today's Codex sessions folder..."
        : canReAddToCurrentDay
          ? null
          : "Codex home is not writable, so codlogs cannot add a live session copy today.";

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className="workspace">
        <header className="hero">
          <div className="hero-content">
            <h1>codlogs</h1>
            <p className="hero-copy">
              <span>Browse and export your Codex sessions with ease.</span>
              <span className="hero-copy-separator" aria-hidden="true">
                •
              </span>
              <span>(c) 2026 @tobitege</span>
              <a
                className="hero-copy-link"
                href={REPOSITORY_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Open the codlogs GitHub repository"
                title={REPOSITORY_URL}
                onClick={(event) => {
                  event.preventDefault();
                  void openPath(REPOSITORY_URL);
                }}
              >
                <GitHubMark className="hero-copy-icon" />
              </a>
            </p>
          </div>
          <div className="hero-stats">
            <div className="stat-card">
              <span className="stat-label">Sessions</span>
              <span className="stat-value">{result?.sessionCount ?? 0}</span>
              <span className="stat-detail">{result ? `${result.liveCount} live / ${result.archivedCount} archived` : "Scanning..."}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Scope</span>
              <span className="stat-value">{describeScope(result, appliedQuery.browseMode)}</span>
              <span className="stat-detail" title={result?.targetRoot ?? "All sessions"}>
                {result?.targetRoot ?? "All sessions"}
              </span>
            </div>
          </div>
        </header>

        <section className="control-strip">
          <div className="control-strip-main">
            <div className="search-container">
              <span className="search-icon">🔍</span>
              <input
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleFilterByFolder();
                  }
                }}
                placeholder="Filter by folder or repo path..."
              />
            </div>
            <div className="filter-actions">
              <button className="ghost-button" onClick={() => void pickFolder()}>
                Choose Folder
              </button>
              <button className="ghost-button" onClick={handleRefresh}>
                Refresh
              </button>
              <button className="primary-button" onClick={handleFilterByFolder}>
                Filter
              </button>
              <button className="primary-button" onClick={handleLoadAll}>
                Show All
              </button>
            </div>
          </div>
          <div className="control-strip-options">
            <label className="checkbox-label compact-checkbox" title="Include sessions that worked on or wrote into this folder even if the session started elsewhere.">
              <input
                type="checkbox"
                checked={includeCrossSessionWrites}
                onChange={(event) => setIncludeCrossSessionWrites(event.target.checked)}
              />
              <span>Cross-session writes</span>
            </label>
          </div>
        </section>

        {(environmentCapabilitiesState.kind !== "idle" || environmentCapabilitiesState.errorMessage) && (
          <section
            className={`status-banner environment-banner status-${
              environmentCapabilitiesState.kind === "error"
                ? "error"
                : environmentCapabilitiesState.kind === "loading"
                  ? "working"
                  : environmentCapabilities?.overallKind ?? "notice"
            }`}
          >
            <div className="environment-summary-row">
              <div className="environment-status-info">
                <strong>Environment Status</strong>
                <span className="environment-summary-text">
                  {environmentCapabilitiesState.kind === "error"
                    ? environmentCapabilitiesState.errorMessage ?? "Capability check failed."
                    : environmentCapabilitiesState.kind === "loading"
                      ? "Checking Codex home access and helper tools..."
                      : environmentCapabilities?.summary ?? "Capability check pending."}
                </span>
              </div>
              <button
                className="ghost-button environment-toggle"
                onClick={() => setEnvironmentExpanded((current) => !current)}
                type="button"
              >
                {environmentExpanded ? "Hide Details" : "Show Details"}
              </button>
            </div>
            {environmentExpanded && (
              <>
                <p className="environment-path">
                  Codex home: {environmentCapabilities?.codexHome ?? (codexHome || "Detecting...")}
                </p>
                {environmentCapabilities && (
                  <div className="environment-capability-list">
                    <EnvironmentCapabilityLine
                      available={environmentCapabilities.codexHomeReadable}
                      label="Codex home read"
                    />
                    <EnvironmentCapabilityLine
                      available={environmentCapabilities.codexHomeWritable}
                      label="Codex home write"
                    />
                    <EnvironmentCapabilityLine
                      available={environmentCapabilities.gitAvailable}
                      label="git"
                    />
                    <EnvironmentCapabilityLine
                      available={environmentCapabilities.ripgrepAvailable}
                      label="rg"
                    />
                  </div>
                )}
                {environmentCapabilities && environmentCapabilities.notes.length > 0 && (
                  <div className="environment-note-list">
                    {environmentCapabilities.notes.map((note) => (
                      <span key={note} className="environment-note">
                        {note}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        <section className="content-grid">
          <aside className="panel">
            <div className="panel-header">
              <div className="panel-header-row">
                <div className="panel-header-title">
                  <h2>Sessions</h2>
                  <span className="panel-header-count">
                    {filteredSessions.length} {filteredSessions.length === 1 ? "match" : "matches"}
                  </span>
                </div>
              </div>
              <div className="search-container compact panel-search">
                <input
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                  }}
                  placeholder="Search..."
                />
              </div>
              <div className="session-filter-row">
                <label className="checkbox-label compact-checkbox">
                  <input
                    type="checkbox"
                    checked={showLiveSessions}
                    onChange={(event) => setShowLiveSessions(event.target.checked)}
                  />
                  <span>Live</span>
                </label>
                <label className="checkbox-label compact-checkbox">
                  <input
                    type="checkbox"
                    checked={showArchivedSessions}
                    onChange={(event) => setShowArchivedSessions(event.target.checked)}
                  />
                  <span>Archived</span>
                </label>
              </div>
            </div>

            <div className="session-list">
              {loading ? (
                <div className="empty-state">
                  <span className="empty-icon">📂</span>
                  <p>Scanning Codex sessions...</p>
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-icon">❓</span>
                  <p>{error ?? "No sessions found."}</p>
                </div>
              ) : (
                filteredSessions.map((session) => (
                  <div
                    key={session.file}
                    className={`session-card ${session.file === activeSession?.file ? "selected" : ""} ${isLargeSession(session) ? "session-card-large" : ""}`}
                    onClick={() => setSelectedFile(session.file)}
                    onKeyDown={(event) => handleSessionCardKeyDown(event, session.file)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="session-card-header">
                      <div className="session-card-badges">
                        <span className={`kind-badge kind-${session.kind}`}>{session.kind}</span>
                        {isLargeSession(session) && (
                          <span className="size-badge">{formatFileSize(session.fileSizeBytes)}</span>
                        )}
                      </div>
                      <span className="session-time">{formatTimestamp(session.updatedAt ?? session.startedAt)}</span>
                    </div>
                    <span className="session-title">{getSessionTitle(session)}</span>
                    <span className="session-cwd">{session.cwd}</span>
                    <button
                      aria-label="Rename session"
                      className="session-rename-button"
                      disabled={
                        exportState.kind === "working" ||
                        sanitizedCopyState.kind === "working" ||
                        renameSessionPending ||
                        !canRenameSessions
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openRenameDialog(session);
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                      }}
                      title={renameSessionDisabledReason ?? "Rename session"}
                      type="button"
                    >
                      T
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>

          <section className="panel">
            {activeSession ? (
              <div className="detail-content">
                <div className="detail-header">
                  <div className="detail-title">
                    <h2>{getSessionTitle(activeSession)}</h2>
                  </div>
                  <div className="filter-actions detail-actions">
                    <button
                      aria-label="Reveal session folder"
                      className="ghost-button icon-button"
                      onClick={() => void revealPath(activeSession.file)}
                      title="Reveal JSONL"
                      type="button"
                    >
                      <svg
                        aria-hidden="true"
                        className="button-icon"
                        fill="none"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M3.75 7.5A2.25 2.25 0 0 1 6 5.25h4.19a2.25 2.25 0 0 1 1.59.66l1.06 1.06c.14.14.33.22.53.22H18A2.25 2.25 0 0 1 20.25 9.5v7A2.25 2.25 0 0 1 18 18.75H6A2.25 2.25 0 0 1 3.75 16.5v-9Z"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                        />
                      </svg>
                    </button>
                    {!isCodlogsSanitizedSession && (
                      <button
                        className="ghost-button"
                        disabled={
                          exportState.kind === "working" || sanitizedCopyState.kind === "working"
                        }
                        onClick={openSanitizedCopyDialog}
                        type="button"
                      >
                        Sanitize Session...
                      </button>
                    )}
                    <button
                      className="primary-button"
                      disabled={exportState.kind === "working" || sanitizedCopyState.kind === "working"}
                      onClick={() => openExportDialog("markdown")}
                      type="button"
                    >
                      Export Markdown
                    </button>
                    <button
                      className="primary-button"
                      disabled={exportState.kind === "working" || sanitizedCopyState.kind === "working"}
                      onClick={() => openExportDialog("html")}
                      type="button"
                    >
                      Export HTML
                    </button>
                  </div>
                </div>

                {analysisBanner && (
                  <div className={`status-banner analysis-banner status-${analysisBanner.kind}`}>
                    <div className="status-info">
                      <strong>{analysisBanner.title}</strong>
                      <p>{analysisBanner.message}</p>
                    </div>
                    {sessionDetailMetricsState.kind === "ready" &&
                      sessionDetailMetricsState.metrics?.analysisKind === "skipped" && (
                        <div className="filter-actions">
                          <button className="primary-button" onClick={handleAnalyzeLargeSession}>
                            Analyze Anyway
                          </button>
                        </div>
                      )}
                  </div>
                )}

                {exportState.kind !== "idle" && exportState.kind !== "working" && (
                  <div className={`status-banner export-status-inline status-${exportState.kind}`}>
                    <div className="status-info">
                      <strong>{formatExportStateTitle(exportState.kind)}</strong>
                      <p>{exportState.message}</p>
                    </div>
                    {exportState.outputPath && (
                      <div className="filter-actions">
                        <button className="ghost-button" onClick={() => void revealPath(exportState.outputPath)}>
                          Reveal
                        </button>
                        <button className="ghost-button" onClick={() => void openPath(exportState.outputPath)}>
                          Open
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {sanitizedCopyState.kind !== "idle" &&
                  sanitizedCopyState.kind !== "working" && (
                    <div
                      className={`status-banner export-status-inline status-${sanitizedCopyState.kind}`}
                    >
                      <div className="status-info">
                        <strong>
                          {formatSanitizedCopyStateTitle(sanitizedCopyState.kind)}
                        </strong>
                        <p>{sanitizedCopyState.message}</p>
                      </div>
                      {sanitizedCopyState.outputPath && (
                        <div className="filter-actions">
                          <button
                            className="ghost-button"
                            onClick={() => void revealPath(sanitizedCopyState.outputPath)}
                          >
                            Reveal
                          </button>
                          <button
                            className="ghost-button"
                            onClick={() => void openPath(sanitizedCopyState.outputPath)}
                          >
                            Open
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                <div className="detail-meta-grid">
                  <div className="meta-item">
                    <span className="meta-label">Timeline</span>
                    <div className="meta-value">
                      <div style={{ marginBottom: "0.4rem" }}>
                        <span style={{ fontSize: "0.7rem", color: "var(--color-accent)", marginRight: "0.5rem" }}>UPDATED</span>
                        {formatTimestamp(activeSession.updatedAt)}
                      </div>
                      <div>
                        <span style={{ fontSize: "0.7rem", color: "var(--color-accent)", marginRight: "0.5rem" }}>STARTED</span>
                        {formatTimestamp(activeSession.startedAt)}
                      </div>
                    </div>
                  </div>
                  <MetaItem label="Session ID" value={activeSession.id} />
                  <MetaItem
                    label="Interactions"
                    value={formatInteractionSummary(sessionDetailMetricsState)}
                  />
                  <MetaItem
                    label="File Size"
                    value={
                      sessionDetailMetricsState.kind === "error"
                        ? "Unavailable"
                        : formatFileSize(activeSessionFileSize)
                    }
                  />
                  <MetaItem
                    label="Analysis"
                    value={
                      sessionDetailMetricsState.kind === "error"
                        ? "Unavailable"
                        : sessionDetailMetricsState.kind === "loading"
                          ? "Inspecting..."
                          : sessionDetailMetricsState.kind === "idle"
                            ? "Waiting"
                            : sessionDetailMetricsState.metrics?.analysisKind === "skipped"
                              ? "Skipped"
                              : sessionDetailMetricsState.metrics?.analysisKind === "partial"
                                ? "Partial"
                                : "Full"
                    }
                  />
                  <MetaItem label="Working Directory" value={activeSession.cwd} />
                  <MetaItem label="Source File" value={formatDisplayPath(activeSession.file)} />
                </div>

                {error && <div className="inline-error" style={{ marginTop: "1rem" }}>{error}</div>}
              </div>
            ) : (
              <div className="empty-state">
                <span className="empty-icon">📝</span>
                <p>{error ?? "Select a session to view details and export."}</p>
              </div>
            )}
          </section>
        </section>
      </main>
      {exportDialog && (
        <ExportDialog
          format={exportDialog.format}
          fileSizeBytes={activeSession?.fileSizeBytes ?? null}
          includeImages={exportImages}
          includeToolCallResults={exportToolCallResults}
          inlineImages={exportInlineImages}
          isWorking={
            exportState.kind === "working" || sanitizedCopyState.kind === "working"
          }
          onClose={() => setExportDialog(null)}
          onConfirm={() => void submitExportDialog()}
          onIncludeImagesChange={setExportImages}
          onIncludeToolCallResultsChange={setExportToolCallResults}
          onInlineImagesChange={setExportInlineImages}
        />
      )}
      {renameDialog && (
        <RenameSessionDialog
          isWorking={renameSessionPending}
          onClose={() => {
            if (!renameSessionPending) {
              setRenameDialog(null);
            }
          }}
          onConfirm={() => void submitRenameDialog()}
          onTitleChange={(value) =>
            setRenameDialog((current) =>
              current
                ? {
                    ...current,
                    title: sanitizeSessionTitleDraft(value),
                  }
                : current,
            )
          }
          sessionLabel={renameDialog.sessionLabel}
          title={renameDialog.title}
        />
      )}
      {sanitizedCopyDialog && (
        <SanitizedCopyDialog
          canReAddToCurrentDay={canReAddToCurrentDay}
          chatName={sanitizedCopyDialog.chatName}
          createJsonlCopy={sanitizedCopyDialog.createJsonlCopy}
          isWorking={exportState.kind === "working" || sanitizedCopyState.kind === "working"}
          onClose={() => setSanitizedCopyDialog(null)}
          onChatNameChange={(value) =>
            setSanitizedCopyDialog((current) =>
              current
                ? {
                  ...current,
                    chatName: sanitizeSessionTitleDraft(value),
                  }
                : current,
            )
          }
          onConfirm={() => void submitSanitizedCopyDialog()}
          onStripBlobContentChange={(value) =>
            setSanitizedCopyDialog((current) =>
              current
                ? {
                    ...current,
                    stripBlobContent: value,
                  }
                : current,
            )
          }
          onCreateJsonlCopyChange={(value) =>
            setSanitizedCopyDialog((current) =>
              current
                ? {
                    ...current,
                    createJsonlCopy: value,
                  }
                : current,
            )
          }
          onReAddToCurrentDayChange={(value) =>
            setSanitizedCopyDialog((current) =>
              current
                ? {
                    ...current,
                    reAddToCurrentDay: canReAddToCurrentDay ? value : false,
                  }
                : current,
            )
          }
          reAddToCurrentDayDisabledReason={reAddToCurrentDayDisabledReason}
          stripImageContent={sanitizedCopyDialog.stripImageContent}
          stripBlobContent={sanitizedCopyDialog.stripBlobContent}
          reAddToCurrentDay={sanitizedCopyDialog.reAddToCurrentDay}
        />
      )}
      {exportState.kind === "working" && (
        <ExportProgressDialog
          cancelPending={exportCancelPending}
          title="Export in progress"
          message={exportState.message}
          onCancel={() => void cancelActiveExport()}
          progressPercent={exportState.progressPercent}
          sessionTitle={activeSession ? getSessionTitle(activeSession) : "Selected session"}
          stage={exportState.stage}
          cancelLabel="Cancel Export"
        />
      )}
      {sanitizedCopyState.kind === "working" && (
        <ExportProgressDialog
          cancelPending={sanitizedCopyCancelPending}
          title="Sanitization in progress"
          message={sanitizedCopyState.message}
          onCancel={() => void cancelSanitizedCopy()}
          progressPercent={sanitizedCopyState.progressPercent}
          sessionTitle={activeSession ? getSessionTitle(activeSession) : "Selected session"}
          stage={sanitizedCopyState.stage}
          cancelLabel="Cancel Job"
        />
      )}
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-item">
      <span className="meta-label">{label}</span>
      <span className="meta-value">{value}</span>
    </div>
  );
}

function EnvironmentCapabilityLine(props: {
  available: boolean;
  label: string;
}) {
  return (
    <div className="environment-capability-line">
      <span className="environment-capability-label">{props.label}</span>
      <span
        className={`environment-capability-value ${
          props.available
            ? "environment-capability-value-ok"
            : "environment-capability-value-missing"
        }`}
      >
        {formatAvailabilityLabel(props.available)}
      </span>
    </div>
  );
}

function ExportDialog(props: {
  format: ExportFormat;
  fileSizeBytes: number | null;
  includeImages: boolean;
  includeToolCallResults: boolean;
  inlineImages: boolean;
  isWorking: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onIncludeImagesChange: (value: boolean) => void;
  onIncludeToolCallResultsChange: (value: boolean) => void;
  onInlineImagesChange: (value: boolean) => void;
}) {
  const label = formatExportLabel(props.format);
  const htmlUsesFilePicker = htmlExportUsesFilePicker(
    props.includeImages,
    props.inlineImages,
  );
  const largeSessionWarning =
    props.fileSizeBytes !== null && props.fileSizeBytes >= LARGE_SESSION_WARNING_BYTES;

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        aria-modal="true"
        className="export-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="export-dialog-header">
          <div>
            <span className="dialog-kicker">{label} export</span>
            <h3>Export Options</h3>
            <p>Pick what to include before choosing where this export should go.</p>
          </div>
          <button
            aria-label="Close export dialog"
            className="dialog-close"
            onClick={props.onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="export-dialog-options">
          {largeSessionWarning && (
            <div className="dialog-warning">
              <strong>Large session export</strong>
              <p>
                This session is {formatFileSize(props.fileSizeBytes)}. Export now streams the
                JSONL instead of loading it all into memory, but the job can still take a while.
              </p>
            </div>
          )}

          <label className="dialog-option dialog-option-stack">
            <input
              checked={props.includeImages}
              onChange={(event) => props.onIncludeImagesChange(event.target.checked)}
              type="checkbox"
            />
            <span className="dialog-option-copy">
              <strong>Include captured images</strong>
              <small>Render image attachments from the session into the export.</small>
            </span>
          </label>

          {props.format === "html" && (
            <label className={`dialog-option ${!props.includeImages ? "dialog-option-disabled" : ""}`}>
              <input
                checked={props.inlineImages}
                disabled={!props.includeImages}
                onChange={(event) => props.onInlineImagesChange(event.target.checked)}
                type="checkbox"
              />
              <span className="dialog-option-copy">
                <strong>Inline images (HTML)</strong>
                <small>
                  {props.includeImages
                    ? "Keep image data embedded in the HTML source and skip the extra asset folder."
                    : "Enable captured images first to choose whether HTML embeds them or writes sidecar files."}
                </small>
              </span>
            </label>
          )}

          <label className="dialog-option">
            <input
              checked={props.includeToolCallResults}
              onChange={(event) =>
                props.onIncludeToolCallResultsChange(event.target.checked)
              }
              type="checkbox"
            />
            <span className="dialog-option-copy">
              <strong>Include tool calls and results</strong>
              <small>Append tool invocations and outputs to the exported transcript.</small>
            </span>
          </label>
        </div>

        <div className="dialog-destination">
          <span className="dialog-destination-label">Destination</span>
          <strong>
            {props.format === "markdown"
              ? "Choose a folder"
              : htmlUsesFilePicker
                ? "Save as .html file"
                : "Choose a folder"}
          </strong>
          <p>
            {getExportDestinationHint(
              props.format,
              props.includeImages,
              props.inlineImages,
            )}
          </p>
        </div>

        <div className="dialog-actions">
          <button className="ghost-button" onClick={props.onClose} type="button">
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={props.isWorking}
            onClick={props.onConfirm}
            type="button"
          >
            Export {label}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportProgressDialog(props: {
  cancelPending: boolean;
  cancelLabel: string;
  message: string;
  onCancel: () => void;
  progressPercent: number;
  sessionTitle: string;
  stage: string;
  title: string;
}) {
  const clampedProgress = Math.max(4, Math.min(100, props.progressPercent));

  return (
    <div className="dialog-backdrop">
      <div aria-modal="true" className="export-progress-dialog" role="dialog">
        <div className="export-progress-header">
          <div>
            <span className="dialog-kicker">{props.title}</span>
            <h3>{props.sessionTitle}</h3>
            <p>{props.message}</p>
          </div>
          <span className="export-progress-percent">{Math.round(clampedProgress)}%</span>
        </div>

        <div className="export-progress-track" aria-hidden="true">
          <div
            className="export-progress-fill"
            style={{ width: `${clampedProgress}%` }}
          />
        </div>

        <div className="export-progress-meta">
          <span>{props.stage}</span>
          <span>
            {props.cancelPending
              ? "Stopping job..."
              : "Processing large session files can take a few seconds."}
          </span>
        </div>

        <div className="dialog-actions">
          <button
            className="ghost-button"
            disabled={props.cancelPending}
            onClick={props.onCancel}
            type="button"
          >
            {props.cancelPending ? "Cancelling..." : props.cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameSessionDialog(props: {
  isWorking: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onTitleChange: (value: string) => void;
  sessionLabel: string;
  title: string;
}) {
  const hasTitle = props.title.trim().length > 0;

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        aria-modal="true"
        className="export-dialog rename-session-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="export-dialog-header">
          <div>
            <span className="dialog-kicker">Session title</span>
            <h3>Rename Session</h3>
            <p>Update the Codex session title stored in `session_index.jsonl`.</p>
          </div>
          <button
            aria-label="Close rename session dialog"
            className="dialog-close"
            disabled={props.isWorking}
            onClick={props.onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="export-dialog-options">
          <div className="dialog-warning dialog-warning-neutral">
            <strong>Current session</strong>
            <p>{props.sessionLabel}</p>
          </div>

          <div className="dialog-field">
            <label className="dialog-field-label" htmlFor="rename-session-title">
              Session title
            </label>
            <p className="dialog-field-hint">
              Control characters and unsafe direction markers are stripped automatically.
            </p>
            <input
              autoFocus
              id="rename-session-title"
              className="dialog-text-input"
              onChange={(event) => props.onTitleChange(event.target.value)}
              placeholder="Enter session title..."
              type="text"
              value={props.title}
            />
          </div>
        </div>

        <div className="dialog-actions">
          <button
            className="ghost-button"
            disabled={props.isWorking}
            onClick={props.onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={props.isWorking || !hasTitle}
            onClick={props.onConfirm}
            type="button"
          >
            Save Title
          </button>
        </div>
      </div>
    </div>
  );
}

function SanitizedCopyDialog(props: {
  canReAddToCurrentDay: boolean;
  chatName: string;
  createJsonlCopy: boolean;
  isWorking: boolean;
  onChatNameChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  onCreateJsonlCopyChange: (value: boolean) => void;
  onReAddToCurrentDayChange: (value: boolean) => void;
  onStripBlobContentChange: (value: boolean) => void;
  reAddToCurrentDayDisabledReason: string | null;
  stripImageContent: boolean;
  stripBlobContent: boolean;
  reAddToCurrentDay: boolean;
}) {
  const hasOutputSelected =
    props.createJsonlCopy || (props.reAddToCurrentDay && props.chatName.trim().length > 0);

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        aria-modal="true"
        className="export-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="export-dialog-header">
          <div>
            <span className="dialog-kicker">Session sanitization</span>
            <h3>Sanitize Session</h3>
            <p>Choose where codlogs should write the derived sanitized session outputs.</p>
          </div>
          <button
            aria-label="Close sanitization dialog"
            className="dialog-close"
            onClick={props.onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="export-dialog-options">
          <div className="dialog-field">
            <label className="dialog-field-label" htmlFor="sanitize-chat-name">
              Chat name
            </label>
            <p className="dialog-field-hint">
              Used for the re-added live session so it appears with a readable title instead of
              falling back to the rollout filename.
            </p>
            <input
              id="sanitize-chat-name"
              className="dialog-text-input"
              onChange={(event) => props.onChatNameChange(event.target.value)}
              placeholder="Enter chat name..."
              type="text"
              value={props.chatName}
            />
          </div>

          <label className="dialog-option dialog-option-disabled">
            <input checked={props.stripImageContent} disabled type="checkbox" />
            <span className="dialog-option-copy">
              <strong>Strip image content</strong>
              <small>
                The current sanitization flow rebuilds a text-only copy, so image payloads are
                always removed.
              </small>
            </span>
          </label>

          <label className="dialog-option">
            <input
              checked={props.stripBlobContent}
              onChange={(event) => props.onStripBlobContentChange(event.target.checked)}
              type="checkbox"
            />
            <span className="dialog-option-copy">
              <strong>Strip all blobs</strong>
              <small>
                Aggressively removes oversized tool payloads, encrypted reasoning blobs,
                token-count metadata, and bulky turn-context instruction dumps. This shrinks the
                copy further, but it is more compatibility-risky than image stripping alone.
              </small>
            </span>
          </label>

          <label className="dialog-option">
            <input
              checked={props.createJsonlCopy}
              onChange={(event) => props.onCreateJsonlCopyChange(event.target.checked)}
              type="checkbox"
            />
            <span className="dialog-option-copy">
              <strong>Create new JSONL copy file</strong>
              <small>
                Write a sanitized JSONL copy while preserving the source file's original line
                order.
              </small>
            </span>
          </label>

          <label
            className={`dialog-option ${!props.canReAddToCurrentDay ? "dialog-option-disabled" : ""}`}
          >
            <input
              disabled={!props.canReAddToCurrentDay}
              checked={props.reAddToCurrentDay}
              onChange={(event) => props.onReAddToCurrentDayChange(event.target.checked)}
              type="checkbox"
            />
            <span className="dialog-option-copy">
              <strong>Re-add session to current day</strong>
              <small>
                Create an additional canonical rollout file inside today&apos;s Codex
                `sessions/YYYY/MM/DD` folder with a fresh thread ID in both the filename and
                `session_meta`.
              </small>
              {!props.canReAddToCurrentDay && props.reAddToCurrentDayDisabledReason && (
                <small>{props.reAddToCurrentDayDisabledReason}</small>
              )}
              {props.canReAddToCurrentDay && props.reAddToCurrentDay && !props.chatName.trim() && (
                <small>Please enter a chat name before re-adding the session.</small>
              )}
            </span>
          </label>

          <div className="dialog-warning">
            <strong>Compatibility note</strong>
            <p>
              Opaque compaction rows are preserved in the JSONL output. The copy is still derived,
              not a byte-for-byte rewrite of the source session. The blob-stripping option is the
              most aggressive mode.
            </p>
          </div>
        </div>

        <div className="dialog-destination">
          <span className="dialog-destination-label">Destination</span>
          <strong>
            {props.createJsonlCopy && props.reAddToCurrentDay
              ? "Temporary output folder plus today's Codex sessions folder"
              : props.reAddToCurrentDay
                ? "Today's Codex sessions folder"
                : "Temporary output folder"}
          </strong>
          <p>
            {props.reAddToCurrentDay
              ? "codlogs leaves the source session unchanged, keeps the report in a temp folder, and can also place a fresh canonical rollout file into today's live Codex session tree."
              : "codlogs writes all sanitization artifacts into a fresh temp subfolder and leaves the source session unchanged."}
          </p>
        </div>

        <div className="dialog-actions">
          <button className="ghost-button" onClick={props.onClose} type="button">
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={props.isWorking || !hasOutputSelected}
            onClick={props.onConfirm}
            type="button"
          >
            Create Sanitized Output
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
