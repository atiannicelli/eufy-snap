import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Device } from "@mega-yfue/eufy-sdk";
import type { AppConfig } from "./app-config.ts";
import { createClient, login, sleep } from "./client.ts";
import { describePreset, getDevice, isDefaultPreset, isStoredPreset, movePreset, requireCamera, requirePtz, type CameraApi } from "./commands/shared.ts";
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
/** Settle polling: never declare "still" before this, poll this often, treat MAD below this as a duplicate frame. */
const SETTLE_MIN_MS = 5000;
const SETTLE_POLL_MS = 2000;
const DUPLICATE_MAD = 0.5;

/** With `EUFY_SNAP_DEBUG_FRAMES=<dir>` every frame the sequence looks at is written there for post-mortems. */
const DEBUG_FRAMES_DIR = process.env.EUFY_SNAP_DEBUG_FRAMES;
let debugFrameSeq = 0;
function dumpFrame(name: string, jpeg: Buffer): void {
  if (!DEBUG_FRAMES_DIR) return;
  try {
    fs.mkdirSync(DEBUG_FRAMES_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_FRAMES_DIR, `${String(debugFrameSeq++).padStart(2, "0")}-${name.replace(/[^\w.-]+/g, "_")}.jpg`), jpeg);
  } catch {
    // diagnostics only
  }
}

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
      dumpFrame(`shot-attempt${attempt}`, shot.jpeg);
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

/**
 * One best-effort frame used only for position comparison (the comparator downsamples, so any
 * resolution will do). Returns undefined rather than failing the run.
 */
async function quickFrame(cam: CameraApi, cfg: AppConfig["capture"], what: string): Promise<Buffer | undefined> {
  if (!cam.snapshotLive) return undefined;
  try {
    const shot = await cam.snapshotLive({ powered: "battery", skipKeyframes: cfg.skipKeyframes });
    if (shot.retained) {
      warn(`${what}: camera returned a retained (stale) still — skipping this check`);
      return undefined;
    }
    debug(`${what} frame`, { width: shot.width, height: shot.height });
    dumpFrame(what, shot.jpeg);
    return shot.jpeg;
  } catch (e) {
    warn(`${what}: snapshot failed (${errorMessage(e)}) — skipping this check`);
    return undefined;
  }
}

interface Settled {
  /** Last frame seen; undefined if frames could not be had (we then just waited out `maxMs`). */
  frame?: Buffer;
  ms: number;
  /** Frames were still changing when `maxMs` ran out. */
  timedOut: boolean;
}

/**
 * Wait for a move to finish by polling frames every couple of seconds until two consecutive ones show
 * the same view (a long pan on the S340 takes ~16 s; a zero-distance move none). Polling also keeps the
 * live stream warm — letting it go cold for 20 s and restarting it is flaky on this camera — and it
 * guarantees we never issue the next PTZ command mid-pan, which lands the camera somewhere random.
 * Identical decoded frames (MAD ≈ 0, the stream re-serving a keyframe) are ignored.
 */
async function settleUntilStill(cam: CameraApi, cfg: AppConfig, from: Buffer | undefined, maxMs: number, what: string): Promise<Settled> {
  const t0 = Date.now();
  const { maxShift, maxMad } = cfg.capture.verify;
  let prev = from;
  let stillRuns = 0;
  for (;;) {
    await sleep(SETTLE_POLL_MS);
    const cur = await quickFrame(cam, cfg.capture, what);
    const elapsed = Date.now() - t0;
    if (!cur) {
      if (elapsed < maxMs) await sleep(maxMs - elapsed);
      return { ms: Date.now() - t0, timedOut: false };
    }
    if (prev) {
      const r = frameShift(prev, cur);
      if (r.mad >= DUPLICATE_MAD) stillRuns = Math.abs(r.fraction) <= maxShift && r.mad <= maxMad ? stillRuns + 1 : 0;
      debug(`${what} +${(elapsed / 1000).toFixed(1)}s: ${describeShift(r)} vs previous`);
    }
    prev = cur;
    if (stillRuns >= 1 && elapsed >= SETTLE_MIN_MS) return { frame: cur, ms: elapsed, timedOut: false };
    if (elapsed >= maxMs) {
      warn(`${what}: view still changing after ${(maxMs / 1000).toFixed(0)} s — proceeding anyway`);
      return { frame: cur, ms: elapsed, timedOut: true };
    }
  }
}

function firmwareOf(dev: Device): string | undefined {
  const raw = (dev as unknown as { raw?: Record<string, unknown> }).raw;
  const v = raw?.main_sw_version;
  return typeof v === "string" ? v : undefined;
}

