import fs from "node:fs";
import path from "node:path";
import { localDate, localTime } from "./sun.ts";

/** Everything worth knowing about one photo, written next to it as JSON. */
export interface Sidecar {
  date: string;
  reason: "scheduled" | "catch-up" | "manual" | "reference";
  sunrise?: string;
  fireAt?: string;
  shotAt: string;
  timezone: string;
  camera: { serial: string; model: string; firmware?: string };
  presets: { shoot: number; home: number };
  image: { width: number; height: number; bytes: number; attempts: number };
  verify?: { shift: number; mad: number; onPreset: boolean; retried: boolean };
  offPreset: boolean;
  returnedHome: boolean;
  durationMs: number;
  warnings: string[];
  tool: { version: string; sdk: string };
}

export interface SavedPhoto {
  file: string;
  sidecar: string;
}

/** Path a scheduled photo for `date` would have — used to answer "did today already happen?". */
export function scheduledPhotoPath(dir: string, date: string): string {
  return path.join(dir, date.slice(0, 4), `${date}.jpg`);
}

/**
 * Save `photos/YYYY/YYYY-MM-DD.jpg` + `.json`. If that name is taken (a manual `snap` after the
 * scheduled run, say) fall back to `YYYY-MM-DD_HHMM.jpg` so nothing is ever overwritten.
 */
export function savePhoto(dir: string, jpeg: Buffer, meta: Sidecar, tz: string): SavedPhoto {
  const year = meta.date.slice(0, 4);
  fs.mkdirSync(path.join(dir, year), { recursive: true });
  let base = meta.date;
  if (fs.existsSync(path.join(dir, year, `${base}.jpg`))) {
    base = `${meta.date}_${localTime(new Date(meta.shotAt), tz).replace(":", "")}`;
    let n = 1;
    while (fs.existsSync(path.join(dir, year, `${base}.jpg`))) base = `${meta.date}_${localTime(new Date(meta.shotAt), tz).replace(":", "")}-${n++}`;
  }
  const file = path.join(dir, year, `${base}.jpg`);
  const sidecar = path.join(dir, year, `${base}.json`);
  fs.writeFileSync(file, jpeg);
  fs.writeFileSync(sidecar, JSON.stringify(meta, null, 2) + "\n");
  return { file, sidecar };
}

export function todayHasPhoto(dir: string, now: Date, tz: string): boolean {
  return fs.existsSync(scheduledPhotoPath(dir, localDate(now, tz)));
}
