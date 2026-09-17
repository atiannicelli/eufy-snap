import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Load environment: `.env` in the cwd (development) and `<state dir>/env` (deployment; the LaunchDaemon
 * points EUFY_SNAP_HOME there). Already-set variables win, so launchd `EnvironmentVariables` override both.
 */
export function loadDotEnv(): void {
  const cwdFile = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(cwdFile)) process.loadEnvFile(cwdFile);
  const homeFile = path.join(stateDir(), "env");
  if (fs.existsSync(homeFile)) process.loadEnvFile(homeFile);
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