/**
 * The daily sequence: pre-move frame → move(shoot) → settle → capture → verify against the reference
 * and against the pre-move frame (retry the move once) → move(home) → confirm → save. Throws
 * `NeedsHumanError` (login), `CaptureError`, or a plain Error for configuration problems; anything
 * that merely degrades the result is recorded in the sidecar.
 *
 * `home` is `home_preset` if set, else the camera's default preset. The S340 returns to its default by
 * itself ~1 min after a live session ends, so the pre-move frame shows the camera *at its default*;
 * the return-home check against that frame is only meaningful when home is the default.
 */
export async function runDaily(cfg: AppConfig, opts: DailyOptions): Promise<DailyOutcome> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const { shootPreset, settleMs } = cfg.camera;
  const { maxShift, maxMad } = cfg.capture.verify;
  /** Aligned with the other frame (position-wise). */
  const aligned = (r: ShiftResult): boolean => Math.abs(r.fraction) <= maxShift;
  /** Same view: aligned and nearly identical pixels — only meaningful for frames seconds apart. */
  const sameView = (r: ShiftResult): boolean => aligned(r) && r.mad <= maxMad;

  const eufy = createClient();
  eufy.on("ptzNotify", (e) => debug("ptzNotify", e as unknown as Record<string, unknown>));
  eufy.on("commandAck", (e) => debug("commandAck", e as unknown as Record<string, unknown>));
  await login(eufy, false);
  const dev = await getDevice(eufy, cfg.camera.serial);
  const ptz = requirePtz(dev);
  const cam = requireCamera(dev);
  const preset = ptz.preset();
  info("connected", { serial: dev.sn, model: dev.modelName, firmware: firmwareOf(dev) });

  let verify: Sidecar["verify"];
  let motion: Sidecar["motion"];
  let returnedHome = false;
  let before: Buffer | undefined;
  /** Most recent frame we hold, so the return-home settle has something to diff against. */
  let lastFrame: Buffer | undefined;
  let homePreset: number | undefined = cfg.camera.homePreset;
  let cameraDefault: number | undefined;
  let shot: Shot;
  try {
    const presets = (await withP2pRetry("preset list", () => preset.list?.() ?? Promise.resolve([]))) ?? [];
    const stored = presets.filter(isStoredPreset).map((p) => p.id);
    cameraDefault = presets.find(isDefaultPreset)?.id;
    if (homePreset === undefined) {
      homePreset = cameraDefault;
      if (homePreset === undefined) throw new Error("home_preset is not set and the camera did not report a default preset");
      info(`home = camera default ${describePreset(homePreset)}`);
    } else if (cameraDefault !== undefined && cameraDefault !== homePreset) {
      warnings.push(
        `home_preset ${homePreset} is not the camera's default ${describePreset(cameraDefault)} — the camera moves back to its default by itself ` +
          `about a minute after each run; set home_preset: ${cameraDefault}, or make "preset ${homePreset + 1}" the default in the Eufy app`,
      );
      warn(warnings.at(-1)!);
    }
    if (shootPreset === homePreset) warn("shoot preset equals home preset — the camera will not move for the shot");
    for (const [name, id] of [
      ["shoot_preset", shootPreset],
      ["home_preset", homePreset],
    ] as const) {
      if (stored.length && !stored.includes(id)) throw new Error(`${name} ${id} is not stored on the camera (stored: ${stored.join(", ")})`);
    }

    before = await quickFrame(cam, cfg.capture, "pre-move");
    lastFrame = before;
    info(`move to preset ${shootPreset}`);
    await withP2pRetry("move", () => movePreset(ptz, shootPreset));
    let settled = await settleUntilStill(cam, cfg, before, settleMs, "settle");
    info(`settled in ${(settled.ms / 1000).toFixed(1)} s${settled.timedOut ? " (timed out)" : ""}`);
    shot = await capture(cam, cfg.capture);
    lastFrame = shot.jpeg;
    info("captured", { width: shot.width, height: shot.height, attempts: shot.attempts });

    const reference = !opts.asReference && fs.existsSync(cfg.paths.reference) ? fs.readFileSync(cfg.paths.reference) : undefined;
    let r = reference ? frameShift(reference, shot.jpeg) : undefined;
    let m = before ? frameShift(before, shot.jpeg) : undefined;
    if (r) info(`verify vs reference: ${describeShift(r)}`);
    if (m) info(`motion vs pre-move frame: ${describeShift(m)}`);

    // Retry the move when we're visibly off the reference, or when nothing moved and we cannot
    // prove we were already on the preset.
    const offReference = r !== undefined && !aligned(r);
    const stuck = m !== undefined && sameView(m) && !(r !== undefined && aligned(r));
    let retried = false;
    if (offReference || stuck) {
      retried = true;
      warn(`${offReference ? "off preset" : "camera did not move"} — re-issuing move and re-shooting`);
      if (settled.timedOut) {
        // A move issued while the camera is still panning lands somewhere else entirely; let the
        // first pan finish before re-issuing.
        warn("the camera was still moving when the shot was taken (settle_ms is too short for this pan) — waiting for it to stop first");
        const late = await settleUntilStill(cam, cfg, shot.jpeg, settleMs * 2, "settle (finish pan)");
        info(`pan finished after ${(late.ms / 1000).toFixed(1)} s more${late.timedOut ? " (timed out)" : ""}`);
      }
      await withP2pRetry("move (retry)", () => movePreset(ptz, shootPreset));
      settled = await settleUntilStill(cam, cfg, shot.jpeg, settleMs * 2, "settle (retry)");
      info(`settled in ${(settled.ms / 1000).toFixed(1)} s${settled.timedOut ? " (timed out)" : ""}`);
      const again = await capture(cam, cfg.capture);
      lastFrame = again.jpeg;
      const r2 = reference ? frameShift(reference, again.jpeg) : undefined;
      const m2 = before ? frameShift(before, again.jpeg) : undefined;
      if (r2) info(`verify after retry: ${describeShift(r2)}`);
      if (m2) info(`motion after retry: ${describeShift(m2)}`);
      const better = r && r2 ? aligned(r2) || Math.abs(r2.fraction) < Math.abs(r.fraction) : m2 ? !sameView(m2) : true;
      if (better) {
        shot = { ...again, attempts: shot.attempts + again.attempts };
        r = r2;
        m = m2;
      }
    }

    if (m) motion = { shift: m.fraction, mad: m.mad, moved: !sameView(m) };
    if (r) {
      const onPreset = aligned(r);
      if (onPreset && r.mad > maxMad) {
        warnings.push(`verify uncertain: aligned but MAD ${r.mad.toFixed(1)} > ${maxMad} (lighting? mount drift?)`);
      }
      if (!onPreset) warnings.push(`off preset: ${describeShift(r)}`);
      verify = { shift: r.fraction, mad: r.mad, onPreset, retried };
    } else if (!opts.asReference) {
      warnings.push("no reference.jpg — position not verified (run `eufy-snap reference`)");
    }
    if (motion && !motion.moved && !verify?.onPreset) {
      warnings.push(
        `camera did not move for the shot (${describeShift(m!)} vs pre-move frame)` +
          (opts.asReference ? " — fine if it was already parked on the shoot preset; check the reference image" : ""),
      );
    }
  } finally {
    try {
      if (homePreset === undefined) throw new Error("no home preset resolved");
      info(`return to preset ${homePreset}`);
      await movePreset(ptz, homePreset);
      const home = await settleUntilStill(cam, cfg, lastFrame, settleMs, "return-home");
      info(`settled in ${(home.ms / 1000).toFixed(1)} s${home.timedOut ? " (timed out)" : ""}`);
      returnedHome = true;
      // The pre-move frame shows the camera at rest, i.e. at its default preset — so it is only a valid
      // "home" witness when home *is* the default, and only when the camera demonstrably left it.
      const restIsHome = cameraDefault === undefined || cameraDefault === homePreset;
      if (before && motion?.moved && home.frame && restIsHome) {
        const h = frameShift(before, home.frame);
        info(`return-home check vs pre-move frame: ${describeShift(h)}`);
        if (!sameView(h)) {
          returnedHome = false;
          warnings.push(`camera did not return to its pre-move position (${describeShift(h)})`);
        }
      } else if (before && motion?.moved && !restIsHome) {
        info(`return-home check skipped: the pre-move frame is the camera default (${cameraDefault}), not home ${homePreset}`);
      }
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
    ...(opts.plan ? { event: opts.plan.event, eventAt: opts.plan.eventAt.toISOString(), fireAt: opts.plan.fireAt.toISOString() } : {}),
    shotAt: new Date().toISOString(),
    timezone: cfg.location.timezone,
    camera: { serial: dev.sn, model: dev.modelName, ...(firmware ? { firmware } : {}) },
    presets: { shoot: shootPreset, home: homePreset!, ...(cameraDefault !== undefined ? { cameraDefault } : {}) },
    image: { width: shot.width, height: shot.height, bytes: shot.jpeg.length, attempts: shot.attempts },
    ...(verify ? { verify } : {}),
    ...(motion ? { motion } : {}),
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
