import jpeg from "jpeg-js";

/** Comparison happens at this size regardless of source resolution (snapshotLive varies 720p/1616p). */
const W = 320;
const H = 180;
/** Rows compared: skip the sky (featureless) and the bottom (deck rail, near-field parallax). */
const ROW_FROM = Math.floor(H * 0.1);
const ROW_TO = Math.floor(H * 0.7);

export interface ShiftResult {
  /** Horizontal shift of `b` relative to `a`, as a fraction of frame width (positive = content moved right). */
  fraction: number;
  /** Mean absolute grey difference at the best alignment. <15 ≈ same view, >40 ≈ unrelated scenes. */
  mad: number;
}

/** Same-view threshold for {@link ShiftResult.mad}. */
export const SAME_VIEW_MAD = 15;

function grey(buf: Buffer): Float32Array {
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor((y * img.height) / H);
    for (let x = 0; x < W; x++) {
      const sx = Math.floor((x * img.width) / W);
      const i = (sy * img.width + sx) * 4;
      const d = img.data;
      out[y * W + x] = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
    }
  }
  return out;
}

/**
 * Estimate the horizontal pan between two JPEG frames by brute-force search for the shift that
 * minimises mean absolute difference. Good enough to tell "moved", "did not move" and "moved about
 * this much" on a pan-only camera; not a general image registration.
 */
export function frameShift(a: Buffer, b: Buffer): ShiftResult {
  const A = grey(a);
  const B = grey(b);
  let best = { dx: 0, mad: Infinity };
  for (let dx = -W / 2; dx <= W / 2; dx++) {
    let sum = 0;
    let n = 0;
    for (let y = ROW_FROM; y < ROW_TO; y++) {
      for (let x = 0; x < W; x++) {
        const xb = x + dx;
        if (xb < 0 || xb >= W) continue;
        sum += Math.abs((A[y * W + x] ?? 0) - (B[y * W + xb] ?? 0));
        n++;
      }
    }
    const mad = sum / n;
    if (mad < best.mad) best = { dx, mad };
  }
  return { fraction: best.dx / W, mad: best.mad };
}

export function describeShift(r: ShiftResult): string {
  const pct = (r.fraction * 100).toFixed(1);
  return `shift ${r.fraction > 0 ? "+" : ""}${pct}% of width (MAD ${r.mad.toFixed(1)})`;
}
