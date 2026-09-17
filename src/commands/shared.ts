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

/**
 * Move the camera to stored preset `id`. **Never use the SDK's `goto` verb** — in SDK 0.1.2 it sends P2P
 * command 6032, which is the *save current position into slot* command (eufy-security-client:
 * `CMD_FLOODLIGHT_SAVE_MOTION_PRESET_POSITION`); with the SDK's payload the S340 ignores it entirely, so
 * the camera never moves. `preview()` sends 6035 (`CMD_FLOODLIGHT_SET_MOTION_PRESET_POSITION`), the real
 * go-to; the move is persistent, not transient as the SDK doc claims, and positioning is absolute (a
 * repeated move to the same slot is a no-op). Fire-and-forget: a missing slot is a silent no-op.
 */
export function movePreset(ptz: PtzApi, id: number): Promise<void> {
  return ptz.preset().preview(id);
}

/** `preset().list()` returns every slot on the S340; an occupied one reports `enable: 1`. */
export function isStoredPreset(p: { id: number; raw: unknown }): boolean {
  const raw = p.raw as { enable?: unknown } | undefined;
  return raw?.enable === undefined || raw.enable === 1 || raw.enable === true;
}

/**
 * The camera's default preset (`isdefault: 1`). The S340 moves back to it **by itself** about a minute
 * after every live session ends, whatever position it was left in — so this is where the camera really
 * rests between runs, and the only sensible `home_preset`.
 */
export function isDefaultPreset(p: { id: number; raw: unknown }): boolean {
  const raw = p.raw as { isdefault?: unknown } | undefined;
  return raw?.isdefault === 1 || raw?.isdefault === true;
}

/** Camera slots are 0-based; the Eufy app numbers the same presets 1–4. */
export function describePreset(id: number): string {
  return `preset ${id} ("preset ${id + 1}" in the Eufy app)`;
}

/** Elapsed-time helper for spike timings. */
export function stopwatch(): () => string {
  const t0 = performance.now();
  return () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
}

export function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
