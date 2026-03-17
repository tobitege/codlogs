import * as path from "node:path";

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

function bytesToUuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function formatCodexRolloutTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    padTwo(date.getMonth() + 1),
    padTwo(date.getDate()),
  ].join("-")
    + `T${padTwo(date.getHours())}-${padTwo(date.getMinutes())}-${padTwo(date.getSeconds())}`;
}

export function generateUuidV7String(
  date: Date = new Date(),
  randomBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): string {
  if (randomBytes.length !== 16) {
    throw new Error("UUIDv7 generation requires exactly 16 random bytes.");
  }

  const timestamp = BigInt(date.getTime());
  const bytes = new Uint8Array(randomBytes);

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuidString(bytes);
}

export function buildCodexCurrentDaySessionDirectory(
  codexHome: string,
  date: Date = new Date(),
): string {
  return path.join(
    codexHome,
    "sessions",
    String(date.getFullYear()),
    padTwo(date.getMonth() + 1),
    padTwo(date.getDate()),
  );
}

export function buildCodexRolloutFileName(
  threadId: string,
  date: Date = new Date(),
): string {
  return `rollout-${formatCodexRolloutTimestamp(date)}-${threadId}.jsonl`;
}

export function buildCodexCurrentDayRolloutPath(
  codexHome: string,
  threadId: string,
  date: Date = new Date(),
): string {
  return path.join(
    buildCodexCurrentDaySessionDirectory(codexHome, date),
    buildCodexRolloutFileName(threadId, date),
  );
}
