import fs from "node:fs";
import path from "node:path";
import { loadConfig, type AppConfig } from "../app-config.ts";
import { logLevel } from "../config.ts";
import type { DailyOutcome } from "../daily.ts";
import { configureLog, errorMessage, warn, type Level } from "../log.ts";
import { localDateTime, localTime } from "../sun.ts";
import { notify, sendPhoto, telegramFromEnv, type TelegramTarget } from "../telegram.ts";

export interface GlobalOpts {
  config?: string;
}

export interface App {
  cfg: AppConfig;
  tg: TelegramTarget | undefined;
}

/** Load config, point the logger at `<home>/logs/eufy-snap.log`, resolve the Telegram target. */
export function bootstrap(opts: GlobalOpts, runId: string): App {
  const cfg = loadConfig(opts.config);
  fs.mkdirSync(cfg.paths.logs, { recursive: true });
  const level: Level = logLevel() === "warn" ? "info" : logLevel();
  configureLog({ level, runId, file: path.join(cfg.paths.logs, "eufy-snap.log") });
  return { cfg, tg: telegramFromEnv(cfg.telegram.botTokenEnv, cfg.telegram.chatIdEnv) };
}

export function captionFor(cfg: AppConfig, o: DailyOutcome): string {
  const tz = cfg.location.timezone;
  const s = o.sidecar;
  const event = s.event ?? cfg.schedule.event;
  const bits = [`${event[0]!.toUpperCase()}${event.slice(1)} ${s.date}`];
  if (s.eventAt) bits.push(`${event} ${localTime(new Date(s.eventAt), tz)}`);
  bits.push(`shot ${localTime(new Date(s.shotAt), tz)}`);
  bits.push(`${s.image.width}×${s.image.height}`);
  if (s.reason !== "scheduled") bits.push(`(${s.reason})`);
  let caption = bits.join(" · ");
  if (s.offPreset) caption += `\n⚠️ camera appears OFF preset ${s.presets.shoot} — check the mount`;
  for (const w of s.warnings.filter((w) => !w.startsWith("off preset"))) caption += `\n⚠️ ${w}`;
  return caption;
}

/** Send the photo; `true` when delivered or when Telegram simply isn't configured. */
export async function deliver(app: App, o: DailyOutcome): Promise<boolean> {
  if (!app.tg) return true;
  try {
    await sendPhoto(app.tg, o.jpeg, captionFor(app.cfg, o), path.basename(o.file));
    return true;
  } catch (e) {
    warn(`telegram photo failed: ${errorMessage(e)}`);
    return false;
  }
}

/** Failure notice; never throws. */
export async function alert(app: App, what: string, e: unknown): Promise<void> {
  const when = localDateTime(new Date(), app.cfg.location.timezone);
  await notify(app.tg, `❌ eufy-snap ${what} at ${when}:\n${errorMessage(e)}`);
}

export function printOutcome(cfg: AppConfig, o: DailyOutcome): void {
  const s = o.sidecar;
  const lines = [
    `${o.file}`,
    `  ${s.image.width}×${s.image.height}, ${(s.image.bytes / 1024).toFixed(0)} KB, ${s.image.attempts} attempt(s), ${(s.durationMs / 1000).toFixed(1)}s`,
    `  shot ${localDateTime(new Date(s.shotAt), cfg.location.timezone)}${s.eventAt ? ` (${s.event ?? cfg.schedule.event} ${localTime(new Date(s.eventAt), cfg.location.timezone)})` : ""}`,
  ];
  if (s.motion) lines.push(`  motion: shift ${(s.motion.shift * 100).toFixed(1)}% mad ${s.motion.mad.toFixed(1)} vs pre-move frame → ${s.motion.moved ? "camera moved" : "DID NOT MOVE"}`);
  if (s.verify) lines.push(`  verify: shift ${(s.verify.shift * 100).toFixed(1)}% mad ${s.verify.mad.toFixed(1)} → ${s.verify.onPreset ? "ON preset" : "OFF PRESET"}${s.verify.retried ? " (after retry)" : ""}`);
  const drift = s.presets.cameraDefault !== undefined && s.presets.cameraDefault !== s.presets.home ? ` (camera default is ${s.presets.cameraDefault} — it will drift back there)` : "";
  lines.push(`  returned to preset ${s.presets.home}: ${s.returnedHome ? "yes" : "NO"}${drift}`);
  for (const w of s.warnings) lines.push(`  ⚠ ${w}`);
  console.log(lines.join("\n"));
}
