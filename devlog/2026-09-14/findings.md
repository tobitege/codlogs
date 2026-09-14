# HTML and Markdown export review

Starting state: clean `main`, app and package version 1.3.2. Reviewed the shared exporters, CLI, desktop export calls, and existing tests with `codereview-roasted`.

Initial taste rating: Needs improvement. All findings below were fixed, including the smaller maintenance and documentation issues.

| Priority | Finding in the starting implementation | Resolution and regression evidence |
| --- | --- | --- |
| P1 | Opening the destination truncated an existing export immediately. Failure cleanup recursively deleted the shared image directory, including previous exports' files. | Write to a unique `.partial` file, close it, then rename it to the destination. Each run owns an image subfolder. Cancellation, oversized input, and invalid destination tests verify that existing files survive. |
| P1 | HTML message roles, phases, timestamps, and reasoning timestamps bypassed escaping. The role also entered a CSS attribute directly. | Escape all displayed header values and restrict the CSS role class. An HTML injection fixture covers message and reasoning headers. |
| P2 | HTML collapsed newlines and indentation. Both formats moved every image after all text, changing message order. | A shared content renderer walks parts in source order, preserves whitespace, and emits HTML text with `white-space: pre-wrap`. Both formats have ordered-image and indentation tests. |
| P2 | Any image URL scheme was accepted; image URLs with nested `url` values were dropped; ordinary text with a `url` was treated as an image. Invalid base64 could become an empty file. | Accept HTTP(S) or validated image data, handle nested image URLs, and distinguish image parts from text. Tests cover executable/local schemes, malformed base64, and linked text. |
| P2 | Asset URLs broke with spaces, parentheses, or fragment characters. Inline and remote images did not advance the image label counter. Custom HTML names still used the source session's asset folder. | Encode each asset URL segment, number every rendered image, and derive the sidecar name from the chosen output. Test generated references by reading the actual saved image bytes. |
| P2 | Bootstrap matching removed later user messages that quoted context markers and allocated images before deciding to omit a message. | Filter initial bootstrap content before rendering; preserve later conversation messages. Tests verify message retention and absence of omitted images and empty asset folders. |
| P2 | Write-stream errors could escape the export promise and leave the process waiting. Late cancellation could report failure after writing a complete file. | Await file-handle writes and closure. Treat rename as the publication boundary. Tests cover invalid destinations and cancellation during final progress notification. |
| P2 | UTF-8 BOM metadata failed to parse. Valid JSON values such as `null` were treated as records. Oversized-row diagnostics missed the last fragment's byte count. | Accept BOM metadata, validate record objects, and include the final fragment in oversized-row lengths. Tests include malformed lines and an oversized row with an existing destination. |
| P2 | Long JSONL rows repeatedly copied the growing buffer. Code-fence selection spread every tilde match into `Math.max`, exceeding Node's argument limit for large tool results. | Accumulate byte fragments and combine them when a row ends; find the longest fence in a loop. Existing large-row tests and a real Node CLI regression cover these paths. |
| P2 | CLI `--html --include-images` embedded images although its help and README promised sidecar files. | Explicitly select sidecar mode in the CLI. The Node CLI test checks the HTML reference and absence of embedded payloads. |
| P3 | Generated Markdown metadata and tool headings did not escape formatting characters or normalize embedded newlines. | Escape generated metadata, headings, and image labels while retaining message Markdown. Tests cover injected headings and formatted image labels. |
| P3 | Unused whole-file exporters duplicated the streaming implementations; the export suite contained only one Markdown smoke test. | Remove the unused exporters and progress helpers, share traversal and content rendering, and add regression coverage for both formats and the Node CLI. |

Final taste rating: Good taste. No identified review items remain open. The implementation has one bounded traversal and format-specific output templates.

Interrupted `.partial` files and image generations are intentionally retained for recovery, as documented in README. Export failure does not delete files.

## Dependency changes

All ten direct packages and the lockfile were updated with Bun. Resolution uses a seven-day minimum release age; newer React 19.3, Vite 8.3, and associated type releases are not yet eligible. The final lockfile uses registry packages only.

Electrobun 2.0.1 requires the generated `.hutch/devkit` SDK. The project prepares it before typechecking or bundling, maps Vite imports through the SDK helper, and keeps Bun as its main-process runtime. TypeScript 7 uses explicit SDK paths because the generated config's `baseUrl` option is no longer supported. CI and release validation use the same preparation and test commands.

Sources: [Electrobun migration guide](https://framework.blackboard.sh/electrobun/guides/migrating-to-v2/), [Bun minimum release age](https://bun.sh/docs/pm/cli/install).

The app version is 1.4.0. README contains the new changelog section; release notes now read that section.
