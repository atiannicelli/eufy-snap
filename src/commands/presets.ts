import fs from "node:fs";
import path from "node:path";
import { connect, sleep } from "../client.ts";
import { getDevice, requirePtz, stopwatch } from "./shared.ts";

export interface PresetsOptions {
  goto?: string;
  save?: string;
  image?: string;
  setDefault?: string;
  settle: string;
}

/** Inspect and exercise stored presets. Preset writes are fire-and-forget (no ack from the camera). */
export async function presetsCommand(sn: string, opts: PresetsOptions): Promise<void> {
  const eufy = await connect(false);
  const dev = await getDevice(eufy, sn);
  const ptz = requirePtz(dev);
  const preset = ptz.preset();
  const elapsed = stopwatch();

  const list = (await preset.list?.()) ?? [];
  console.log(`[${elapsed()}] ${list.length} stored preset(s): ${list.map((p) => p.id).join(", ") || "(none)"}`);
  for (const p of list) console.log(`    #${p.id} ${JSON.stringify(p.raw)}`);

  if (opts.save !== undefined) {
    const id = Number(opts.save);
    console.log(`[${elapsed()}] saving CURRENT position into preset ${id} …`);
    await preset.save(id);
  }
  if (opts.goto !== undefined) {
    const id = Number(opts.goto);
    if (!list.some((p) => p.id === id)) console.warn(`  warning: preset ${id} not in list — goto will be a silent no-op`);
    console.log(`[${elapsed()}] goto preset ${id} …`);
    await preset.goto(id);
    await sleep(Number(opts.settle));
    console.log(`[${elapsed()}] settled`);
  }
  if (opts.setDefault !== undefined) {
    const id = Number(opts.setDefault);
    console.log(`[${elapsed()}] preview ${id} → settle → setDefault ${id} …`);
    await preset.preview(id);
    await sleep(Number(opts.settle));
    await preset.setDefault(id);
  }
  if (opts.image !== undefined) {
    const id = Number(opts.image);
    const img = await preset.image?.(id);
    if (!img) {
      console.log(`[${elapsed()}] preset ${id}: no thumbnail returned`);
    } else {
      fs.mkdirSync("out", { recursive: true });
      const file = path.join("out", `preset-${id}.jpg`);
      fs.writeFileSync(file, Buffer.from(img.data, "base64"));
      console.log(`[${elapsed()}] preset ${img.index} thumbnail → ${file}`);
    }
  }
  await eufy.disconnect();
}
