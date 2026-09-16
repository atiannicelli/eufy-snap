import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Load `.env` from the cwd if present. Real deployments pass env via launchd instead. */
export function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name} (see .env.example)`);
  return v;
}

/** State directory: session file, calibration, lock. Created on demand with owner-only perms. */
export function stateDir(): string {
  const dir = process.env.EUFY_SNAP_HOME ?? path.join(os.homedir(), ".eufy-snap");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function sessionFile(): string {
  return path.join(stateDir(), "session.json");
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export function logLevel(): LogLevel {
  const v = process.env.EUFY_LOG_LEVEL;
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "warn";
}
