import type { PixelPoint } from './types';

export function distance(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from `p` to the segment `a`–`b`. */
export function distanceToSegment(p: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * Extends the segment `a`–`b` to the edges of a `width` × `height` box on the requested sides.
 * Returns the visible endpoints in a → b order.
 */
export function extendSegment(a: PixelPoint, b: PixelPoint, extendLeft: boolean, extendRight: boolean, width: number, height: number): [PixelPoint, PixelPoint] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return [a, b];
  // Parametric line a + t (b - a): find the t range that stays inside the box.
  const bounds: number[] = [];
  if (dx !== 0) bounds.push(-a.x / dx, (width - a.x) / dx);
  if (dy !== 0) bounds.push(-a.y / dy, (height - a.y) / dy);
  const inside = (t: number) => {
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    return x >= -1e-6 && x <= width + 1e-6 && y >= -1e-6 && y <= height + 1e-6;
  };
  const candidates = bounds.filter(inside);
  const tMin = candidates.length ? Math.min(...candidates) : 0;
  const tMax = candidates.length ? Math.max(...candidates) : 1;
  const start = extendLeft ? Math.min(0, tMin) : 0;
  const end = extendRight ? Math.max(1, tMax) : 1;
  return [
    { x: a.x + start * dx, y: a.y + start * dy },
    { x: a.x + end * dx, y: a.y + end * dy },
  ];
}

export function pointInRect(p: PixelPoint, a: PixelPoint, b: PixelPoint): boolean {
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

/** y of the infinite line through `a`, `b` at `x` (a vertical line returns `a.y`). */
export function lineYAt(a: PixelPoint, b: PixelPoint, x: number): number {
  if (b.x === a.x) return a.y;
  return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
}
