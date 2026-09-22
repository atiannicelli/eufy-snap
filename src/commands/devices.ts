import { resolveStreamingQuality } from "@mega-yfue/eufy-sdk";
import { connect } from "../client.ts";

/** Live-view quality as the app shows it, with the one hint that matters for a remote server. */
function describeStreamingQuality(v: unknown): string | undefined {
  const tier = typeof v === "object" && v !== null && "value" in v ? (v as { value: unknown }).value : v;
  if (typeof tier !== "number") return undefined;
  const name = resolveStreamingQuality(tier) ?? String(tier);
  return tier === 0
    ? `${name} — the camera drops to 1080p when reached through Eufy's relay (off-LAN); set Streaming Quality to Max in the Eufy app for full resolution`
    : name;
}

/** List devices with the capability facts the design depends on (PTZ, battery, camera, presets). */
export async function devicesCommand(opts: { json?: boolean }): Promise<void> {
  const eufy = await connect(false);
  const summaries = await eufy.getDevices();
  for (const s of summaries) {
    const dev = await eufy.getDevice(s.sn);
    if (!dev) continue;
    if (opts.json) {
      console.log(JSON.stringify(dev.toJSON(), null, 2));
      continue;
    }
    const ptz = dev.ptz?.();
    const flags = [
      dev.has("ptz") ? "PTZ" : null,
      dev.has("battery") ? "BATTERY" : null,
      dev.has("camera") ? "CAMERA" : null,
      dev.has("rtsp") ? "RTSP" : null,
      ptz?.zoom ? "ZOOM" : null,
      ptz?.preset ? "PRESETS" : null,
    ].filter(Boolean);
    console.log(`${dev.sn}  ${dev.name}  model=${dev.modelName}  station=${dev.stationSn}`);
    console.log(`    flags: ${flags.join(" ") || "-"}`);
    console.log(`    caps:  ${dev.capabilities.join(", ")}`);
    if (ptz) console.log(`    rotationSpeed: ${ptz.rotationSpeed ?? "(not set)"}`);
    const quality = describeStreamingQuality(dev.getProperty("streamingQuality"));
    if (quality) console.log(`    streamingQuality: ${quality}`);
    const detection = dev.motion?.()?.detectionEnabled;
    console.log(
      `    motionDetection: ${detection === undefined ? "(not reported — the run cannot pause it)" : detection ? "on (paused during each run)" : "off"}`,
    );
    const battery = dev.getProperty("battery");
    if (battery !== undefined) console.log(`    battery: ${JSON.stringify(battery)}`);
  }
  await eufy.disconnect();
}
