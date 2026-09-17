import fs from "node:fs";
import path from "node:path";
import { connect, sleep } from "../client.ts";
import { parseDirection } from "./rotate.ts";
import { getDevice, isStoredPreset, movePreset, requireCamera, requirePtz, stopwatch, ts } from "./shared.ts";

export interface SequenceOptions {
  home: string;
  dir: string;
  steps: string;
  stepDelay: string;
  settle: string;
  return: boolean;
}

/**
 * Rehearse the daily sequence end to end, with timings:
 *   goto(home) → settle → rotate × steps → settle → snapshotLive → goto(home)
 * Phase 0 exit criterion: this completes on the real S340 and the JPEG shows the expected view.
 */
export async function sequenceCommand(sn: string, opts: SequenceOptions): Promise<void> {
  const home = Number(opts.home);
  const steps = Number(opts.steps);
  const direction = parseDirection(opts.dir);
  const stepDelay = Number(opts.stepDelay);
  const settle = Number(opts.settle);

  const eufy = await connect(false);
  const dev = await getDevice(eufy, sn);
  const ptz = requirePtz(dev);
  const cam = requireCamera(dev);
  if (!cam.snapshotLive) throw new Error(`${sn}: snapshotLive not available`);
  const elapsed = stopwatch();
  const notifies: unknown[] = [];
  eufy.on("ptzNotify", (e) => notifies.push({ t: elapsed(), ...e }));

  const preset = ptz.preset();
  const list = ((await preset.list?.()) ?? []).filter(isStoredPreset);
  if (!list.some((p) => p.id === home)) {
    throw new Error(`home preset ${home} not stored on camera (have: ${list.map((p) => p.id).join(", ") || "none"})`);
  }

  console.log(`[${elapsed()}] move to home preset ${home}`);
  await movePreset(ptz, home);
  await sleep(settle);

  console.log(`[${elapsed()}] ${steps} step(s) ${direction}, ${stepDelay}ms apart`);
  for (let i = 0; i < steps; i++) {
    await ptz.rotate(direction);
    if (i < steps - 1) await sleep(stepDelay);
  }
  await sleep(settle);

  console.log(`[${elapsed()}] snapshotLive …`);
  let file: string | undefined;
  try {
    const shot = await cam.snapshotLive();
    fs.mkdirSync("out", { recursive: true });
    file = path.join("out", `sequence-${ts()}.jpg`);
    fs.writeFileSync(file, shot.jpeg);
    console.log(`[${elapsed()}] ${shot.width}x${shot.height} → ${file}`);
  } catch (e) {
    console.error(`[${elapsed()}] snapshot FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (opts.return) {
    console.log(`[${elapsed()}] return to home preset ${home}`);
    await movePreset(ptz, home);
    await sleep(2000);
  }

  console.log(`[${elapsed()}] done — ${notifies.length} ptzNotify frame(s) observed`);
  for (const n of notifies) console.log(`    ${JSON.stringify(n)}`);
  await eufy.disconnect();
  if (!file) process.exitCode = 30;
}
