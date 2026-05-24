import type { RPCSchema } from "electrobun/view";
import type {
  FindCodexSessionsResult,
  SessionErroredToolCallPattern,
  SessionDetailMetrics,
  SessionTokenUsage,
  SessionTranscriptResult,
} from "./codlogs-core.ts";

export type EnvironmentCapabilities = {
  codexHome: string;
  codexHomeReadable: boolean;
  codexHomeWritable: boolean;
  gitAvailable: boolean;
  ripgrepAvailable: boolean;
  overallKind: "success" | "warning" | "error";
  summary: string;
  notes: string[];
};

export type TokenUsageSummaryResult = {
  sessionCount: number;
  scannedSessionCount: number;
  sessionsWithTokenUsage: number;
  sessionsWithoutTokenUsage: number;
  failedSessionCount: number;
  fileSizeBytes: number;
  oversizedLineCount: number;
  tokenCountRows: number;
  tokenUsage: SessionTokenUsage;
};

export type TokenUsageSummaryJobStatus = {
  kind: "working" | "success" | "error" | "cancelled";
  progressPercent: number;
  stage: string;
  message: string;
  scannedSessionCount: number;
  totalSessionCount: number;
  currentSessionPath: string | null;
  result: TokenUsageSummaryResult | null;
};

export type ErroredToolCallSummaryResult = {
  sessionCount: number;
  scannedSessionCount: number;
  sessionsWithErroredToolCalls: number;
  sessionsWithoutErroredToolCalls: number;
  failedSessionCount: number;
  fileSizeBytes: number;
  oversizedLineCount: number;
  toolCallRows: number;
  toolOutputRows: number;
  erroredToolCallCount: number;
  distinctErroredToolCalls: SessionErroredToolCallPattern[];
};

export type ErroredToolCallSummaryJobStatus = {
  kind: "working" | "success" | "error" | "cancelled";
  progressPercent: number;
  stage: string;
  message: string;
  scannedSessionCount: number;
  totalSessionCount: number;
  currentSessionPath: string | null;
  result: ErroredToolCallSummaryResult | null;
};

export type CodexerRPC = {
  bun: RPCSchema<{
    requests: {
      loadSessions: {
        params: {
          codexHome: string | null;
          targetDirectory: string | null;
          cwdOnly: boolean;
          dateFrom: string | null;
          dateTo: string | null;
          includeCrossSessionWrites: boolean;
        };
        response: FindCodexSessionsResult;
      };
      pickDirectory: {
        params: {
          startingFolder: string | null;
        };
        response: {
          path: string | null;
        };
      };
      pickExportDirectory: {
        params: {
          sessionFilePath: string;
        };
        response: {
          path: string | null;
        };
      };
      pickHtmlExportDestination: {
        params: {
          sessionFilePath: string;
          includeImages: boolean;
          inlineImages: boolean;
        };
        response: {
          path: string | null;
          selectionKind: "file" | "directory";
        };
      };
      startSessionMarkdownExport: {
        params: {
          sessionFilePath: string;
          includeImages: boolean;
          includeToolCallResults: boolean;
          outputDirectory: string | null;
        };
        response: {
          jobId: string;
        };
      };
      getSessionDetailMetrics: {
        params: {
          sessionFilePath: string;
          forceDeepAnalysis: boolean;
        };
        response: SessionDetailMetrics;
      };
      getSessionTranscript: {
        params: {
          sessionFilePath: string;
          maxEntries: number | null;
        };
        response: SessionTranscriptResult;
      };
      getEnvironmentCapabilities: {
        params: {
          codexHome: string | null;
        };
        response: EnvironmentCapabilities;
      };
      renameSessionThreadName: {
        params: {
          codexHome: string | null;
          threadId: string;
          threadName: string;
        };
        response: {
          threadName: string;
        };
      };
      exportSessionMarkdown: {
        params: {
          sessionFilePath: string;
          includeImages: boolean;
          includeToolCallResults: boolean;
          outputDirectory: string | null;
        };
        response: {
          outputPath: string;
        };
      };
      startSessionHtmlExport: {
        params: {
          sessionFilePath: string;
          includeImages: boolean;
          inlineImages: boolean;
          includeToolCallResults: boolean;
          outputDirectory: string | null;
          outputPath: string | null;
        };
        response: {
          jobId: string;
        };
      };
      startSessionSanitizedCopy: {
        params: {
          sessionFilePath: string;
          codexHome: string | null;
          chatName: string | null;
          stripImageContent: boolean;
          stripBlobContent: boolean;
          createJsonlCopy: boolean;
          reAddToCurrentDay: boolean;
        };
        response: {
          jobId: string;
        };
      };
      startTokenUsageSummary: {
        params: {
          sessionFilePaths: string[];
        };
        response: {
          jobId: string;
        };
      };
      startErroredToolCallSummary: {
        params: {
          sessionFilePaths: string[];
        };
        response: {
          jobId: string;
        };
      };
      getExportJobStatus: {
        params: {
          jobId: string;
        };
        response: {
          kind: "working" | "success" | "error" | "cancelled";
          progressPercent: number;
          stage: string;
          message: string;
          outputPath: string | null;
        };
      };
      getSanitizedCopyJobStatus: {
        params: {
          jobId: string;
        };
        response: {
          kind: "working" | "success" | "error" | "cancelled";
          progressPercent: number;
          stage: string;
          message: string;
          outputPath: string | null;
        };
      };
      getTokenUsageSummaryJobStatus: {
        params: {
          jobId: string;
        };
        response: TokenUsageSummaryJobStatus;
      };
      getErroredToolCallSummaryJobStatus: {
        params: {
          jobId: string;
        };
        response: ErroredToolCallSummaryJobStatus;
      };
      cancelExportJob: {
        params: {
          jobId: string;
        };
        response: {
          ok: boolean;
        };
      };
      cancelSanitizedCopyJob: {
        params: {
          jobId: string;
        };
        response: {
          ok: boolean;
        };
      };
      cancelTokenUsageSummaryJob: {
        params: {
          jobId: string;
        };
        response: {
          ok: boolean;
        };
      };
      cancelErroredToolCallSummaryJob: {
        params: {
          jobId: string;
        };
        response: {
          ok: boolean;
        };
      };
      saveMarkdownFile: {
        params: {
          content: string;
          suggestedFileName: string;
        };
        response: {
          outputPath: string | null;
        };
      };
      revealPath: {
        params: {
          path: string;
        };
        response: {
          ok: boolean;
        };
      };
      openPath: {
        params: {
          path: string;
        };
        response: {
          ok: boolean;
        };
      };
      refreshWindowLayout: {
        params: {};
        response: {
          ok: boolean;
        };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};
