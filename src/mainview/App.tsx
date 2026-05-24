import { Electroview } from "electrobun/view";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  FindCodexSessionsResult,
  SessionErroredToolCallPattern,
  SessionDetailMetrics,
  SessionMetaMatch,
  SessionTokenUsage,
  SessionTranscriptEntry,
  SessionTranscriptResult,
} from "../shared/codlogs-core.ts";
import type {
  CodexerRPC,
  EnvironmentCapabilities,
  ErroredToolCallSummaryJobStatus,
  ErroredToolCallSummaryResult,
  TokenUsageSummaryJobStatus,
  TokenUsageSummaryResult,
} from "../shared/rpc.ts";
import { sanitizeSessionTitleInput } from "../shared/session-title.ts";

type BrowseMode = "all" | "folder";

type AppliedQuery = {
  browseMode: BrowseMode;
  targetDirectory: string | null;
  cwdOnly: boolean;
  includeCrossSessionWrites: boolean;
  dateFrom: string;
  dateTo: string;
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

type SummaryDialogState = {
  sessionFilePaths: string[];
  sessionCount: number;
  fileSizeBytes: number;
};

type TokenUsageSummaryState =
  | { kind: "idle" }
  | TokenUsageSummaryJobStatus;

type ErroredToolCallSummaryState =
  | { kind: "idle" }
  | ErroredToolCallSummaryJobStatus;

type SummaryJobStatusBase<TResult> = {
  kind: "working" | "success" | "error" | "cancelled";
  progressPercent: number;
  stage: string;
  message: string;
  scannedSessionCount: number;
  totalSessionCount: number;
  currentSessionPath: string | null;
  result: TResult | null;
};

type SummaryJobState<TStatus extends SummaryJobStatusBase<unknown>> =
  | { kind: "idle" }
  | TStatus;

type SummarySessionSource = {
  file: string;
  fileSizeBytes: number;
};

type SessionBrowserState =
  | { kind: "idle" }
  | {
      kind: "loading";
      session: SessionMetaMatch;
    }
  | {
      kind: "ready";
      session: SessionMetaMatch;
      transcript: SessionTranscriptResult;
    }
  | {
      kind: "error";
      session: SessionMetaMatch;
      errorMessage: string;
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
const tokenCountFormatter = new Intl.NumberFormat(undefined);

const LARGE_SESSION_WARNING_BYTES = 64 * 1024 * 1024;
const RPC_MAX_REQUEST_TIME_MS = 15 * 60 * 1000;
const REPOSITORY_URL = "https://github.com/tobitege/codlogs";
const SESSION_BROWSER_MAX_ENTRIES = 10000;

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

function formatTokenCount(value: number): string {
  return tokenCountFormatter.format(value);
}

function getUncachedInputTokens(tokenUsage: SessionTokenUsage): number {
  return Math.max(0, tokenUsage.inputTokens - tokenUsage.cachedInputTokens);
}

type SummaryTextField = {
  label: string;
  value: string;
};

type ErroredToolCallSummarySections = {
  totals: SummaryTextField[];
  patterns: Array<{
    title: string;
    fields: SummaryTextField[];
    input: string;
    sampleOutput: string;
  }>;
};

function formatTokenUsageForClipboard(
  sessionTitle: string,
  tokenUsage: SessionTokenUsage,
): string {
  return [
    `Session: ${sessionTitle}`,
    `Total tokens: ${tokenUsage.totalTokens}`,
    `Input tokens: ${tokenUsage.inputTokens}`,
    `Cached input tokens: ${tokenUsage.cachedInputTokens}`,
    `Uncached input tokens: ${getUncachedInputTokens(tokenUsage)}`,
    `Output tokens: ${tokenUsage.outputTokens}`,
    `Reasoning output tokens: ${tokenUsage.reasoningOutputTokens}`,
  ].join("\n");
}

function formatTokenUsageSummaryForClipboard(
  summary: TokenUsageSummaryResult,
): string {
  return [
    "Filtered sessions token summary",
    `Sessions: ${summary.sessionCount}`,
    `Scanned sessions: ${summary.scannedSessionCount}`,
    `Sessions with token usage: ${summary.sessionsWithTokenUsage}`,
    `Sessions without token usage: ${summary.sessionsWithoutTokenUsage}`,
    `Failed sessions: ${summary.failedSessionCount}`,
    `Total file size: ${summary.fileSizeBytes}`,
    `Oversized JSONL rows: ${summary.oversizedLineCount}`,
    "",
    `Total tokens: ${summary.tokenUsage.totalTokens}`,
    `Input tokens: ${summary.tokenUsage.inputTokens}`,
    `Cached input tokens: ${summary.tokenUsage.cachedInputTokens}`,
    `Uncached input tokens: ${getUncachedInputTokens(summary.tokenUsage)}`,
    `Output tokens: ${summary.tokenUsage.outputTokens}`,
    `Reasoning output tokens: ${summary.tokenUsage.reasoningOutputTokens}`,
  ].join("\n");
}

function buildErroredToolCallSummarySections(
  summary: ErroredToolCallSummaryResult,
): ErroredToolCallSummarySections {
  return {
    totals: [
      { label: "Sessions scanned", value: `${summary.scannedSessionCount} / ${summary.sessionCount}` },
      {
        label: "Sessions with errored tool calls",
        value: String(summary.sessionsWithErroredToolCalls),
      },
      {
        label: "Sessions without errored tool calls",
        value: String(summary.sessionsWithoutErroredToolCalls),
      },
      { label: "Failed sessions", value: String(summary.failedSessionCount) },
      { label: "Errored tool calls", value: String(summary.erroredToolCallCount) },
      {
        label: "Distinct errored tool calls",
        value: String(summary.distinctErroredToolCalls.length),
      },
      { label: "Tool call rows", value: String(summary.toolCallRows) },
      { label: "Tool output rows", value: String(summary.toolOutputRows) },
      { label: "Oversized JSONL rows", value: String(summary.oversizedLineCount) },
    ],
    patterns: summary.distinctErroredToolCalls.map((pattern) => ({
      title: pattern.toolName,
      fields: [
        { label: "Kind", value: pattern.callKind },
        { label: "Occurrences", value: String(pattern.occurrences) },
        { label: "Sessions", value: String(pattern.sessionCount) },
        { label: "Error kind", value: pattern.errorKind },
        { label: "Exit code", value: String(pattern.exitCode ?? "n/a") },
        { label: "First seen", value: pattern.firstTimestamp ?? "unknown" },
        { label: "Last seen", value: pattern.lastTimestamp ?? "unknown" },
        { label: "Error", value: pattern.errorPattern },
      ],
      input: pattern.argumentsPreview || "(empty)",
      sampleOutput: pattern.sampleOutput || "(empty)",
    })),
  };
}

function formatErroredToolCallSummaryForClipboard(
  summary: ErroredToolCallSummaryResult,
): string {
  const sections = buildErroredToolCallSummarySections(summary);
  const lines = ["Filtered sessions tool error summary"];
  for (const total of sections.totals) {
    lines.push(`${total.label}: ${total.value}`);
  }
  lines.push("");

  for (const pattern of sections.patterns) {
    lines.push(
      `${pattern.title} (${pattern.fields.find((field) => field.label === "Kind")?.value ?? "unknown"})`,
      `Occurrences: ${pattern.fields.find((field) => field.label === "Occurrences")?.value ?? "0"}`,
      `Sessions: ${pattern.fields.find((field) => field.label === "Sessions")?.value ?? "0"}`,
      `Error: ${pattern.fields.find((field) => field.label === "Error")?.value ?? ""}`,
      `Input: ${pattern.input}`,
      `Sample output: ${pattern.sampleOutput}`,
      "",
    );
  }

  return lines.join("\n").trimEnd();
}

function formatMarkdownCodeBlock(value: string, language = "text"): string {
  const content = value || "(empty)";
  const longestFenceRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestFenceRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

function formatErroredToolCallSummaryAsMarkdown(
  summary: ErroredToolCallSummaryResult,
): string {
  const sections = buildErroredToolCallSummarySections(summary);
  const lines = [
    "# codlogs Tool Error Summary",
    "",
    "## Totals",
    "",
    ...sections.totals.map((total) => `- ${total.label}: ${total.value}`),
    "",
    "## Distinct Error Patterns",
    "",
  ];

  if (sections.patterns.length === 0) {
    lines.push("No errored tool calls found.", "");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  sections.patterns.forEach((pattern, index) => {
    lines.push(
      `### ${index + 1}. ${pattern.title}`,
      "",
      ...pattern.fields.map((field) => `- ${field.label}: ${field.value}`),
      "",
      "Input:",
      "",
      formatMarkdownCodeBlock(pattern.input),
      "",
      "Sample output:",
      "",
      formatMarkdownCodeBlock(pattern.sampleOutput),
      "",
    );
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

function buildSummaryFileName(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
  return `${prefix}-${timestamp}.md`;
}

function getSingleRepoSummaryFilePrefix(
  result: FindCodexSessionsResult | null,
  sessionCount: number,
): string {
  if (sessionCount > 0 && result?.scopeMode === "repo" && result.targetRoot) {
    return `${basename(result.targetRoot)}-tool-error-summary`;
  }

  return "codlogs-tool-error-summary";
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

function GitHubMark(props: { className?: string }): ReactElement {
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

function useSummaryJob<
  TResult,
  TStatus extends SummaryJobStatusBase<TResult>,
>(options: {
  startJob: (sessionFilePaths: string[]) => Promise<{ jobId: string }>;
  getJobStatus: (jobId: string) => Promise<TStatus>;
  cancelJob: (jobId: string) => Promise<{ ok: boolean }>;
  buildStartingMessage: (sessionCount: number) => string;
  cancellingMessage: string;
}) {
  const [dialog, setDialog] = useState<SummaryDialogState | null>(null);
  const [state, setState] = useState<SummaryJobState<TStatus>>({ kind: "idle" });
  const [cancelPending, setCancelPending] = useState(false);
  const requestIdRef = useRef(0);
  const activeJobIdRef = useRef<string | null>(null);

  function open(sessionSources: SummarySessionSource[]): void {
    if (sessionSources.length === 0 || state.kind === "working") {
      return;
    }

    setState({ kind: "idle" });
    setCancelPending(false);
    setDialog({
      sessionFilePaths: sessionSources.map((session) => session.file),
      sessionCount: sessionSources.length,
      fileSizeBytes: sessionSources.reduce(
        (total, session) => total + session.fileSizeBytes,
        0,
      ),
    });
  }

  function close(): void {
    if (state.kind === "working") {
      return;
    }

    requestIdRef.current += 1;
    activeJobIdRef.current = null;
    setCancelPending(false);
    setDialog(null);
    setState({ kind: "idle" });
  }

  async function start(): Promise<void> {
    if (!dialog || state.kind === "working") {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    activeJobIdRef.current = null;
    setCancelPending(false);
    setState({
      kind: "working",
      progressPercent: 1,
      stage: "starting",
      message: options.buildStartingMessage(dialog.sessionCount),
      scannedSessionCount: 0,
      totalSessionCount: dialog.sessionCount,
      currentSessionPath: null,
      result: null,
    } as TStatus);

    try {
      const { jobId } = await options.startJob(dialog.sessionFilePaths);
      activeJobIdRef.current = jobId;

      while (requestId === requestIdRef.current && activeJobIdRef.current) {
        const activeJobId = activeJobIdRef.current;
        if (!activeJobId) {
          break;
        }

        const status = await options.getJobStatus(activeJobId);
        if (requestId !== requestIdRef.current) {
          return;
        }

        setState(status);
        if (status.kind !== "working") {
          activeJobIdRef.current = null;
          setCancelPending(false);
          return;
        }

        await delay(400);
      }
    } catch (summaryError) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      activeJobIdRef.current = null;
      setCancelPending(false);
      setState({
        kind: "error",
        progressPercent: 0,
        stage: "error",
        message: asErrorMessage(summaryError),
        scannedSessionCount: 0,
        totalSessionCount: dialog.sessionCount,
        currentSessionPath: null,
        result: null,
      } as TStatus);
    }
  }

  async function cancel(): Promise<void> {
    const jobId = activeJobIdRef.current;
    if (!jobId || cancelPending) {
      return;
    }

    setCancelPending(true);
    setState((current) =>
      current.kind === "working"
        ? {
            ...current,
            message: options.cancellingMessage,
          }
        : current,
    );

    try {
      await options.cancelJob(jobId);
    } catch (cancelError) {
      setCancelPending(false);
      setState({
        kind: "error",
        progressPercent: 0,
        stage: "error",
        message: asErrorMessage(cancelError),
        scannedSessionCount: 0,
        totalSessionCount: dialog?.sessionCount ?? 0,
        currentSessionPath: null,
        result: null,
      } as TStatus);
    }
  }

  return {
    cancel,
    cancelPending,
    close,
    dialog,
    open,
    start,
    state,
  };
}

function useTimedActionState<TState extends string>(
  initialState: TState,
  resetDelayMs: number,
): [TState, (state: TState) => void, (state: TState) => void] {
  const [state, setState] = useState<TState>(initialState);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  function setImmediateState(nextState: TState): void {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setState(nextState);
  }

  function setTemporaryState(nextState: TState): void {
    setState(nextState);
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(() => {
      setState(initialState);
      resetTimerRef.current = null;
    }, resetDelayMs);
  }

  return [state, setImmediateState, setTemporaryState];
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
    dateFrom: "",
    dateTo: "",
  });
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
  const [showTokenUsageDialog, setShowTokenUsageDialog] = useState(false);
  const [sessionBrowser, setSessionBrowser] = useState<SessionBrowserState>({ kind: "idle" });
  const sessionBrowserRequestIdRef = useRef(0);
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

  const tokenUsageSummaryJob = useSummaryJob<
    TokenUsageSummaryResult,
    TokenUsageSummaryJobStatus
  >({
    startJob: (sessionFilePaths) =>
      getRpc().request.startTokenUsageSummary({ sessionFilePaths }),
    getJobStatus: (jobId) =>
      getRpc().request.getTokenUsageSummaryJobStatus({ jobId }),
    cancelJob: (jobId) =>
      getRpc().request.cancelTokenUsageSummaryJob({ jobId }),
    buildStartingMessage: (sessionCount) =>
      `Preparing ${sessionCount} session${sessionCount === 1 ? "" : "s"}...`,
    cancellingMessage: "Cancelling token summary...",
  });
  const erroredToolCallSummaryJob = useSummaryJob<
    ErroredToolCallSummaryResult,
    ErroredToolCallSummaryJobStatus
  >({
    startJob: (sessionFilePaths) =>
      getRpc().request.startErroredToolCallSummary({ sessionFilePaths }),
    getJobStatus: (jobId) =>
      getRpc().request.getErroredToolCallSummaryJobStatus({ jobId }),
    cancelJob: (jobId) =>
      getRpc().request.cancelErroredToolCallSummaryJob({ jobId }),
    buildStartingMessage: (sessionCount) =>
      `Preparing ${sessionCount} session${sessionCount === 1 ? "" : "s"}...`,
    cancellingMessage: "Cancelling tool error summary...",
  });

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
    if (sessionBrowser.kind === "idle") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSessionBrowser();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sessionBrowser.kind]);

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
  const filteredLiveCount = filteredSessions.filter((session) => session.kind === "live").length;
  const filteredArchivedCount = filteredSessions.length - filteredLiveCount;
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
    nextDateFrom = dateFrom,
    nextDateTo = dateTo,
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
        dateFrom: nextDateFrom || null,
        dateTo: nextDateTo || null,
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
        dateFrom: nextDateFrom,
        dateTo: nextDateTo,
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
      void loadSessions(path, "folder", cwdOnly, includeCrossSessionWrites, dateFrom, dateTo);
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

  async function openSessionBrowser(session: SessionMetaMatch): Promise<void> {
    const requestId = sessionBrowserRequestIdRef.current + 1;
    sessionBrowserRequestIdRef.current = requestId;
    setSessionBrowser({ kind: "loading", session });

    try {
      const transcript = await getRpc().request.getSessionTranscript({
        sessionFilePath: session.file,
        maxEntries: SESSION_BROWSER_MAX_ENTRIES,
      });

      if (requestId !== sessionBrowserRequestIdRef.current) {
        return;
      }

      setSessionBrowser({ kind: "ready", session, transcript });
    } catch (transcriptError) {
      if (requestId !== sessionBrowserRequestIdRef.current) {
        return;
      }

      setSessionBrowser({
        kind: "error",
        session,
        errorMessage: asErrorMessage(transcriptError),
      });
    }
  }

  function closeSessionBrowser(): void {
    sessionBrowserRequestIdRef.current += 1;
    setSessionBrowser({ kind: "idle" });
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
        appliedQuery.dateFrom,
        appliedQuery.dateTo,
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
              appliedQuery.dateFrom,
              appliedQuery.dateTo,
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

  function openTokenUsageSummaryDialog(): void {
    tokenUsageSummaryJob.open(filteredSessions);
  }

  function openErroredToolCallSummaryDialog(): void {
    erroredToolCallSummaryJob.open(filteredSessions);
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
    void loadSessions(null, "all", cwdOnly, includeCrossSessionWrites, dateFrom, dateTo);
  }

  function handleFilterByFolder(): void {
    void loadSessions(
      getRequestedFolderTarget(folderPath),
      "folder",
      cwdOnly,
      includeCrossSessionWrites,
      dateFrom,
      dateTo,
    );
  }

  function handleRefresh(): void {
    void loadSessions(
      appliedQuery.targetDirectory,
      appliedQuery.browseMode,
      appliedQuery.cwdOnly,
      appliedQuery.includeCrossSessionWrites,
      appliedQuery.dateFrom,
      appliedQuery.dateTo,
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
            <button
              aria-label="Summarize token usage for filtered sessions"
              className="hero-token-button"
              disabled={loading || filteredSessions.length === 0}
              onClick={openTokenUsageSummaryDialog}
              title="Summarize filtered session tokens"
              type="button"
            >
              <span aria-hidden="true">Σ</span>
            </button>
            <button
              aria-label="Summarize errored tool calls for filtered sessions"
              className="hero-token-button"
              disabled={loading || filteredSessions.length === 0}
              onClick={openErroredToolCallSummaryDialog}
              title="Summarize filtered session tool errors"
              type="button"
            >
              <span aria-hidden="true">!</span>
            </button>
            <div className="stat-card">
              <span className="stat-label">Sessions</span>
              <span className="stat-value">{result ? filteredSessions.length : 0}</span>
              <span className="stat-detail">{result ? `${filteredLiveCount} live / ${filteredArchivedCount} archived` : "Scanning..."}</span>
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
            <div className="date-filter-group" aria-label="Filter sessions by date range">
              <label className="date-filter-field">
                <span>From</span>
                <input
                  type="date"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(event) => setDateFrom(event.target.value)}
                />
              </label>
              <label className="date-filter-field">
                <span>To</span>
                <input
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(event) => setDateTo(event.target.value)}
                />
              </label>
            </div>
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
                      aria-label="Open session browser"
                      className="session-browser-button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void openSessionBrowser(session);
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                      }}
                      title="Open chat replay"
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
                          d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H13l-3.6 3.2A.75.75 0 0 1 8 18.64V16H6.5A2.5 2.5 0 0 1 4 13.5v-7Z"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.7"
                        />
                      </svg>
                    </button>
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
                    <button
                      aria-label="Show token usage"
                      className="ghost-button icon-button token-button"
                      onClick={() => setShowTokenUsageDialog(true)}
                      title="Token usage"
                      type="button"
                    >
                      <span aria-hidden="true" className="token-button-symbol">
                        Σ
                      </span>
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
      {showTokenUsageDialog && activeSession && (
        <TokenUsageDialog
          metricsState={sessionDetailMetricsState}
          onClose={() => setShowTokenUsageDialog(false)}
          sessionTitle={getSessionTitle(activeSession)}
        />
      )}
      {tokenUsageSummaryJob.dialog && (
        <TokenUsageSummaryDialog
          cancelPending={tokenUsageSummaryJob.cancelPending}
          fileSizeBytes={tokenUsageSummaryJob.dialog.fileSizeBytes}
          onCancel={() => void tokenUsageSummaryJob.cancel()}
          onClose={tokenUsageSummaryJob.close}
          onConfirm={() => void tokenUsageSummaryJob.start()}
          sessionCount={tokenUsageSummaryJob.dialog.sessionCount}
          state={tokenUsageSummaryJob.state}
        />
      )}
      {erroredToolCallSummaryJob.dialog && (
        <ErroredToolCallSummaryDialog
          cancelPending={erroredToolCallSummaryJob.cancelPending}
          fileSizeBytes={erroredToolCallSummaryJob.dialog.fileSizeBytes}
          onCancel={() => void erroredToolCallSummaryJob.cancel()}
          onClose={erroredToolCallSummaryJob.close}
          onConfirm={() => void erroredToolCallSummaryJob.start()}
          sessionCount={erroredToolCallSummaryJob.dialog.sessionCount}
          state={erroredToolCallSummaryJob.state}
          suggestedFileNamePrefix={getSingleRepoSummaryFilePrefix(
            result,
            erroredToolCallSummaryJob.dialog.sessionCount,
          )}
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
      {sessionBrowser.kind !== "idle" && (
        <SessionBrowserDialog
          onClose={closeSessionBrowser}
          state={sessionBrowser}
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

function TokenUsageDialog(props: {
  metricsState: SessionDetailMetricsState;
  onClose: () => void;
  sessionTitle: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const tokenUsage = props.metricsState.metrics?.tokenUsage ?? null;

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc" && event.code !== "Escape") {
        return;
      }

      event.preventDefault();
      props.onClose();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [props.onClose]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  const handleCopy = async (): Promise<void> => {
    if (!tokenUsage) {
      return;
    }

    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(
          formatTokenUsageForClipboard(props.sessionTitle, tokenUsage),
        );
        ok = true;
      }
    } catch {
      ok = false;
    }

    setCopyState(ok ? "copied" : "failed");
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => {
      setCopyState("idle");
      copyResetTimerRef.current = null;
    }, 1600);
  };

  const statusMessage =
    props.metricsState.kind === "loading"
      ? "Inspecting token counts..."
      : props.metricsState.kind === "error"
        ? props.metricsState.errorMessage ?? "Token usage is unavailable."
        : props.metricsState.metrics?.analysisKind === "skipped"
          ? "Token usage is unavailable until this session is analyzed."
          : "No token_count rows were found in this session.";

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        aria-modal="true"
        className="export-dialog token-usage-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="export-dialog-header">
          <div>
            <span className="dialog-kicker">Token usage</span>
            <h3>{props.sessionTitle}</h3>
            <p>Input, cached input, output, and reasoning token totals from the session log.</p>
          </div>
        </div>

        {tokenUsage ? (
          <div className="token-usage-grid">
            <TokenUsageStat label="Total" value={tokenUsage.totalTokens} />
            <TokenUsageStat label="Input" value={tokenUsage.inputTokens} />
            <TokenUsageStat label="Cached Input" value={tokenUsage.cachedInputTokens} />
            <TokenUsageStat
              label="Uncached Input"
              value={getUncachedInputTokens(tokenUsage)}
            />
            <TokenUsageStat
              label="Reasoning Output"
              value={tokenUsage.reasoningOutputTokens}
            />
            <TokenUsageStat label="Output" value={tokenUsage.outputTokens} />
          </div>
        ) : (
          <div className="dialog-warning dialog-warning-neutral">
            <strong>Token details unavailable</strong>
            <p>{statusMessage}</p>
          </div>
        )}

        <div className="dialog-actions token-dialog-actions">
          <button
            className="primary-button token-copy-button"
            disabled={!tokenUsage}
            onClick={() => void handleCopy()}
            type="button"
          >
            <CopyIcon className="button-icon" />
            <span>
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy Failed"
                  : "Copy"}
            </span>
          </button>
          <button className="ghost-button" onClick={props.onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryDialogShell<TResult>(props: {
  cancelPending: boolean;
  children: ReactNode;
  fileSizeBytes: number;
  idleDescription: string;
  idleMessage: string;
  idleTitle: string;
  kicker: string;
  onCancel: () => void;
  onClose: () => void;
  onConfirm: () => void;
  resultActions: ReactNode;
  sessionCount: number;
  state: { kind: "idle" } | SummaryJobStatusBase<TResult>;
  title: string;
  failureTitle: string;
  cancelledTitle: string;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const isWorking = props.state.kind === "working";
  const progressPercent =
    props.state.kind === "idle" ? 0 : Math.max(0, Math.min(100, props.state.progressPercent));
  const scannedSessionCount =
    props.state.kind === "idle" ? 0 : props.state.scannedSessionCount;
  const totalSessionCount =
    props.state.kind === "idle" ? props.sessionCount : props.state.totalSessionCount;
  const currentSessionPath =
    props.state.kind === "working" ? props.state.currentSessionPath : null;
  const statusMessage =
    props.state.kind === "idle" ? props.idleMessage : props.state.message;

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc" && event.code !== "Escape") {
        return;
      }

      if (isWorking) {
        return;
      }

      event.preventDefault();
      props.onClose();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isWorking, props.onClose]);

  return (
    <div
      className="dialog-backdrop"
      onClick={() => {
        if (!isWorking) {
          props.onClose();
        }
      }}
    >
      <div
        aria-modal="true"
        className="export-dialog token-summary-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="export-dialog-header">
          <div>
            <span className="dialog-kicker">{props.kicker}</span>
            <h3>{props.title}</h3>
            <p>{statusMessage}</p>
          </div>
        </div>

        <div className="token-summary-progress">
          <div className="export-progress-track" aria-hidden="true">
            <div
              className="export-progress-fill"
              style={{ width: `${Math.max(2, progressPercent)}%` }}
            />
          </div>
          <div className="token-summary-progress-meta">
            <span>{Math.round(progressPercent)}%</span>
            <span>
              {scannedSessionCount} / {totalSessionCount} sessions
            </span>
          </div>
        </div>

        <div className="token-summary-stats">
          <TokenSummaryStat label="Filtered Sessions" value={formatTokenCount(props.sessionCount)} />
          <TokenSummaryStat label="Approx. Size" value={formatFileSize(props.fileSizeBytes)} />
          <TokenSummaryStat
            label="Scanned"
            value={`${formatTokenCount(scannedSessionCount)} / ${formatTokenCount(totalSessionCount)}`}
          />
        </div>

        {props.state.kind === "idle" && (
          <div className="dialog-warning">
            <strong>{props.idleTitle}</strong>
            <p>{props.idleDescription}</p>
          </div>
        )}

        {props.state.kind === "working" && (
          <div className="dialog-warning dialog-warning-neutral">
            <strong>{props.cancelPending ? "Cancelling..." : "Scanning session logs"}</strong>
            <p>{currentSessionPath ? formatDisplayPath(currentSessionPath) : props.state.message}</p>
          </div>
        )}

        {props.children}

        {(props.state.kind === "error" || props.state.kind === "cancelled") && (
          <div className="dialog-warning">
            <strong>
              {props.state.kind === "cancelled" ? props.cancelledTitle : props.failureTitle}
            </strong>
            <p>{props.state.message}</p>
          </div>
        )}

        <div className="dialog-actions token-dialog-actions">
          {props.resultActions}
          <div className="token-summary-actions-right">
            {props.state.kind === "idle" && (
              <button className="ghost-button" onClick={props.onClose} type="button">
                Cancel
              </button>
            )}
            {props.state.kind === "idle" && (
              <button className="primary-button" onClick={props.onConfirm} type="button">
                Run Summary
              </button>
            )}
            {props.state.kind === "working" && (
              <button
                className="ghost-button"
                disabled={props.cancelPending}
                onClick={props.onCancel}
                type="button"
              >
                {props.cancelPending ? "Cancelling..." : "Cancel"}
              </button>
            )}
            {props.state.kind !== "idle" && props.state.kind !== "working" && (
              <button className="ghost-button" onClick={props.onClose} type="button">
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TokenUsageSummaryDialog(props: {
  cancelPending: boolean;
  fileSizeBytes: number;
  onCancel: () => void;
  onClose: () => void;
  onConfirm: () => void;
  sessionCount: number;
  state: TokenUsageSummaryState;
}) {
  const [copyState, , setCopyState] =
    useTimedActionState<"idle" | "copied" | "failed">("idle", 1600);
  const result = props.state.kind === "idle" ? null : props.state.result;

  const handleCopy = async (): Promise<void> => {
    if (!result) {
      return;
    }

    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(formatTokenUsageSummaryForClipboard(result));
        ok = true;
      }
    } catch {
      ok = false;
    }

    setCopyState(ok ? "copied" : "failed");
  };

  return (
    <SummaryDialogShell
      cancelPending={props.cancelPending}
      cancelledTitle="Token summary cancelled"
      failureTitle="Token summary failed"
      fileSizeBytes={props.fileSizeBytes}
      idleDescription="codlogs will scan the current filtered set and sum token_count totals. You can cancel the scan after it starts."
      idleMessage="Token counts are read from every currently filtered JSONL file. Large logs can take a while."
      idleTitle="Run token summary?"
      kicker="Filtered tokens"
      onCancel={props.onCancel}
      onClose={props.onClose}
      onConfirm={props.onConfirm}
      resultActions={
        result ? (
          <button
            className="primary-button token-copy-button"
            onClick={() => void handleCopy()}
            type="button"
          >
            <CopyIcon className="button-icon" />
            <span>
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy Failed"
                  : "Copy"}
            </span>
          </button>
        ) : (
          <span />
        )
      }
      sessionCount={props.sessionCount}
      state={props.state}
      title="Token Summary"
    >
      {result && (
        <>
          <div className="token-usage-grid">
            <TokenUsageStat label="Total" value={result.tokenUsage.totalTokens} />
            <TokenUsageStat label="Input" value={result.tokenUsage.inputTokens} />
            <TokenUsageStat label="Cached Input" value={result.tokenUsage.cachedInputTokens} />
            <TokenUsageStat
              label="Uncached Input"
              value={getUncachedInputTokens(result.tokenUsage)}
            />
            <TokenUsageStat
              label="Reasoning Output"
              value={result.tokenUsage.reasoningOutputTokens}
            />
            <TokenUsageStat label="Output" value={result.tokenUsage.outputTokens} />
          </div>
          <div className="token-summary-stats">
            <TokenSummaryStat
              label="With Token Data"
              value={formatTokenCount(result.sessionsWithTokenUsage)}
            />
            <TokenSummaryStat
              label="Without Token Data"
              value={formatTokenCount(result.sessionsWithoutTokenUsage)}
            />
            <TokenSummaryStat
              label="Failed"
              value={formatTokenCount(result.failedSessionCount)}
            />
            <TokenSummaryStat
              label="Token Rows"
              value={formatTokenCount(result.tokenCountRows)}
            />
            <TokenSummaryStat
              label="Oversized Rows"
              value={formatTokenCount(result.oversizedLineCount)}
            />
          </div>
        </>
      )}
    </SummaryDialogShell>
  );
}

function ErroredToolCallSummaryDialog(props: {
  cancelPending: boolean;
  fileSizeBytes: number;
  onCancel: () => void;
  onClose: () => void;
  onConfirm: () => void;
  sessionCount: number;
  state: ErroredToolCallSummaryState;
  suggestedFileNamePrefix: string;
}) {
  const [copyState, , setCopyState] =
    useTimedActionState<"idle" | "copied" | "failed">("idle", 1600);
  const [saveState, setSaveState, setTemporarySaveState] =
    useTimedActionState<"idle" | "saving" | "saved" | "failed">("idle", 1800);
  const result = props.state.kind === "idle" ? null : props.state.result;

  const handleCopy = async (): Promise<void> => {
    if (!result) {
      return;
    }

    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(formatErroredToolCallSummaryForClipboard(result));
        ok = true;
      }
    } catch {
      ok = false;
    }

    setCopyState(ok ? "copied" : "failed");
  };

  const handleSave = async (): Promise<void> => {
    if (!result || saveState === "saving") {
      return;
    }

    setSaveState("saving");
    try {
      const response = await getRpc().request.saveMarkdownFile({
        content: formatErroredToolCallSummaryAsMarkdown(result),
        suggestedFileName: buildSummaryFileName(props.suggestedFileNamePrefix),
      });
      if (response.outputPath) {
        setTemporarySaveState("saved");
      } else {
        setSaveState("idle");
      }
    } catch {
      setTemporarySaveState("failed");
    }
  };

  return (
    <SummaryDialogShell
      cancelPending={props.cancelPending}
      cancelledTitle="Tool error summary cancelled"
      failureTitle="Tool error summary failed"
      fileSizeBytes={props.fileSizeBytes}
      idleDescription="codlogs will scan the current filtered set, classify errored tool outputs, and group distinct tool call patterns. You can cancel the scan after it starts."
      idleMessage="Tool call outputs are matched back to tool inputs and grouped by failure pattern."
      idleTitle="Run tool error summary?"
      kicker="Filtered tool errors"
      onCancel={props.onCancel}
      onClose={props.onClose}
      onConfirm={props.onConfirm}
      resultActions={
        result ? (
          <div className="summary-output-actions">
            <button
              className="primary-button token-copy-button"
              disabled={saveState === "saving"}
              onClick={() => void handleSave()}
              type="button"
            >
              <span>
                {saveState === "saving"
                  ? "Saving..."
                  : saveState === "saved"
                    ? "Saved"
                    : saveState === "failed"
                      ? "Save Failed"
                      : "Save As"}
              </span>
            </button>
            <button
              className="ghost-button token-copy-button"
              onClick={() => void handleCopy()}
              type="button"
            >
              <CopyIcon className="button-icon" />
              <span>
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "failed"
                    ? "Copy Failed"
                    : "Copy"}
              </span>
            </button>
          </div>
        ) : (
          <span />
        )
      }
      sessionCount={props.sessionCount}
      state={props.state}
      title="Tool Error Summary"
    >
      {result && (
        <>
          <div className="token-summary-stats">
            <TokenSummaryStat
              label="Errored Calls"
              value={formatTokenCount(result.erroredToolCallCount)}
            />
            <TokenSummaryStat
              label="Distinct"
              value={formatTokenCount(result.distinctErroredToolCalls.length)}
            />
            <TokenSummaryStat
              label="Sessions With Errors"
              value={formatTokenCount(result.sessionsWithErroredToolCalls)}
            />
            <TokenSummaryStat
              label="Without Errors"
              value={formatTokenCount(result.sessionsWithoutErroredToolCalls)}
            />
            <TokenSummaryStat
              label="Failed"
              value={formatTokenCount(result.failedSessionCount)}
            />
            <TokenSummaryStat
              label="Oversized Rows"
              value={formatTokenCount(result.oversizedLineCount)}
            />
          </div>
          {result.distinctErroredToolCalls.length > 0 ? (
            <div className="tool-error-list">
              {result.distinctErroredToolCalls.map((pattern, index) => (
                <ErroredToolCallPatternRow
                  key={`${pattern.toolName}-${pattern.errorPattern}-${index}`}
                  pattern={pattern}
                />
              ))}
            </div>
          ) : (
            <div className="dialog-warning dialog-warning-neutral">
              <strong>No errored tool calls found</strong>
              <p>The scanned sessions did not contain tool outputs matching the error patterns.</p>
            </div>
          )}
        </>
      )}
    </SummaryDialogShell>
  );
}

function ErroredToolCallPatternRow(props: { pattern: SessionErroredToolCallPattern }) {
  return (
    <div className="tool-error-card">
      <div className="tool-error-card-header">
        <div>
          <strong>{props.pattern.toolName}</strong>
          <span>{props.pattern.callKind}</span>
        </div>
        <span>{formatTokenCount(props.pattern.occurrences)}x</span>
      </div>
      <p className="tool-error-pattern">{props.pattern.errorPattern}</p>
      <div className="tool-error-meta">
        <span>{formatTokenCount(props.pattern.sessionCount)} session{props.pattern.sessionCount === 1 ? "" : "s"}</span>
        {props.pattern.exitCode !== null && <span>exit {props.pattern.exitCode}</span>}
      </div>
      <pre>{props.pattern.argumentsPreview || "(empty input)"}</pre>
      {props.pattern.sampleOutput && <pre>{props.pattern.sampleOutput}</pre>}
    </div>
  );
}

function TokenSummaryStat(props: { label: string; value: string }) {
  return (
    <div className="token-summary-stat">
      <span className="meta-label">{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function TokenUsageStat(props: { label: string; value: number }) {
  return (
    <div className="token-usage-stat">
      <span className="meta-label">{props.label}</span>
      <strong>{formatTokenCount(props.value)}</strong>
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

function getTranscriptEntryRoleClass(entry: SessionTranscriptEntry): string {
  if (entry.kind !== "message") {
    return `transcript-entry-${entry.kind.replace(/_/g, "-")}`;
  }

  const normalizedRole =
    entry.role === "user" || entry.role === "assistant" || entry.role === "system"
      ? entry.role
      : "other";
  return `transcript-entry-message transcript-entry-role-${normalizedRole}`;
}

function formatTranscriptEntryTimestamp(value: string | null): string {
  if (!value) {
    return "unknown time";
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : timestampFormatter.format(parsed);
}

function entryMatchesQuery(entry: SessionTranscriptEntry, query: string): boolean {
  if (!query) {
    return true;
  }

  const needle = query.toLowerCase();
  return (
    entry.title.toLowerCase().includes(needle) ||
    entry.text.toLowerCase().includes(needle) ||
    (entry.role?.toLowerCase().includes(needle) ?? false)
  );
}

function CopyIcon(props: { className?: string }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="8.5"
        y="8.5"
        width="11"
        height="11"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M5.5 15.5h-.25A1.75 1.75 0 0 1 3.5 13.75v-9A1.75 1.75 0 0 1 5.25 3h9A1.75 1.75 0 0 1 16 4.75V5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon(props: { className?: string }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FilterIcon(props: { className?: string }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 5h16l-6 8v5.25a.75.75 0 0 1-1.18.61l-2.5-1.75A.75.75 0 0 1 10 16.5V13L4 5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function isToolCallTranscriptEntry(entry: SessionTranscriptEntry): boolean {
  return (
    entry.kind === "tool_call" ||
    entry.kind === "tool_output" ||
    entry.kind === "custom_tool_call" ||
    entry.kind === "custom_tool_output"
  );
}

function SessionBrowserDialog(props: {
  onClose: () => void;
  state: Exclude<SessionBrowserState, { kind: "idle" }>;
}) {
  const { state } = props;
  const [query, setQuery] = useState("");
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<{ index: number; ok: boolean } | null>(null);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setQuery("");
    setShowToolCalls(true);
    setCopyFeedback(null);
  }, [state.session.file]);

  useEffect(() => {
    if (state.kind !== "ready") {
      return;
    }

    bodyRef.current?.focus({ preventScroll: true });
  }, [state.kind, state.session.file]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        const input = searchInputRef.current;
        if (input) {
          input.focus();
          input.select();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  const entries = state.kind === "ready" ? state.transcript.entries : [];
  const visibleEntries = showToolCalls
    ? entries
    : entries.filter((entry) => !isToolCallTranscriptEntry(entry));
  const hiddenToolCallCount = entries.length - visibleEntries.length;
  const trimmedQuery = deferredQuery.trim();
  const filteredEntries = trimmedQuery
    ? visibleEntries.filter((entry) => entryMatchesQuery(entry, trimmedQuery))
    : visibleEntries;

  const handleCopyEntry = async (entry: SessionTranscriptEntry): Promise<void> => {
    const payload = `${entry.title}\n\n${entry.text}`;
    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        ok = true;
      }
    } catch {
      ok = false;
    }

    setCopyFeedback({ index: entry.index, ok });
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => {
      setCopyFeedback(null);
      copyResetTimerRef.current = null;
    }, 1600);
  };

  const handleCopyAll = async (): Promise<void> => {
    if (state.kind !== "ready") {
      return;
    }

    const payload = state.transcript.entries
      .map((entry) => `## ${entry.title}\n${formatTranscriptEntryTimestamp(entry.timestamp)}\n\n${entry.text}`)
      .join("\n\n---\n\n");

    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        ok = true;
      }
    } catch {
      ok = false;
    }

    setCopyFeedback({ index: -1, ok });
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => {
      setCopyFeedback(null);
      copyResetTimerRef.current = null;
    }, 1600);
  };

  const sessionTitle = getSessionTitle(state.session);

  return (
    <div className="session-browser-overlay" onClick={props.onClose}>
      <div
        aria-modal="true"
        className="session-browser"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="session-browser-header">
          <div className="session-browser-title">
            <span className="dialog-kicker">Session replay</span>
            <h2>{sessionTitle}</h2>
            <p className="session-browser-subtitle">
              {state.session.cwd}
            </p>
          </div>
          <div className="session-browser-header-actions">
            <button
              className="session-browser-action"
              disabled={state.kind !== "ready" || entries.length === 0}
              onClick={() => void handleCopyAll()}
              type="button"
            >
              <CopyIcon className="session-browser-action-icon" />
              <span>
                {copyFeedback?.index === -1
                  ? copyFeedback.ok
                    ? "Copied"
                    : "Copy failed"
                  : "Copy All"}
              </span>
            </button>
            <button
              aria-label="Close session browser"
              className="session-browser-action"
              onClick={props.onClose}
              type="button"
            >
              <CloseIcon className="session-browser-action-icon" />
              <span>Close</span>
            </button>
          </div>
        </header>

        <div className="session-browser-toolbar">
          <div className="search-container compact session-browser-search">
            <span className="search-icon">🔍</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this session transcript... (Ctrl+F)"
              ref={searchInputRef}
              type="search"
              value={query}
            />
          </div>
          <button
            aria-pressed={!showToolCalls}
            className={`session-browser-action session-browser-filter${
              !showToolCalls ? " session-browser-filter-active" : ""
            }`}
            disabled={state.kind !== "ready"}
            onClick={() => setShowToolCalls((current) => !current)}
            title={
              showToolCalls
                ? "Hide tool calls and tool outputs"
                : "Show tool calls and tool outputs"
            }
            type="button"
          >
            <FilterIcon className="session-browser-action-icon" />
            <span>{showToolCalls ? "Hide tool calls" : "Show tool calls"}</span>
          </button>
          <div className="session-browser-meta">
            {state.kind === "ready" ? (
              <>
                <span>
                  {filteredEntries.length} / {entries.length}{" "}
                  {entries.length === 1 ? "entry" : "entries"}
                </span>
                {hiddenToolCallCount > 0 && (
                  <span>
                    {hiddenToolCallCount} tool{" "}
                    {hiddenToolCallCount === 1 ? "entry" : "entries"} hidden
                  </span>
                )}
                {state.transcript.truncated && (
                  <span className="session-browser-meta-warning">
                    Truncated at {SESSION_BROWSER_MAX_ENTRIES}
                  </span>
                )}
                {state.transcript.omittedBootstrapMessages > 0 && (
                  <span>
                    {state.transcript.omittedBootstrapMessages} bootstrap{" "}
                    {state.transcript.omittedBootstrapMessages === 1 ? "message" : "messages"}{" "}
                    hidden
                  </span>
                )}
                {state.transcript.oversizedLineCount > 0 && (
                  <span className="session-browser-meta-warning">
                    {state.transcript.oversizedLineCount} oversized row
                    {state.transcript.oversizedLineCount === 1 ? "" : "s"} skipped
                  </span>
                )}
              </>
            ) : state.kind === "loading" ? (
              <span>Loading transcript...</span>
            ) : (
              <span className="session-browser-meta-warning">Transcript unavailable</span>
            )}
          </div>
        </div>

        <div
          className="session-browser-body"
          ref={bodyRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            const node = bodyRef.current;
            if (!node) {
              return;
            }

            const pageStep = Math.max(node.clientHeight - 80, 80);
            switch (event.key) {
              case "PageDown":
                event.preventDefault();
                node.scrollBy({ top: pageStep });
                break;
              case "PageUp":
                event.preventDefault();
                node.scrollBy({ top: -pageStep });
                break;
              case "Home":
                event.preventDefault();
                node.scrollTo({ top: 0 });
                break;
              case "End":
                event.preventDefault();
                node.scrollTo({ top: node.scrollHeight });
                break;
              case "ArrowDown":
                event.preventDefault();
                node.scrollBy({ top: 60 });
                break;
              case "ArrowUp":
                event.preventDefault();
                node.scrollBy({ top: -60 });
                break;
              default:
                break;
            }
          }}
        >
          {state.kind === "loading" && (
            <div className="session-browser-placeholder">
              <span className="empty-icon">⏳</span>
              <p>Reading session transcript...</p>
            </div>
          )}
          {state.kind === "error" && (
            <div className="session-browser-placeholder">
              <span className="empty-icon">⚠️</span>
              <p>{state.errorMessage}</p>
            </div>
          )}
          {state.kind === "ready" && entries.length === 0 && (
            <div className="session-browser-placeholder">
              <span className="empty-icon">📭</span>
              <p>No transcript entries were found in this session.</p>
            </div>
          )}
          {state.kind === "ready" && entries.length > 0 && filteredEntries.length === 0 && (
            <div className="session-browser-placeholder">
              <span className="empty-icon">🔍</span>
              <p>
                {visibleEntries.length === 0
                  ? "All entries in this session are tool calls and are currently hidden."
                  : "No entries match this search."}
              </p>
            </div>
          )}
          {state.kind === "ready" && filteredEntries.length > 0 && (
            <ol className="session-browser-transcript">
              {filteredEntries.map((entry) => (
                <li
                  className={`transcript-entry ${getTranscriptEntryRoleClass(entry)}`}
                  key={entry.index}
                >
                  <div className="transcript-entry-header">
                    <span className="transcript-entry-title">
                      <span className="transcript-entry-index">#{entry.index + 1}</span>
                      {entry.title}
                    </span>
                    <span className="transcript-entry-time">
                      {formatTranscriptEntryTimestamp(entry.timestamp)}
                    </span>
                    <button
                      className="session-browser-action transcript-copy-button"
                      onClick={() => void handleCopyEntry(entry)}
                      type="button"
                    >
                      <CopyIcon className="session-browser-action-icon" />
                      <span>
                        {copyFeedback?.index === entry.index
                          ? copyFeedback.ok
                            ? "Copied"
                            : "Copy failed"
                          : "Copy"}
                      </span>
                    </button>
                  </div>
                  <pre className={`transcript-entry-body transcript-lang-${entry.language}`}>
                    {entry.text}
                  </pre>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
