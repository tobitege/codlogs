import type { RPCSchema } from "electrobun/view";
import type { FindCodexSessionsResult, SessionDetailMetrics } from "./codlogs-core.ts";

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
        };
        response: SessionDetailMetrics;
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
      cancelExportJob: {
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
