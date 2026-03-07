import { Electroview } from "electrobun/view";
import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import type {
  FindCodexSessionsResult,
  SessionDetailMetrics,
  SessionMetaMatch,
} from "../shared/codlogs-core.ts";
import type { CodexerRPC } from "../shared/rpc.ts";

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

type ExportFormat = "markdown" | "html";

type ExportDialogState = {
  format: ExportFormat;
};

type SessionDetailMetricsState = {
  kind: "idle" | "loading" | "ready" | "error";
  interactionCount: number | null;
  toolCallCount: number | null;
  fileSizeBytes: number | null;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

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
  interactionCount: number | null,
  toolCallCount: number | null,
): string {
  if (interactionCount === null || toolCallCount === null) {
    return "Loading...";
  }

  const promptLabel = `${interactionCount} ${interactionCount === 1 ? "prompt" : "prompts"}`;
  const toolCallLabel = `${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`;
  return `${promptLabel} / ${toolCallLabel}`;
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
      interactionCount: null,
      toolCallCount: null,
      fileSizeBytes: null,
    });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState>({
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
  const codexHomeRef = useRef(codexHome);
  const folderPathRef = useRef(folderPath);
  const loadRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const exportRequestIdRef = useRef(0);
  const activeExportJobIdRef = useRef<string | null>(null);
  const initialWindowRefreshDoneRef = useRef(false);
  const [exportCancelPending, setExportCancelPending] = useState(false);

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
        interactionCount: null,
        toolCallCount: null,
        fileSizeBytes: null,
      });
      return;
    }

    if (activeSessionDetailMetrics) {
      setSessionDetailMetricsState({
        kind: "ready",
        interactionCount: activeSessionDetailMetrics.interactionCount,
        toolCallCount: activeSessionDetailMetrics.toolCallCount,
        fileSizeBytes: activeSessionDetailMetrics.fileSizeBytes,
      });
      return;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setSessionDetailMetricsState({
      kind: "loading",
      interactionCount: null,
      toolCallCount: null,
      fileSizeBytes: null,
    });

    void (async () => {
      try {
        const metrics = await getRpc().request.getSessionDetailMetrics({
          sessionFilePath: activeSession.file,
        });

        if (requestId !== detailRequestIdRef.current) {
          return;
        }

        setSessionDetailMetricsByFile((current) => ({
          ...current,
          [activeSession.file]: metrics,
        }));
        setSessionDetailMetricsState({
          kind: "ready",
          interactionCount: metrics.interactionCount,
          toolCallCount: metrics.toolCallCount,
          fileSizeBytes: metrics.fileSizeBytes,
        });
      } catch {
        if (requestId !== detailRequestIdRef.current) {
          return;
        }

        setSessionDetailMetricsState({
          kind: "error",
          interactionCount: null,
          toolCallCount: null,
          fileSizeBytes: null,
        });
      }
    })();
  }, [activeSession, activeSessionDetailMetrics]);

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
    } catch (loadError) {
      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setError(asErrorMessage(loadError));
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

  async function submitExportDialog(): Promise<void> {
    if (!exportDialog) {
      return;
    }

    const { format } = exportDialog;
    setExportDialog(null);
    await exportActiveSession(format);
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
                  <button
                    key={session.file}
                    className={`session-card ${session.file === activeSession?.file ? "selected" : ""}`}
                    onClick={() => setSelectedFile(session.file)}
                  >
                    <div className="session-card-header">
                      <span className={`kind-badge kind-${session.kind}`}>{session.kind}</span>
                      <span className="session-time">{formatTimestamp(session.updatedAt ?? session.startedAt)}</span>
                    </div>
                    <span className="session-title">{getSessionTitle(session)}</span>
                    <span className="session-cwd">{session.cwd}</span>
                  </button>
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
                  <div className="filter-actions">
                    <button className="ghost-button" onClick={() => void revealPath(activeSession.file)}>
                      Reveal JSONL
                    </button>
                    <button
                      className="primary-button"
                      disabled={exportState.kind === "working"}
                      onClick={() => openExportDialog("markdown")}
                    >
                      Export Markdown
                    </button>
                    <button
                      className="primary-button"
                      disabled={exportState.kind === "working"}
                      onClick={() => openExportDialog("html")}
                    >
                      Export HTML
                    </button>
                  </div>
                </div>

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
                    value={
                      sessionDetailMetricsState.kind === "error"
                        ? "Unavailable"
                        : formatInteractionSummary(
                            sessionDetailMetricsState.interactionCount,
                            sessionDetailMetricsState.toolCallCount,
                          )
                    }
                  />
                  <MetaItem
                    label="File Size"
                    value={
                      sessionDetailMetricsState.kind === "error"
                        ? "Unavailable"
                        : formatFileSize(sessionDetailMetricsState.fileSizeBytes)
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
          includeImages={exportImages}
          includeToolCallResults={exportToolCallResults}
          inlineImages={exportInlineImages}
          isWorking={exportState.kind === "working"}
          onClose={() => setExportDialog(null)}
          onConfirm={() => void submitExportDialog()}
          onIncludeImagesChange={setExportImages}
          onIncludeToolCallResultsChange={setExportToolCallResults}
          onInlineImagesChange={setExportInlineImages}
        />
      )}
      {exportState.kind === "working" && (
        <ExportProgressDialog
          cancelPending={exportCancelPending}
          message={exportState.message}
          onCancel={() => void cancelActiveExport()}
          progressPercent={exportState.progressPercent}
          sessionTitle={activeSession ? getSessionTitle(activeSession) : "Selected session"}
          stage={exportState.stage}
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

function ExportDialog(props: {
  format: ExportFormat;
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
          <label className="dialog-option">
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
  message: string;
  onCancel: () => void;
  progressPercent: number;
  sessionTitle: string;
  stage: string;
}) {
  const clampedProgress = Math.max(4, Math.min(100, props.progressPercent));

  return (
    <div className="dialog-backdrop">
      <div aria-modal="true" className="export-progress-dialog" role="dialog">
        <div className="export-progress-header">
          <div>
            <span className="dialog-kicker">Export in progress</span>
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
          <span>{props.cancelPending ? "Stopping export..." : "Processing large session files can take a few seconds."}</span>
        </div>

        <div className="dialog-actions">
          <button
            className="ghost-button"
            disabled={props.cancelPending}
            onClick={props.onCancel}
            type="button"
          >
            {props.cancelPending ? "Cancelling..." : "Cancel Export"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
