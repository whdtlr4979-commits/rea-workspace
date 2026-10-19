/** Unix time in seconds (bar open time). */
export type UTCTimestamp = number;

/** Logical bar position on the shared time axis (spec §1, "bar index 좌표계"). */
export type BarIndex = number;

/** Field positions inside a series plot row (spec §4.2 `SeriesPlotIndex`). */
export enum SeriesPlotIndex {
  Time = 0,
  Open = 1,
  High = 2,
  Low = 3,
  Close = 4,
  Volume = 5,
}

/** Subset of the `ChartStyle` enum from spec §4.2, keeping the original numeric values. */
export enum ChartStyle {
  Bar = 0,
  Candle = 1,
  Line = 2,
  Area = 3,
  HeikinAshi = 8,
  HollowCandle = 9,
}

export enum PriceScaleMode {
  Normal = 0,
  Log = 1,
  Percentage = 2,
  IndexedTo100 = 3,
}

/** Repaint levels (spec §5.2). Cursor repaints only the top canvases. */
export enum InvalidationLevel {
  None = 0,
  Cursor = 1,
  Light = 2,
  Full = 3,
}

export interface PlotRow {
  index: BarIndex;
  /** `value[0]` is the bar time; the rest are plot values. Missing values are NaN. */
  value: number[];
}

/**
 * Resolution strings follow the spec (§6.5): minutes as integers ("1", "5", "60"),
 * "D" for days and "W" for weeks.
 */
export type Resolution = string;

export function resolutionToSeconds(resolution: Resolution): number {
  if (resolution === 'D' || resolution === '1D') return 86_400;
  if (resolution === 'W' || resolution === '1W') return 7 * 86_400;
  const minutes = Number(resolution);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`Unsupported resolution: ${resolution}`);
  }
  return minutes * 60;
}

/** Short display label: "1" → "1m", "60" → "1h", "D" → "1D". */
export function formatResolution(resolution: Resolution): string {
  if (resolution === 'D' || resolution === 'W') return `1${resolution}`;
  const minutes = Number(resolution);
  if (Number.isInteger(minutes) && minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${resolution}m`;
}

export function isIntraday(resolution: Resolution): boolean {
  return resolutionToSeconds(resolution) < 86_400;
}
