import { Electroview } from "electrobun/view";
import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import type {
  FindCodexSessionsResult,
  SessionMetaMatch,
} from "../shared/codex-core.ts";
import type { CodexerRPC } from "../shared/rpc.ts";

type BrowseMode = "all" | "folder";

type AppliedQuery = {
  browseMode: BrowseMode;
  targetDirectory: string | null;
  cwdOnly: boolean;
};

type ExportState = {
  kind: "idle" | "working" | "success" | "error";
  message: string;
  outputPath: string | null;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const RPC_MAX_REQUEST_TIME_MS = 15 * 60 * 1000;

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

function App() {
  const [result, setResult] = useState<FindCodexSessionsResult | null>(null);
  const [codexHome, setCodexHome] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [cwdOnly, setCwdOnly] = useState(false);
  const [appliedQuery, setAppliedQuery] = useState<AppliedQuery>({
    browseMode: "folder",
    targetDirectory: "",
    cwdOnly: false,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState>({
    kind: "idle",
    message: "",
    outputPath: null,
  });
  const [exportImages, setExportImages] = useState(false);
  const [exportToolCallResults, setExportToolCallResults] = useState(false);
  const codexHomeRef = useRef(codexHome);
  const folderPathRef = useRef(folderPath);
  const loadRequestIdRef = useRef(0);
  const exportRequestIdRef = useRef(0);
  const initialWindowRefreshDoneRef = useRef(false);

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const deferredFolderPath = useDeferredValue(folderPath);

  useEffect(() => {
    void loadSessions("", "folder");
  }, []);

  useEffect(() => {
    codexHomeRef.current = codexHome;
  }, [codexHome]);

  useEffect(() => {
    folderPathRef.current = folderPath;
  }, [folderPath]);

  const filteredSessions = (result?.sessions ?? []).filter((session) =>
    matchesSearch(session, deferredSearchQuery),
  );
  const activeSession =
    filteredSessions.find((session) => session.file === selectedFile) ??
    filteredSessions[0] ??
    null;

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

  async function loadSessions(
    targetDirectory: string | null,
    nextBrowseMode: BrowseMode,
    nextCwdOnly = cwdOnly,
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
      });

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setResult(nextResult);
      setAppliedQuery({
        browseMode: nextBrowseMode,
        targetDirectory,
        cwdOnly: nextCwdOnly,
      });
      if (!codexHomeRef.current.trim()) {
        setCodexHome(nextResult.codexHome);
      }
      if (!folderPathRef.current.trim()) {
        setFolderPath(nextResult.currentWorkingDirectory);
      }
      if (targetDirectory !== null && nextResult.requestedDirectory) {
        setFolderPath(nextResult.requestedDirectory);
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
      void loadSessions(path, "folder", cwdOnly);
    } catch (pickError) {
      setError(asErrorMessage(pickError));
    }
  }

  async function exportActiveSessionMarkdown(): Promise<void> {
    await exportActiveSession("markdown");
  }

  async function exportActiveSessionHtml(): Promise<void> {
    await exportActiveSession("html");
  }

  async function exportActiveSession(format: "markdown" | "html"): Promise<void> {
    if (!activeSession) {
      return;
    }

    const exportRequestId = exportRequestIdRef.current + 1;
    exportRequestIdRef.current = exportRequestId;
    let outputDirectory: string | null = null;

    try {
      const response = await getRpc().request.pickExportDirectory({
        sessionFilePath: activeSession.file,
      });
      outputDirectory = response.path;
    } catch (pickError) {
      setExportState({
        kind: "error",
        message: asErrorMessage(pickError),
        outputPath: null,
      });
      return;
    }

    if (!outputDirectory) {
      setExportState({
        kind: "idle",
        message: "Export cancelled.",
        outputPath: null,
      });
      return;
    }

    const label = format === "markdown" ? "Markdown" : "HTML";

    setExportState({
      kind: "working",
      message: `Creating ${label} export...`,
      outputPath: null,
    });

    try {
      if (format === "markdown") {
        const { outputPath } = await getRpc().request.exportSessionMarkdown({
          sessionFilePath: activeSession.file,
          includeImages: exportImages,
          includeToolCallResults: exportToolCallResults,
          outputDirectory,
        });

        if (exportRequestId !== exportRequestIdRef.current) {
          return;
        }

        setExportState({
          kind: "success",
          message: `${label} written to ${outputPath}`,
          outputPath,
        });
        return;
      }

      const { jobId } = await getRpc().request.startSessionHtmlExport({
        sessionFilePath: activeSession.file,
        includeImages: exportImages,
        includeToolCallResults: exportToolCallResults,
        outputDirectory,
      });

      while (exportRequestId === exportRequestIdRef.current) {
        const status = await getRpc().request.getExportJobStatus({ jobId });
        if (exportRequestId !== exportRequestIdRef.current) {
          return;
        }

        setExportState(status);
        if (status.kind !== "working") {
          return;
        }

        await delay(400);
      }
    } catch (exportError) {
      if (exportRequestId !== exportRequestIdRef.current) {
        return;
      }

      setExportState({
        kind: "error",
        message: asErrorMessage(exportError),
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
    void loadSessions(getRequestedFolderTarget(deferredFolderPath), "folder", cwdOnly);
  }

  function handleRefresh(): void {
    void loadSessions(
      appliedQuery.targetDirectory,
      appliedQuery.browseMode,
      appliedQuery.cwdOnly,
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
              Browse and export your Codex sessions with ease.
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
        </section>

        <section className="content-grid">
          <aside className="panel">
            <div className="panel-header">
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
                <h2>Sessions</h2>
                <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
                  {filteredSessions.length} {filteredSessions.length === 1 ? "match" : "matches"}
                </span>
              </div>
              <div className="search-container compact" style={{ height: "2.2rem", flex: "0 0 150px" }}>
                <input
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                  }}
                  placeholder="Search..."
                  style={{ fontSize: "0.85rem" }}
                />
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
                    <button className="primary-button" onClick={() => void exportActiveSessionMarkdown()}>
                      Export Markdown
                    </button>
                    <button className="primary-button" onClick={() => void exportActiveSessionHtml()}>
                      Export HTML
                    </button>
                  </div>
                </div>

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
                  <MetaItem label="Working Directory" value={activeSession.cwd} />
                  <MetaItem label="Source File" value={formatDisplayPath(activeSession.file)} />
                </div>

                <div className="export-section">
                  <h3>Export Options</h3>
                  <div className="export-options">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={exportImages}
                        onChange={(event) => setExportImages(event.target.checked)}
                      />
                      <span>Include captured images</span>
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={exportToolCallResults}
                        onChange={(event) => setExportToolCallResults(event.target.checked)}
                      />
                      <span>Include tool calls and results</span>
                    </label>
                  </div>

                  <div className={`status-banner status-${exportState.kind}`}>
                    <div className="status-info">
                      <strong>
                        {exportState.kind === "idle" ? "Ready to export" :
                         exportState.kind === "working" ? "Exporting..." :
                         exportState.kind === "success" ? "Export complete" : "Export failed"}
                      </strong>
                      <p>{exportState.message || "Select options and click Export Markdown or Export HTML to begin."}</p>
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

export default App;
