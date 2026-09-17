import fs from "node:fs";
import path from "node:path";
import { createClient, login, sleep } from "../client.ts";
import { describeShift, frameShift, type ShiftResult } from "../frame-shift.ts";
import { parseDirection } from "./rotate.ts";
import { getDevice, isStoredPreset, requireCamera, requirePtz, stopwatch, ts } from "./shared.ts";

export interface SweepOptions {
  from?: string;
  dir: string;
  batch: string;
  stepDelay: string;
  settle: string;
  max: string;
  speed?: string;
  range: string;
  zoom: string;
}

/** A batch is "no movement" below this fraction of frame width; two in a row = end-stop. */
const STILL_FRACTION = 0.02;

/**
 * Step the camera in one direction in batches, snapshotting after each, until the view stops
 * changing — i.e. the pan end-stop. Reports steps-to-stop and, given the model's pan range,
 * degrees per step. This is the seed of the Phase 1 `calibrate` command.
 */
export async function sweepCommand(sn: string, opts: SweepOptions): Promise<void> {
  const direction = parseDirection(opts.dir);
  const batch = Number(opts.batch);
  const stepDelay = Number(opts.stepDelay);
  const settle = Number(opts.settle);
  const max = Number(opts.max);
  const range = Number(opts.range);
  const zoom = Number(opts.zoom);

  const eufy = createClient({ p2pIdleMs: 15 * 60_000 });
  await login(eufy, false);
  const dev = await getDevice(eufy, sn);
  const ptz = requirePtz(dev);
  const cam = requireCamera(dev);
  if (!cam.snapshotLive) throw new Error(`${sn}: snapshotLive not available`);
  const elapsed = stopwatch();
  let notifies = 0;
  eufy.on("ptzNotify", () => notifies++);

  if (opts.speed) {
    const speed = Number(opts.speed) as 1 | 3 | 5;
    console.log(`[${elapsed()}] set rotation speed ${speed}`);
    await ptz.setRotationSpeed(speed);
  }

  if (opts.from !== undefined) {
    const from = Number(opts.from);
    const preset = ptz.preset();
    const list = ((await preset.list?.()) ?? []).filter(isStoredPreset);
    if (!list.some((p) => p.id === from)) throw new Error(`preset ${from} not stored on camera`);
    console.log(`[${elapsed()}] goto preset ${from}`);
    await preset.goto(from);
    await sleep(settle * 2);
  }

  const dir = path.join("out", `sweep-${ts()}`);
  fs.mkdirSync(dir, { recursive: true });
  const shoot = async (name: string): Promise<Buffer> => {
    const shot = await cam.snapshotLive!();
    fs.writeFileSync(path.join(dir, `${name}.jpg`), shot.jpeg);
    console.log(`[${elapsed()}]   ${shot.width}x${shot.height} → ${dir}/${name}.jpg`);
    return shot.jpeg;
  };

  console.log(`[${elapsed()}] baseline snapshot`);
  let prev = await shoot("00-start");

  const batches: ShiftResult[] = [];
  let stepsSent = 0;
  while (stepsSent < max) {
    console.log(`[${elapsed()}] batch ${batches.length + 1}: ${batch} step(s) ${direction} (zoom ${zoom})`);
    for (let i = 0; i < batch; i++) {
      await ptz.rotate(direction, zoom);
      if (i < batch - 1) await sleep(stepDelay);
    }
    stepsSent += batch;
    await sleep(settle);
    const cur = await shoot(String(batches.length + 1).padStart(2, "0"));
    const r = frameShift(prev, cur);
    batches.push(r);
    console.log(`[${elapsed()}]   ${describeShift(r)}`);
    prev = cur;
    const still = batches.slice(-2).filter((b) => Math.abs(b.fraction) < STILL_FRACTION).length;
    if (still === 2) break;
  }

  await eufy.disconnect();
  console.log(`\n[${elapsed()}] done — ${stepsSent} step(s) sent, ${batches.length} batch(es), ${notifies} ptzNotify frame(s)`);

  const last = batches.at(-1);
  if (!last || Math.abs(last.fraction) >= STILL_FRACTION) {
    console.log(`no end-stop detected within ${max} steps — raise --max or check the camera actually moved`);
    process.exitCode = 30;
    return;
  }
  // Two still batches end the sweep; the stop was reached during the last *moving* batch. Estimate how
  // many of its steps landed by comparing its shift with the median shift of the earlier (complete) batches.
  const moving = batches.slice(0, -2);
  const full = moving.slice(0, -1).map((b) => Math.abs(b.fraction)).sort((a, b) => a - b);
  const median = full.length ? full[Math.floor(full.length / 2)] : undefined;
  const partialBatch = moving.at(-1);
  let stepsToStop: number;
  if (median && partialBatch) {
    const landed = Math.min(batch, Math.round((Math.abs(partialBatch.fraction) / median) * batch));
    stepsToStop = (moving.length - 1) * batch + landed;
    console.log(`per-batch shift (median of complete batches): ${(median * 100).toFixed(1)}% of width`);
    console.log(`last moving batch: ${(Math.abs(partialBatch.fraction) * 100).toFixed(1)}% → ~${landed}/${batch} step(s) landed`);
  } else {
    stepsToStop = moving.length * batch;
  }
  console.log(`steps from start to end-stop: ~${stepsToStop}`);
  if (opts.from !== undefined) {
    console.log(`if the start was the opposite end-stop and pan range is ${range}°: ~${(range / stepsToStop).toFixed(2)}°/step`);
  }
}
