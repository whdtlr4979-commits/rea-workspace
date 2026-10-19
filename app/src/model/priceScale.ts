import { PriceScaleMode } from '../core/types';
import type { MinMax } from './plotList';

export interface PriceScaleMargins {
  top: number;
  bottom: number;
}

/** Spec §4.4 / §7.1: 10% top, 8% bottom. */
export const DEFAULT_MARGINS: PriceScaleMargins = { top: 0.1, bottom: 0.08 };

export interface PriceMark {
  coordinate: number;
  label: string;
}

const LOG_EPSILON = 1e-12;

/** Picks a 1/2/2.5/5 × 10^k step so marks land roughly `targetPx` apart. */
export function niceStep(span: number, heightPx: number, targetPx = 40): number {
  if (span <= 0 || heightPx <= 0) return 1;
  const raw = (span * targetPx) / heightPx;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * magnitude >= raw) return m * magnitude;
  }
  return 10 * magnitude;
}

/**
 * Vertical axis. Auto-scaling and coordinates work in an internal space that depends on the
 * mode (spec §4.4): prices for Normal, log10 for Log, change from the base value for
 * Percentage, and base = 100 for IndexedTo100.
 */
export class PriceScale {
  private height = 0;
  private mode = PriceScaleMode.Normal;
  private autoScale = true;
  /** Internal-space range, before margins are applied. */
  private range: MinMax | null = null;
  private base = Number.NaN;
  private scaleStart: { y: number; range: MinMax } | null = null;
  private precision = 2;

  constructor(
    readonly id: string,
    private margins: PriceScaleMargins = DEFAULT_MARGINS,
  ) {}

  setHeight(height: number): void {
    this.height = Math.max(0, height);
  }

  getHeight(): number {
    return this.height;
  }

  getMode(): PriceScaleMode {
    return this.mode;
  }

  setMode(mode: PriceScaleMode): void {
    this.mode = mode;
    this.range = null;
    this.autoScale = true;
  }

  isAutoScale(): boolean {
    return this.autoScale;
  }

  setAutoScale(on: boolean): void {
    this.autoScale = on;
  }

  setPrecision(decimals: number): void {
    this.precision = Math.max(0, Math.round(decimals));
  }

  setMargins(margins: PriceScaleMargins): void {
    this.margins = margins;
  }

  /** First visible value; Percentage and IndexedTo100 are relative to it. */
  setBaseValue(value: number): void {
    this.base = value;
  }

  hasRange(): boolean {
    return this.range !== null && this.height > 0;
  }

  toInternal(price: number): number {
    switch (this.mode) {
      case PriceScaleMode.Log:
        return Math.log10(Math.max(price, LOG_EPSILON));
      case PriceScaleMode.Percentage:
        return ((price - this.base) / Math.abs(this.base)) * 100;
      case PriceScaleMode.IndexedTo100:
        return (price / this.base) * 100;
      default:
        return price;
    }
  }

  fromInternal(value: number): number {
    switch (this.mode) {
      case PriceScaleMode.Log:
        return 10 ** value;
      case PriceScaleMode.Percentage:
        return this.base + (value / 100) * Math.abs(this.base);
      case PriceScaleMode.IndexedTo100:
        return (value / 100) * this.base;
      default:
        return value;
    }
  }

  /** Feed the visible min/max (in prices). Ignored while the user has scaled manually. */
  autoScaleTo(priceRange: MinMax | null): void {
    if (!this.autoScale || priceRange === null) return;
    let min = this.toInternal(priceRange.min);
    let max = this.toInternal(priceRange.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (min === max) {
      const pad = Math.abs(min) * 0.01 || 1;
      min -= pad;
      max += pad;
    }
    this.range = { min, max };
  }

  private innerTop(): number {
    return this.height * this.margins.top;
  }

  private innerHeight(): number {
    return Math.max(1, this.height * (1 - this.margins.top - this.margins.bottom));
  }

  internalToCoordinate(value: number): number {
    const r = this.range;
    if (r === null) return Number.NaN;
    return this.innerTop() + ((r.max - value) / (r.max - r.min)) * this.innerHeight();
  }

  coordinateToInternal(y: number): number {
    const r = this.range;
    if (r === null) return Number.NaN;
    return r.max - ((y - this.innerTop()) / this.innerHeight()) * (r.max - r.min);
  }

  priceToCoordinate(price: number): number {
    return this.internalToCoordinate(this.toInternal(price));
  }

  coordinateToPrice(y: number): number {
    return this.fromInternal(this.coordinateToInternal(y));
  }

  /** Dragging the axis: pulling down widens the range, pushing up narrows it. */
  startScale(y: number): void {
    if (this.range === null) return;
    this.scaleStart = { y, range: { ...this.range } };
    this.autoScale = false;
  }

  scaleTo(y: number): void {
    if (this.scaleStart === null) return;
    const { range } = this.scaleStart;
    const factor = Math.exp((y - this.scaleStart.y) / 150);
    const center = (range.min + range.max) / 2;
    const half = ((range.max - range.min) / 2) * factor;
    this.range = { min: center - half, max: center + half };
  }

  endScale(): void {
    this.scaleStart = null;
  }

  /** Shifts the range vertically by a pixel delta (used when panning with auto-scale off). */
  scrollBy(dy: number): void {
    const r = this.range;
    if (r === null || this.autoScale) return;
    const shift = (dy / this.innerHeight()) * (r.max - r.min);
    this.range = { min: r.min + shift, max: r.max + shift };
  }

  formatPrice(price: number): string {
    return price.toFixed(this.precision);
  }

  /** Axis label for a price, expressed in the scale's own units. */
  formatLabel(price: number): string {
    switch (this.mode) {
      case PriceScaleMode.Percentage:
        return `${this.toInternal(price).toFixed(2)}%`;
      case PriceScaleMode.IndexedTo100:
        return this.toInternal(price).toFixed(2);
      default:
        return this.formatPrice(price);
    }
  }

  marks(): PriceMark[] {
    const r = this.range;
    if (r === null || this.height <= 0) return [];
    const top = this.coordinateToInternal(0);
    const bottom = this.coordinateToInternal(this.height);
    const marks: PriceMark[] = [];
    if (this.mode === PriceScaleMode.Log) {
      const step = niceStep(top - bottom, this.height);
      const seen = new Set<string>();
      for (let v = Math.ceil(bottom / step) * step; v <= top; v += step) {
        const price = roundToSignificant(10 ** v, 2);
        const label = this.formatPrice(price);
        if (seen.has(label)) continue;
        seen.add(label);
        marks.push({ coordinate: this.priceToCoordinate(price), label });
      }
      return marks;
    }
    const step = niceStep(top - bottom, this.height);
    const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    for (let v = Math.ceil(bottom / step) * step; v <= top; v += step) {
      const value = Number(v.toFixed(decimals + 2));
      const label = this.mode === PriceScaleMode.Percentage ? `${value.toFixed(Math.min(decimals, 2))}%` : this.mode === PriceScaleMode.IndexedTo100 ? value.toFixed(Math.min(decimals, 2)) : value.toFixed(Math.min(decimals, this.precision));
      marks.push({ coordinate: this.internalToCoordinate(value), label });
    }
    return marks;
  }
}

function roundToSignificant(value: number, digits: number): number {
  if (value === 0) return 0;
  const magnitude = 10 ** (Math.floor(Math.log10(Math.abs(value))) - digits + 1);
  return Math.round(value / magnitude) * magnitude;
}
