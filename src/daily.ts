import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Device } from "@mega-yfue/eufy-sdk";
import type { AppConfig } from "./app-config.ts";
import { createClient, login, sleep } from "./client.ts";
import { getDevice, isStoredPreset, requireCamera, requirePtz, type CameraApi } from "./commands/shared.ts";
import { describeShift, frameShift, type ShiftResult } from "./frame-shift.ts";
import { debug, errorMessage, info, warn } from "./log.ts";
import { savePhoto, type SavedPhoto, type Sidecar } from "./store.ts";
import type { SunPlan } from "./sun.ts";

const require = createRequire(import.meta.url);
const TOOL_VERSION: string = (require("../package.json") as { version: string }).version;
const SDK_VERSION: string = readSdkVersion();

/** The SDK's `exports` map hides its package.json, so walk up from the resolved entry point. */
function readSdkVersion(): string {
  try {
    let dir = path.dirname(require.resolve("@mega-yfue/eufy-sdk"));
    for (let i = 0; i < 5; i++) {
      const pj = path.join(dir, "package.json");
      if (fs.existsSync(pj)) {
        const parsed = JSON.parse(fs.readFileSync(pj, "utf8")) as { name?: string; version?: string };
        if (parsed.name === "@mega-yfue/eufy-sdk" && parsed.version) return parsed.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through
  }
  return "unknown";
}

/** No usable frame after all attempts — exit 30. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface DailyOptions {
  reason: Sidecar["reason"];
  date: string;
  plan?: SunPlan;
  /** Write `reference.jpg` instead of a dated photo, and skip verification. */
  asReference?: boolean;
}

export interface DailyOutcome {
  jpeg: Buffer;
  sidecar: Sidecar;
  /** Where it went: the dated photo, or the reference file. */
  file: string;
  saved?: SavedPhoto;
  /** 0 = on preset (or unverified), 20 = off preset after retry. */
  exitCode: 0 | 20;
}

interface Shot {
  jpeg: Buffer;
  width: number;
  height: number;
  attempts: number;
}

const P2P_RETRY_MS = 20_000;
const P2P_ATTEMPTS = 3;

/** The camera keeps the previous P2P session for ~15 s; a fresh connect inside that window times out. */
async function withP2pRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = errorMessage(e);
      if (attempt >= P2P_ATTEMPTS || !/timeout|timed out|ECONNRESET|not connected/i.test(msg)) throw e;
      warn(`${what}: ${msg} — retrying in ${P2P_RETRY_MS / 1000}s`, { attempt });
      await sleep(P2P_RETRY_MS);
    }
  }
}

/** Shoot until a frame at least `minWidth` wide arrives, or attempts run out (keeping the largest). */
async function capture(cam: CameraApi, cfg: AppConfig["capture"]): Promise<Shot> {
  if (!cam.snapshotLive) throw new CaptureError("camera exposes no snapshotLive (ffmpeg missing?)");
  let best: Shot | undefined;
  let lastError = "";
  for (let attempt = 1; attempt <= cfg.retries; attempt++) {
    try {
      const shot = await cam.snapshotLive({ powered: "battery", skipKeyframes: cfg.skipKeyframes });
      debug("snapshot", { attempt, width: shot.width, height: shot.height, bytes: shot.jpeg.length, retained: shot.retained ?? false });
      if (shot.retained) {
        lastError = "camera returned a retained (stale) still";
        warn(lastError, { attempt });
      } else if (!best || shot.width > best.width) {
        best = { jpeg: shot.jpeg, width: shot.width, height: shot.height, attempts: attempt };
      }
      if (best && best.width >= cfg.minWidth) return best;
      if (best) warn(`frame is ${best.width}px wide, want ≥ ${cfg.minWidth}`, { attempt });
    } catch (e) {
      lastError = errorMessage(e);
      warn(`snapshot attempt ${attempt}/${cfg.retries} failed: ${lastError}`);
    }
    if (attempt < cfg.retries) await sleep(cfg.minWidthWaitMs);
  }
  if (best) {
    warn(`accepting a ${best.width}×${best.height} frame after ${cfg.retries} attempts`);
    return best;
  }
  throw new CaptureError(`no frame after ${cfg.retries} attempts: ${lastError}`);
}

function firmwareOf(dev: Device): string | undefined {
  const raw = (dev as unknown as { raw?: Record<string, unknown> }).raw;
  const v = raw?.main_sw_version;
  return typeof v === "string" ? v : undefined;
}

/**
 * The daily sequence: goto(shoot) → settle → capture → verify against the reference (retry once) →
 * goto(home) → save. Throws `NeedsHumanError` (login), `CaptureError`, or a plain Error for
 * configuration problems; anything that merely degrades the result is recorded in the sidecar.
 */
