import fs from "node:fs";
import path from "node:path";
import { localDate, localTime, type SunEvent } from "./sun.ts";

/** Everything worth knowing about one photo, written next to it as JSON. */
export interface Sidecar {
  date: string;
  reason: "scheduled" | "catch-up" | "manual" | "reference";
  /** The sun event the schedule is anchored to and when it happened (ISO). */
  event?: SunEvent;
  eventAt?: string;
  fireAt?: string;
  shotAt: string;
  timezone: string;
  camera: { serial: string; model: string; firmware?: string };
  /** Camera slots (0-based). `cameraDefault` is the slot the camera returns to by itself after a session. */
  presets: { shoot: number; home: number; cameraDefault?: number };
  image: { width: number; height: number; bytes: number; attempts: number };
  /** Shot vs the stored reference image (needs `reference.jpg`). */
  verify?: { shift: number; mad: number; onPreset: boolean; retried: boolean };
  /** Shot vs a frame taken just before the move — proves the camera actually went somewhere. */
  motion?: { shift: number; mad: number; moved: boolean };
  offPreset: boolean;
  /** Return-home command succeeded and, when checkable, the frame matched the pre-move one again. */
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
 * Save `photos/YYYY/YYYY-MM-DD.jpg` + `.json`. Only the scheduled run (and its catch-up) may claim
 * that name — `run` treats its existence as "today is done". A manual `snap` always saves as
 * `YYYY-MM-DD_HHMM.jpg`, so testing during the day never suppresses the evening shot. Nothing is
 * ever overwritten.
 */
export function savePhoto(dir: string, jpeg: Buffer, meta: Sidecar, tz: string): SavedPhoto {
  const year = meta.date.slice(0, 4);
  fs.mkdirSync(path.join(dir, year), { recursive: true });
  const canonical = meta.reason === "scheduled" || meta.reason === "catch-up";
  let base = meta.date;
  if (!canonical || fs.existsSync(path.join(dir, year, `${base}.jpg`))) {
    const stamped = `${meta.date}_${localTime(new Date(meta.shotAt), tz).replace(":", "")}`;
    base = stamped;
    let n = 1;
    while (fs.existsSync(path.join(dir, year, `${base}.jpg`))) base = `${stamped}-${n++}`;
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
