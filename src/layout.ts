export type Rect = { left: number; right: number; top: number; bottom: number };
// Viewport positions: keep 10–71.5% readable; incoming letters finish lower down.
export const MORPH_TOP_START = 0;
export const MORPH_TOP_END = .1;
export const MORPH_BOTTOM_START = .715;
export const MORPH_BOTTOM_END = .8625;
export const DRIFT_X = 32;
export const DRIFT_Y = 22;

export function blobDrift(time: number, seed: number, mobile: boolean, reduced = false) {
  if (reduced) return { x: 0, y: 0 };
  return { x: Math.sin(time * .24 + seed) * (mobile ? 18 : DRIFT_X), y: Math.cos(time * .2 + seed) * (mobile ? 16 : DRIFT_Y) };
}

export function overlaps(a: Rect, b: Rect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function blobBounds(x: number, y: number, size: number, drifting = false): Rect {
  const radius = size / 2 + 16;
  return {
    left: x - radius - (drifting ? DRIFT_X : 0), right: x + radius + (drifting ? DRIFT_X : 0),
    top: y - radius - (drifting ? DRIFT_Y : 0), bottom: y + radius + (drifting ? DRIFT_Y : 0),
  };
}

export function glide(current: number, target: number, seconds: number) {
  const next = current + (target - current) * (1 - Math.exp(-Math.max(0, seconds) * 5));
  return Math.abs(target - next) < .15 ? target : next;
}

export function placeBlob(x: number, y: number, size: number, width: number, pageHeight: number, blockers: Rect[], previous?: { x: number; y: number }) {
  if (previous) {
    const bounds = blobBounds(previous.x, previous.y, size, true);
    // Keep small reflows steady, but follow the content when a section grows.
    if (Math.abs(previous.y - y) < size && bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= pageHeight && !blockers.some(blocker => overlaps(bounds, blocker))) {
      return { ...previous, bounds };
    }
  }
  const margin = size / 2 + 16 + DRIFT_X;
  const clampX = (value: number) => Math.max(margin, Math.min(width - margin, value));
  const offsets = new Set([0, 100, -100, 190, -190, 280, -280, 380, -380]);
  // On narrow screens, look in the gaps between content blocks, even on long pages.
  for (const blocker of blockers) {
    offsets.add(blocker.bottom + size / 2 + 17 + DRIFT_Y - y);
    offsets.add(blocker.top - size / 2 - 17 - DRIFT_Y - y);
  }
  for (const offset of [...offsets].sort((a, b) => Math.abs(a) - Math.abs(b))) {
    for (const candidate of [x, width * .9, width * .1, width * .72, width * .5]) {
      const cx = clampX(candidate), cy = y + offset;
      const bounds = blobBounds(cx, cy, size, true);
      if (bounds.left < 0 || bounds.right > width || bounds.top < 0 || bounds.bottom > pageHeight) continue;
      if (!blockers.some(blocker => overlaps(bounds, blocker))) return { x: cx, y: cy, bounds };
    }
  }
  return undefined;
}
