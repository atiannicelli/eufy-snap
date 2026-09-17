import { PtzDirection } from "@mega-yfue/eufy-sdk";
import { connect, sleep } from "../client.ts";
import { getDevice, requirePtz, stopwatch } from "./shared.ts";

export interface RotateOptions {
  delay: string;
  speed?: string;
}

export function parseDirection(v: string): PtzDirection {
  if (v in PtzDirection) return PtzDirection[v as keyof typeof PtzDirection];
  throw new Error(`bad direction "${v}" — one of ${Object.keys(PtzDirection).join("|")}`);
}

/** Step the camera `n` times in a direction, logging any PTZ status the camera streams back. */
export async function rotateCommand(sn: string, dir: string, n: string, opts: RotateOptions): Promise<void> {
  const direction = parseDirection(dir);
  const steps = Number(n);
  const eufy = await connect(false);
  const dev = await getDevice(eufy, sn);
  const ptz = requirePtz(dev);
  const elapsed = stopwatch();

  eufy.on("ptzNotify", (e) => console.log(`[${elapsed()}] ptzNotify ${JSON.stringify(e)}`));
  eufy.on("commandAck", (e) => console.log(`[${elapsed()}] ack ${JSON.stringify(e)}`));

  if (opts.speed !== undefined) {
    console.log(`[${elapsed()}] setRotationSpeed(${opts.speed}) (was ${ptz.rotationSpeed ?? "unset"})`);
    await ptz.setRotationSpeed(Number(opts.speed));
  }
  for (let i = 1; i <= steps; i++) {
    await ptz.rotate(direction);
    console.log(`[${elapsed()}] step ${i}/${steps} ${direction}`);
    if (i < steps) await sleep(Number(opts.delay));
  }
  // Leave P2P open briefly so trailing status frames are observed.
  await sleep(3000);
  await eufy.disconnect();
}
