#!/usr/bin/env node

const childProcess = require("node:child_process");
const path = require("node:path");

const scriptPath = path.join(__dirname, "codex-sessions.ts");
const result = childProcess.spawnSync(
  process.execPath,
  ["--no-warnings", "--experimental-strip-types", scriptPath, ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      CODEXER_COMMAND_NAME: "codlogs",
    },
    stdio: "inherit",
    windowsHide: false,
  },
);

if (result.error) {
  console.error(`Failed to launch codlogs: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
