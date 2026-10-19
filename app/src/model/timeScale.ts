import type { BarIndex } from '../core/types';

export interface TimeScaleOptions {
  /** Spec §4.3 defaults. */
  defaultBarSpacing: number;
  minBarSpacing: number;
  defaultRightOffset: number;
  rightBarStaysOnScroll: boolean;
  /** Fewest bars that must stay on screen when scrolling or zooming. */
  minVisibleBars: number;
}

export const DEFAULT_TIME_SCALE_OPTIONS: TimeScaleOptions = {
  defaultBarSpacing: 6,
  minBarSpacing: 0.5,
  defaultRightOffset: 10,
  rightBarStaysOnScroll: true,
  minVisibleBars: 2,
};

export interface LogicalRange {
  left: number;
  right: number;
}

/**
 * Horizontal axis shared by every pane. Positions are bar indices; `rightOffset` is how many
 * bar slots sit between the last bar (`baseIndex`) and the right edge.
 */
export class TimeScale {
  private width = 0;
  private barSpacing: number;
  private rightOffset: number;
  private baseIndex: BarIndex = 0;
  private firstIndex: BarIndex | null = null;
  private scrollStart: { x: number; rightOffset: number } | null = null;
  private scaleStart: { x: number; barSpacing: number } | null = null;

  constructor(readonly options: TimeScaleOptions = DEFAULT_TIME_SCALE_OPTIONS) {
    this.barSpacing = options.defaultBarSpacing;
    this.rightOffset = options.defaultRightOffset;
  }

  getWidth(): number {
    return this.width;
  }

  setWidth(width: number): void {
    if (width === this.width) return;
    this.width = Math.max(0, width);
    this.barSpacing = this.clampSpacing(this.barSpacing);
    this.rightOffset = this.clampRightOffset(this.rightOffset);
  }

  getBarSpacing(): number {
    return this.barSpacing;
  }

  getRightOffset(): number {
    return this.rightOffset;
  }

  getBaseIndex(): BarIndex {
    return this.baseIndex;
  }

  minBarSpacing(): number {
    return this.options.minBarSpacing;
  }

  /** Spec §4.3: width / 2, so at least two bars always fit. */
  maxBarSpacing(): number {
    return Math.max(this.options.minBarSpacing, this.width / this.options.minVisibleBars);
  }

  /** Called when the main series data range changes. Keeps the right edge anchored to the last bar. */
  setDataRange(firstIndex: BarIndex | null, lastIndex: BarIndex | null): void {
    this.firstIndex = firstIndex;
    if (lastIndex !== null) this.baseIndex = lastIndex;
    this.rightOffset = this.clampRightOffset(this.rightOffset);
  }

  private clampSpacing(spacing: number): number {
    return Math.min(Math.max(spacing, this.minBarSpacing()), this.maxBarSpacing());
  }

  private clampRightOffset(offset: number): number {
    if (this.width === 0) return offset;
    const visibleBars = this.width / this.barSpacing;
    const keep = this.options.minVisibleBars;
    // Larger offsets push the last bar left; stop while `keep` bars still fit on the right.
    const max = visibleBars - keep;
    // Smaller (negative) offsets scroll into history; stop before the first bar leaves the right side.
    const min = this.firstIndex === null ? -Number.MAX_VALUE : this.firstIndex - this.baseIndex + keep - 0.5;
    return Math.min(Math.max(offset, min), Math.max(min, max));
  }

  indexToCoordinate(index: BarIndex): number {
    return this.width - (this.baseIndex + this.rightOffset - index + 0.5) * this.barSpacing;
  }

  coordinateToFloatIndex(x: number): number {
    return this.baseIndex + this.rightOffset + 0.5 - (this.width - x) / this.barSpacing;
  }

  coordinateToIndex(x: number): BarIndex {
    return Math.round(this.coordinateToFloatIndex(x));
  }

  logicalRange(): LogicalRange {
    return { left: this.coordinateToFloatIndex(0), right: this.coordinateToFloatIndex(this.width) };
  }

  /** Integer index range of bars at least partly on screen. */
  visibleBars(): { from: BarIndex; to: BarIndex } {
    const range = this.logicalRange();
    return { from: Math.floor(range.left), to: Math.ceil(range.right) };
  }

  setBarSpacing(spacing: number): void {
    this.barSpacing = this.clampSpacing(spacing);
    this.rightOffset = this.clampRightOffset(this.rightOffset);
  }

  setRightOffset(offset: number): void {
    this.rightOffset = this.clampRightOffset(offset);
  }

  /**
   * Spec §4.3: `newSpacing = spacing + delta * spacing / 10`. When the right bar stays put
   * the right offset is preserved; otherwise the bar under `x` stays under the cursor.
   */
  zoom(x: number, delta: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(delta)) return;
    const anchor = this.coordinateToFloatIndex(x);
    this.barSpacing = this.clampSpacing(this.barSpacing + (delta * this.barSpacing) / 10);
    if (!this.options.rightBarStaysOnScroll) {
      this.rightOffset = anchor - this.baseIndex - 0.5 + (this.width - x) / this.barSpacing;
    }
    this.rightOffset = this.clampRightOffset(this.rightOffset);
  }

  startScroll(x: number): void {
    this.scrollStart = { x, rightOffset: this.rightOffset };
  }

  scrollTo(x: number): void {
    if (this.scrollStart === null) return;
    const shift = (x - this.scrollStart.x) / this.barSpacing;
    this.rightOffset = this.clampRightOffset(this.scrollStart.rightOffset - shift);
  }

  endScroll(): void {
    this.scrollStart = null;
  }

  /** Dragging the time axis: moving left squeezes bars, moving right widens them. */
  startScale(x: number): void {
    this.scaleStart = { x, barSpacing: this.barSpacing };
  }

  scaleTo(x: number): void {
    if (this.scaleStart === null || this.width === 0) return;
    const factor = Math.exp((x - this.scaleStart.x) / 200);
    this.setBarSpacing(this.scaleStart.barSpacing * factor);
  }

  endScale(): void {
    this.scaleStart = null;
  }

  reset(): void {
    this.barSpacing = this.clampSpacing(this.options.defaultBarSpacing);
    this.rightOffset = this.clampRightOffset(this.options.defaultRightOffset);
  }

  /**
   * Number of extra history bars needed so the left edge is covered (spec §4.3:
   * first loaded index minus first visible index). Zero when nothing is missing.
   */
  missingHistoryBars(): number {
    if (this.firstIndex === null) return 0;
    return Math.max(0, Math.ceil(this.firstIndex - this.logicalRange().left));
  }
}

/** Spec §4.3 `easeInOutQuint`, used by the 1000 ms scroll-to-realtime animation. */
export function easeInOutQuint(t: number): number {
  return t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2;
}
