import type { Device, EufyMega } from "@mega-yfue/eufy-sdk";

export type PtzApi = NonNullable<ReturnType<NonNullable<Device["ptz"]>>>;
export type CameraApi = NonNullable<ReturnType<NonNullable<Device["camera"]>>>;

export async function getDevice(eufy: EufyMega, sn: string): Promise<Device> {
  const dev = await eufy.getDevice(sn);
  if (!dev) throw new Error(`device ${sn} not found on this account (run \`eufy-snap devices\`)`);
  return dev;
}

export function requirePtz(dev: Device): PtzApi {
  const ptz = dev.ptz?.();
  if (!ptz) throw new Error(`${dev.sn} (${dev.modelName}) reports no pan-tilt capability`);
  return ptz;
}

export function requireCamera(dev: Device): CameraApi {
  const cam = dev.camera?.();
  if (!cam) throw new Error(`${dev.sn} (${dev.modelName}) reports no camera capability`);
  return cam;
}

/** `preset().list()` returns every slot on the S340; an occupied one reports `enable: 1`. */
export function isStoredPreset(p: { id: number; raw: unknown }): boolean {
  const raw = p.raw as { enable?: unknown } | undefined;
  return raw?.enable === undefined || raw.enable === 1 || raw.enable === true;
}

/** Elapsed-time helper for spike timings. */
export function stopwatch(): () => string {
  const t0 = performance.now();
  return () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
}

export function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