export async function runDaily(cfg: AppConfig, opts: DailyOptions): Promise<DailyOutcome> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const { shootPreset, homePreset, settleMs } = cfg.camera;

  const eufy = createClient();
  await login(eufy, false);
  const dev = await getDevice(eufy, cfg.camera.serial);
  const ptz = requirePtz(dev);
  const cam = requireCamera(dev);
  const preset = ptz.preset();
  info("connected", { serial: dev.sn, model: dev.modelName, firmware: firmwareOf(dev) });

  let verify: Sidecar["verify"];
  let returnedHome = false;
  let shot: Shot;
  try {
    const stored = ((await withP2pRetry("preset list", () => preset.list?.() ?? Promise.resolve([]))) ?? []).filter(isStoredPreset).map((p) => p.id);
    for (const [name, id] of [
      ["shoot_preset", shootPreset],
      ["home_preset", homePreset],
    ] as const) {
      if (stored.length && !stored.includes(id)) throw new Error(`${name} ${id} is not stored on the camera (stored: ${stored.join(", ")})`);
    }

    info(`goto preset ${shootPreset}`);
    await withP2pRetry("goto", () => preset.goto(shootPreset));
    await sleep(settleMs);
    shot = await capture(cam, cfg.capture);
    info("captured", { width: shot.width, height: shot.height, attempts: shot.attempts });

    const reference = !opts.asReference && fs.existsSync(cfg.paths.reference) ? fs.readFileSync(cfg.paths.reference) : undefined;
    if (reference) {
      const judge = (r: ShiftResult): boolean => Math.abs(r.fraction) <= cfg.capture.verify.maxShift;
      let r = frameShift(reference, shot.jpeg);
      let retried = false;
      info(`verify vs reference: ${describeShift(r)}`);
      if (!judge(r)) {
        retried = true;
        warn("off preset — re-issuing goto and re-shooting");
        await withP2pRetry("goto (retry)", () => preset.goto(shootPreset));
        await sleep(settleMs * 2);
        const again = await capture(cam, cfg.capture);
        const r2 = frameShift(reference, again.jpeg);
        info(`verify after retry: ${describeShift(r2)}`);
        if (judge(r2) || Math.abs(r2.fraction) < Math.abs(r.fraction)) {
          shot = { ...again, attempts: shot.attempts + again.attempts };
          r = r2;
        }
      }
      const onPreset = judge(r);
      if (onPreset && r.mad > cfg.capture.verify.maxMad) {
        warnings.push(`verify uncertain: aligned but MAD ${r.mad.toFixed(1)} > ${cfg.capture.verify.maxMad} (lighting? mount drift?)`);
      }
      if (!onPreset) warnings.push(`off preset: ${describeShift(r)}`);
      verify = { shift: r.fraction, mad: r.mad, onPreset, retried };
    } else if (!opts.asReference) {
      warnings.push("no reference.jpg — position not verified (run `eufy-snap reference`)");
    }
  } finally {
    try {
      info(`return to preset ${homePreset}`);
      await preset.goto(homePreset);
      await sleep(1500);
      returnedHome = true;
    } catch (e) {
      warnings.push(`return home failed: ${errorMessage(e)}`);
      warn(warnings.at(-1)!);
    }
    await eufy.disconnect().catch(() => undefined);
  }

  const offPreset = verify ? !verify.onPreset : false;
  const firmware = firmwareOf(dev);
  const sidecar: Sidecar = {
    date: opts.date,
    reason: opts.reason,
    ...(opts.plan ? { sunrise: opts.plan.sunrise.toISOString(), fireAt: opts.plan.fireAt.toISOString() } : {}),
    shotAt: new Date().toISOString(),
    timezone: cfg.location.timezone,
    camera: { serial: dev.sn, model: dev.modelName, ...(firmware ? { firmware } : {}) },
    presets: { shoot: shootPreset, home: homePreset },
    image: { width: shot.width, height: shot.height, bytes: shot.jpeg.length, attempts: shot.attempts },
    ...(verify ? { verify } : {}),
    offPreset,
    returnedHome,
    durationMs: Date.now() - t0,
    warnings,
    tool: { version: TOOL_VERSION, sdk: SDK_VERSION },
  };

  if (opts.asReference) {
    fs.writeFileSync(cfg.paths.reference, shot.jpeg);
    fs.writeFileSync(cfg.paths.reference.replace(/\.jpg$/, ".json"), JSON.stringify(sidecar, null, 2) + "\n");
    info("reference written", { file: cfg.paths.reference, width: shot.width, height: shot.height });
    return { jpeg: shot.jpeg, sidecar, file: cfg.paths.reference, exitCode: 0 };
  }
  const saved = savePhoto(cfg.store.dir, shot.jpeg, sidecar, cfg.location.timezone);
  info("saved", { file: saved.file, offPreset, durationMs: sidecar.durationMs });
  return { jpeg: shot.jpeg, sidecar, file: saved.file, saved, exitCode: offPreset ? 20 : 0 };
}
