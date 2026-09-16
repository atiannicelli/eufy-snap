import fs from "node:fs";
import path from "node:path";
import { ffmpegAvailable } from "@mega-yfue/eufy-sdk";
import { connect, sleep } from "../client.ts";
import { getDevice, requireCamera, stopwatch, ts } from "./shared.ts";

export interface SnapshotOptions {
  retries: string;
  out?: string;
}

/** Take a fresh JPEG from the live stream (wakes a battery camera) with retries and timings. */
export async function snapshotCommand(sn: string, opts: SnapshotOptions): Promise<void> {
  if (!(await ffmpegAvailable(process.env.FFMPEG_PATH))) {
    throw new Error("ffmpeg not found — `brew install ffmpeg` or set FFMPEG_PATH");
  }
  const eufy = await connect(false);
  const dev = await getDevice(eufy, sn);
  const cam = requireCamera(dev);
  if (!cam.snapshotLive) throw new Error(`${sn}: snapshotLive not available (device not bound to a live client?)`);
  const elapsed = stopwatch();
  console.log(`[${elapsed()}] battery=${dev.has("battery")} enabled=${cam.enabled ?? "unknown"}`);

  const attempts = Number(opts.retries);
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`[${elapsed()}] snapshotLive attempt ${i}/${attempts} …`);
      const shot = await cam.snapshotLive();
      const file = opts.out ?? path.join("out", `${sn}-${ts()}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, shot.jpeg);
      console.log(`[${elapsed()}] ${shot.width}x${shot.height} ${shot.jpeg.length} bytes → ${file}`);
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[${elapsed()}] attempt ${i} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (i < attempts) await sleep(3000 * i);
    }
  }
  await eufy.disconnect();
  if (lastErr) throw lastErr;
}
