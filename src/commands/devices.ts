import { connect } from "../client.ts";

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
    const battery = dev.getProperty("battery");
    if (battery !== undefined) console.log(`    battery: ${JSON.stringify(battery)}`);
  }
  await eufy.disconnect();
}
