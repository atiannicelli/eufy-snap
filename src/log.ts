import fs from "node:fs";

/** Structured-ish logging: one line per event, ISO timestamp, level, message, optional JSON fields. */
export type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let threshold: Level = "info";
let runId = "";
let file: string | undefined;

export function configureLog(opts: { level?: Level; runId?: string; file?: string }): void {
  if (opts.level) threshold = opts.level;
  if (opts.runId !== undefined) runId = opts.runId;
  if (opts.file) file = opts.file;
}

export function log(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < order[threshold]) return;
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${runId ? `[${runId}] ` : ""}${msg}${fields ? " " + JSON.stringify(fields) : ""}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
  if (file) {
    try {
      fs.appendFileSync(file, line + "\n");
    } catch {
      // logging must never take the run down
    }
  }
}

export const info = (msg: string, fields?: Record<string, unknown>): void => log("info", msg, fields);
export const warn = (msg: string, fields?: Record<string, unknown>): void => log("warn", msg, fields);
export const error = (msg: string, fields?: Record<string, unknown>): void => log("error", msg, fields);
export const debug = (msg: string, fields?: Record<string, unknown>): void => log("debug", msg, fields);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
