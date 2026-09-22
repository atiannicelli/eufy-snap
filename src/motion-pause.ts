import fs from "node:fs";
import type { Device } from "@mega-yfue/eufy-sdk";
import { errorMessage, info, warn } from "./log.ts";

/**
 * Motion detection off for the duration of a run, on again afterwards.
 *
 * The S340 tracks whatever moves in front of it; a tracking event at shoot time either yanks the camera
 * off the preset mid-run or refuses the P2P session outright. Param 1011 (`motionDetection`) is the
 * app's master switch, read *and* write verified by the SDK, so the run turns it off first thing and
 * back on last thing. Because the write is fire-and-forget and a run can be killed half-way, the pause
 * is recorded in a marker file and any later run repairs a switch left off.
 *
 * Only a camera that *reports* detection as on is touched: an owner who turned it off keeps it off, and
 * a camera that does not report the property is left alone rather than guessed at.
 */
export interface MotionPause {
  /** True while detection is switched off by us. */
  readonly active: boolean;
  /** Switch detection back on (idempotent, never throws). */
  restore(): Promise<void>;
}

type MotionApi = NonNullable<ReturnType<NonNullable<Device["motion"]>>>;

function api(dev: Device): MotionApi | undefined {
  return dev.motion?.();
}

function readMarker(file: string): { serial?: string; pausedAt?: string } | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as { serial?: string; pausedAt?: string };
  } catch {
    return undefined;
  }
}

function clearMarker(file: string): void {
  fs.rmSync(file, { force: true });
}

/** A previous run switched detection off and never switched it back: do it now. Call once per session. */
export async function repairMotionDetection(dev: Device, markerFile: string): Promise<void> {
  const marker = readMarker(markerFile);
  if (!marker) return;
  if (marker.serial && marker.serial !== dev.sn) return;
  const m = api(dev);
  warn(`motion detection was left off by an interrupted run (${marker.pausedAt ?? "unknown time"}) — switching it back on`);
  try {
    if (m?.setDetection) await m.setDetection(true);
    clearMarker(markerFile);
  } catch (e) {
    warn(`could not restore motion detection: ${errorMessage(e)}`);
  }
}

export async function pauseMotionDetection(dev: Device, markerFile: string, warnings: string[]): Promise<MotionPause> {
  const none: MotionPause = { active: false, restore: async () => undefined };
  const m = api(dev);
  if (!m?.setDetection) {
    warnings.push("camera exposes no motion-detection switch — tracking may interrupt the shot");
    warn(warnings.at(-1)!);
    return none;
  }
  const on = m.detectionEnabled;
  if (on === undefined) {
    warnings.push("camera does not report whether motion detection is on — leaving it alone (tracking may interrupt the shot)");
    warn(warnings.at(-1)!);
    return none;
  }
  if (!on) {
    info("motion detection is already off — nothing to pause");
    return none;
  }
  info("pausing motion detection for the shot");
  fs.writeFileSync(markerFile, JSON.stringify({ serial: dev.sn, pausedAt: new Date().toISOString() }) + "\n");
  await m.setDetection(false);
  let active = true;
  return {
    get active() {
      return active;
    },
    async restore() {
      if (!active) return;
      try {
        await m.setDetection(true);
        active = false;
        clearMarker(markerFile);
        info("motion detection back on");
      } catch (e) {
        warnings.push(`could not switch motion detection back on: ${errorMessage(e)} — check the Eufy app`);
        warn(warnings.at(-1)!);
      }
    },
  };
}
