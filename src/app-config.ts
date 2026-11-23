import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { stateDir } from "./config.ts";
import { describeSchedule, shotSuffix, SUN_EVENTS, type SunEvent, type SunSchedule } from "./sun.ts";

/** A full pan between presets takes up to ~18 s on the S340; a shorter settle cap means mid-pan shots. */
const MIN_SANE_SETTLE_MS = 15_000;

export interface ScheduledShot extends SunSchedule {
  /** Appended to the dated file name. The first shot has none and keeps the bare `YYYY-MM-DD` name. */
  fileSuffix: string | undefined;
}

/** Fully resolved, validated application configuration (see config.example.yaml). */
export interface AppConfig {
  location: { lat: number; lon: number; timezone: string };
  camera: {
    serial: string;
    shootPreset: number;
    /** Where to park after the shot. Unset = the camera's own default preset, which is where it rests anyway. */
    homePreset: number | undefined;
    settleMs: number;
    /** Switch motion detection off for the duration of the run so tracking cannot yank the camera; restored afterwards. */
    pauseMotionDetection: boolean;
  };
  schedule: {
    /** The day's shots in config order; never empty. */
    shots: readonly [ScheduledShot, ...ScheduledShot[]];
    daemonStart: { hour: number; minute: number };
    catchUpMaxMin: number;
    /** Keep re-trying a run that could not reach the camera until fireAt + this many minutes. */
    retryWindowMin: number;
  };
  capture: {
    retries: number;
    minWidth: number;
    minWidthWaitMs: number;
    skipKeyframes: number;
    verify: { maxShift: number; maxMad: number };
  };
  store: { dir: string };
  telegram: { chatIdEnv: string; botTokenEnv: string };
  daemon: { label: string; user: string | undefined };
  /** Derived paths. */
  paths: { config: string; reference: string; lock: string; logs: string; motionPaused: string };
}

export function configFile(explicit?: string): string {
  return explicit ?? process.env.EUFY_SNAP_CONFIG ?? path.join(stateDir(), "config.yaml");
}

type Raw = Record<string, unknown>;

function section(raw: Raw, key: string): Raw {
  const v = raw[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`config: "${key}" must be a mapping`);
  return v as Raw;
}

function num(sec: Raw, key: string, fallback: number | undefined, where: string): number {
  const v = sec[key];
  if (v === undefined || v === null) {
    if (fallback === undefined) throw new Error(`config: "${where}.${key}" is required`);
    return fallback;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`config: "${where}.${key}" must be a number`);
  return v;
}

function bool(sec: Raw, key: string, fallback: boolean, where: string): boolean {
  const v = sec[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new Error(`config: "${where}.${key}" must be true or false`);
  return v;
}

function str(sec: Raw, key: string, fallback: string | undefined, where: string): string {
  const v = sec[key];
  if (v === undefined || v === null) {
    if (fallback === undefined) throw new Error(`config: "${where}.${key}" is required`);
    return fallback;
  }
  if (typeof v !== "string" || v.length === 0) throw new Error(`config: "${where}.${key}" must be a non-empty string`);
  return v;
}

function optStr(sec: Raw, key: string, where: string): string | undefined {
  return sec[key] === undefined || sec[key] === null ? undefined : str(sec, key, undefined, where);
}

function optNum(sec: Raw, key: string, where: string): number | undefined {
  return sec[key] === undefined || sec[key] === null ? undefined : num(sec, key, undefined, where);
}

function parseHHMM(v: string, where: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!m || hour > 23 || minute > 59) throw new Error(`config: "${where}" must be HH:MM, got "${v}"`);
  return { hour, minute };
}

function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`config: "location.timezone" is not a valid IANA timezone: "${tz}"`);
  }
}

function sunEvent(sec: Raw, fallback: string | undefined, where: string): SunEvent {
  const event = str(sec, "event", fallback, where);
  if (!(SUN_EVENTS as readonly string[]).includes(event)) throw new Error(`config: "${where}.event" must be one of ${SUN_EVENTS.join(", ")}, got "${event}"`);
  return event as SunEvent;
}

