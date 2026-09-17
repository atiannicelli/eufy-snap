import { PtzDirection } from "@mega-yfue/eufy-sdk";
import { createClient, login, sleep } from "../client.ts";
import { getDevice, requirePtz, stopwatch } from "./shared.ts";

export interface WatchOptions {
  seconds: string;
  nudge?: boolean;
}

/**
 * Hold a P2P session open and dump every PTZ status frame the camera sends, verbatim. Drive the camera
 * from the Eufy app meanwhile (or pass --nudge to step left then right). The point is to learn whether
 * the S340's rotate notify (cmd 6030) carries any position information we could verify against.
 */
export async function watchCommand(sn: string, opts: WatchOptions): Promise<void> {
  const seconds = Number(opts.seconds);
  const eufy = createClient({ p2pIdleMs: (seconds + 30) * 1000 });
  await login(eufy, false);
  const dev = await getDevice(eufy, sn);
  const ptz = requirePtz(dev);
  const elapsed = stopwatch();

  eufy.on("ptzNotify", (e) => console.log(`[${elapsed()}] ptzNotify ${JSON.stringify(e)}`));
  eufy.on("deviceState", (s) => {
    if (s.sn === sn) console.log(`[${elapsed()}] deviceState ${JSON.stringify(s)}`);
  });
  eufy.on("commandAck", (e) => console.log(`[${elapsed()}] ack ${JSON.stringify(e)}`));
  eufy.on("message", (m) => console.log(`[${elapsed()}] message ${JSON.stringify(m).slice(0, 400)}`));

  // A read over P2P opens the connection so status frames start flowing.
  const presets = (await ptz.preset().list?.()) ?? [];
  console.log(`[${elapsed()}] P2P open; presets: ${presets.map((p) => p.id).join(", ") || "(none)"}`);
  console.log(`[${elapsed()}] watching for ${seconds}s — move the camera from the Eufy app now`);

  if (opts.nudge) {
    await sleep(2000);
    console.log(`[${elapsed()}] nudge: left`);
    await ptz.rotate(PtzDirection.left);
    await sleep(5000);
    console.log(`[${elapsed()}] nudge: right`);
    await ptz.rotate(PtzDirection.right);
  }

  await sleep(seconds * 1000);
  await eufy.disconnect();
}
