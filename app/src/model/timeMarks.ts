import type { BarIndex, UTCTimestamp } from '../core/types';

/**
 * Time-axis label weights. A bar that starts a larger calendar unit gets a higher weight, and
 * higher weights win when labels would overlap (the spec's `marks: [span, time, index]`).
 */
export enum MarkWeight {
  Minute = 20,
  Hour = 30,
  Day = 50,
  Month = 60,
  Year = 70,
}

export interface TimeMark {
  index: BarIndex;
  time: UTCTimestamp;
  weight: MarkWeight;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function markWeight(previous: UTCTimestamp | null, current: UTCTimestamp): MarkWeight {
  const cur = new Date(current * 1000);
  if (previous === null) return MarkWeight.Year;
  const prev = new Date(previous * 1000);
  if (cur.getUTCFullYear() !== prev.getUTCFullYear()) return MarkWeight.Year;
  if (cur.getUTCMonth() !== prev.getUTCMonth()) return MarkWeight.Month;
  if (cur.getUTCDate() !== prev.getUTCDate()) return MarkWeight.Day;
  if (cur.getUTCHours() !== prev.getUTCHours()) return MarkWeight.Hour;
  return MarkWeight.Minute;
}

export function formatMark(time: UTCTimestamp, weight: MarkWeight): string {
  const d = new Date(time * 1000);
  switch (weight) {
    case MarkWeight.Year:
      return String(d.getUTCFullYear());
    case MarkWeight.Month:
      return MONTHS[d.getUTCMonth()];
    case MarkWeight.Day:
      return String(d.getUTCDate());
    default:
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/**
 * Picks labels for the visible bars: heaviest first, skipping any that would land closer than
 * `minSpacingPx` to an accepted label.
 */
export function selectTimeMarks(
  bars: { index: BarIndex; time: UTCTimestamp; previousTime: UTCTimestamp | null }[],
  indexToX: (index: BarIndex) => number,
  minSpacingPx: number,
): TimeMark[] {
  const candidates = bars.map((b) => {
    const weight = markWeight(b.previousTime, b.time);
    return { index: b.index, time: b.time, weight, x: indexToX(b.index) };
  });
  const order = [...candidates].sort((a, b) => b.weight - a.weight || a.index - b.index);
  const accepted: typeof candidates = [];
  for (const c of order) {
    if (accepted.every((a) => Math.abs(a.x - c.x) >= minSpacingPx)) accepted.push(c);
  }
  return accepted
    .sort((a, b) => a.index - b.index)
    .map((c) => ({ index: c.index, time: c.time, weight: c.weight, label: formatMark(c.time, c.weight) }));
}

export function formatCrosshairTime(time: UTCTimestamp, intraday: boolean): string {
  const d = new Date(time * 1000);
  const date = `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  if (!intraday) return date;
  return `${date}  ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