/** `schedule.shots`, or the single shot described by `schedule.event` / `schedule.offset_min`. */
function parseShots(schedule: Raw): AppConfig["schedule"]["shots"] {
  let shots: SunSchedule[];
  const list = schedule.shots;
  if (list === undefined || list === null) {
    const event = sunEvent(schedule, "sunrise", "schedule");
    let offsetMin = optNum(schedule, "offset_min", "schedule");
    if (offsetMin === undefined && schedule.sunrise_offset_min !== undefined) {
      if (event !== "sunrise") throw new Error(`config: "schedule.sunrise_offset_min" makes no sense with event "${event}" — use "offset_min"`);
      console.warn('config: "schedule.sunrise_offset_min" is deprecated — rename it to "offset_min"');
      offsetMin = num(schedule, "sunrise_offset_min", undefined, "schedule");
    }
    shots = [{ event, offsetMin: offsetMin ?? 0 }];
  } else {
    if (!Array.isArray(list) || list.length === 0) throw new Error('config: "schedule.shots" must be a non-empty list');
    for (const key of ["event", "offset_min", "sunrise_offset_min"]) {
      if (schedule[key] !== undefined) throw new Error(`config: "schedule.${key}" cannot be combined with "schedule.shots" — move it into the list`);
    }
    shots = list.map((item: unknown, i) => {
      const where = `schedule.shots[${i}]`;
      if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`config: "${where}" must be a mapping with event and offset_min`);
      return { event: sunEvent(item as Raw, undefined, where), offsetMin: num(item as Raw, "offset_min", 0, where) };
    });
  }
  const seen = new Set<string>();
  for (const s of shots) {
    if (seen.has(shotSuffix(s))) throw new Error(`config: "schedule.shots" lists ${describeSchedule(s)} more than once`);
    seen.add(shotSuffix(s));
  }
  const [first, ...extra] = shots;
  if (!first) throw new Error('config: "schedule.shots" must be a non-empty list');
  return [{ ...first, fileSuffix: undefined }, ...extra.map((s) => ({ ...s, fileSuffix: shotSuffix(s) }))];
}

export function loadConfig(explicit?: string): AppConfig {
  const file = configFile(explicit);
  if (!fs.existsSync(file)) {
    throw new Error(`config not found at ${file} — copy config.example.yaml there and edit it (or set EUFY_SNAP_CONFIG)`);
  }
  const raw = (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as Raw;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`config: top level of ${file} must be a mapping`);

  const location = section(raw, "location");
  const camera = section(raw, "camera");
  const schedule = section(raw, "schedule");
  const capture = section(raw, "capture");
  const verify = section(capture, "verify");
  const store = section(raw, "store");
  const telegram = section(raw, "telegram");
  const daemon = section(raw, "daemon");
  const dir = stateDir();

  const timezone = str(location, "timezone", undefined, "location");
  assertTimezone(timezone);

  const shots = parseShots(schedule);
  // The launchd trigger must precede the earliest fire time of the year: pre-dawn for sunrise, noon for sunset.
  const defaultDaemonStart = shots.some((s) => s.event === "sunrise") ? "04:00" : "12:00";

  const cfg: AppConfig = {
    location: {
      lat: num(location, "lat", undefined, "location"),
      lon: num(location, "lon", undefined, "location"),
      timezone,
    },
    camera: {
      serial: str(camera, "serial", undefined, "camera"),
      shootPreset: num(camera, "shoot_preset", undefined, "camera"),
      homePreset: optNum(camera, "home_preset", "camera"),
      settleMs: num(camera, "settle_ms", 20_000, "camera"),
      pauseMotionDetection: bool(camera, "pause_motion_detection", true, "camera"),
    },
    schedule: {
      shots,
      daemonStart: parseHHMM(str(schedule, "daemon_start", defaultDaemonStart, "schedule"), "schedule.daemon_start"),
      catchUpMaxMin: num(schedule, "catch_up_max_min", 180, "schedule"),
      retryWindowMin: num(schedule, "retry_window_min", 30, "schedule"),
    },
    capture: {
      retries: num(capture, "retries", 3, "capture"),
      minWidth: num(capture, "min_width", 1920, "capture"),
      minWidthWaitMs: num(capture, "min_width_wait_ms", 4000, "capture"),
      skipKeyframes: num(capture, "skip_keyframes", 0, "capture"),
      verify: {
        maxShift: num(verify, "max_shift", 0.03, "capture.verify"),
        maxMad: num(verify, "max_mad", 25, "capture.verify"),
      },
    },
    store: { dir: path.resolve(dir, str(store, "dir", "photos", "store")) },
    telegram: {
      chatIdEnv: str(telegram, "chat_id_env", "TELEGRAM_CHAT_ID", "telegram"),
      botTokenEnv: str(telegram, "bot_token_env", "TELEGRAM_BOT_TOKEN", "telegram"),
    },
    daemon: {
      label: str(daemon, "label", "com.eufysnap.daily", "daemon"),
      user: optStr(daemon, "user", "daemon"),
    },
    paths: {
      config: file,
      reference: path.join(dir, "reference.jpg"),
      lock: path.join(dir, "run.lock"),
      logs: path.join(dir, "logs"),
      motionPaused: path.join(dir, "motion-paused.json"),
    },
  };
  if (Math.abs(cfg.location.lat) > 90 || Math.abs(cfg.location.lon) > 180) throw new Error("config: lat/lon out of range");
  if (cfg.camera.settleMs < MIN_SANE_SETTLE_MS) {
    console.warn(
      `config: settle_ms ${cfg.camera.settleMs} is shorter than a long pan (~18 s) — shots may be taken mid-pan; ` +
        `set settle_ms: 20000 or remove the line (it is a maximum, the run proceeds as soon as the view is still)`,
    );
  }
  if (cfg.camera.homePreset !== undefined && cfg.camera.shootPreset === cfg.camera.homePreset) {
    console.warn("config: shoot_preset equals home_preset — the camera will not move for the shot");
  }
  return cfg;
}
