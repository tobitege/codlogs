import type { RPCSchema } from "electrobun/view";
import type {
  FindCodexSessionsResult,
  SessionDetailMetrics,
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

export type CodexerRPC = {
  bun: RPCSchema<{
    requests: {
      loadSessions: {
        params: {
          codexHome: string | null;
          targetDirectory: string | null;
          cwdOnly: boolean;
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
