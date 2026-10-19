import type { BarIndex, PlotRow } from '../core/types';

export interface MinMax {
  min: number;
  max: number;
}

/**
 * Index-sorted time series storage (spec §4.2 PlotList). `merge` recognises the four update
 * shapes the server produces: prepend (history), append (new bar), update-last (tick) and
 * a general merge.
 */
export class PlotList {
  private rows: PlotRow[] = [];

  size(): number {
    return this.rows.length;
  }

  isEmpty(): boolean {
    return this.rows.length === 0;
  }

  first(): PlotRow | null {
    return this.rows[0] ?? null;
  }

  last(): PlotRow | null {
    return this.rows[this.rows.length - 1] ?? null;
  }

  firstIndex(): BarIndex | null {
    return this.first()?.index ?? null;
  }

  lastIndex(): BarIndex | null {
    return this.last()?.index ?? null;
  }

  clear(): void {
    this.rows = [];
  }

  /** Returns the earliest changed row, or null when nothing changed. */
  merge(items: PlotRow[]): PlotRow | null {
    if (items.length === 0) return null;
    const sorted = [...items].sort((a, b) => a.index - b.index);
    const last = this.last();
    const first = this.first();
    if (last === null || first === null) {
      this.rows = sorted;
    } else if (sorted[sorted.length - 1].index < first.index) {
      this.rows = sorted.concat(this.rows);
    } else if (sorted[0].index > last.index) {
      this.rows.push(...sorted);
    } else if (sorted.length === 1 && sorted[0].index === last.index) {
      this.rows[this.rows.length - 1] = sorted[0];
    } else {
      this.mergeGeneral(sorted);
    }
    return sorted[0];
  }

  private mergeGeneral(items: PlotRow[]): void {
    const merged: PlotRow[] = [];
    let a = 0;
    let b = 0;
    while (a < this.rows.length || b < items.length) {
      const left = this.rows[a];
      const right = items[b];
      if (right === undefined || (left !== undefined && left.index < right.index)) {
        merged.push(left);
        a++;
      } else if (left === undefined || right.index < left.index) {
        merged.push(right);
        b++;
      } else {
        merged.push(right);
        a++;
        b++;
      }
    }
    this.rows = merged;
  }

  /** Position of the first row with `index >= target`. */
  private lowerBound(target: BarIndex): number {
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid].index < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  valueAt(index: BarIndex): PlotRow | null {
    const pos = this.lowerBound(index);
    const row = this.rows[pos];
    return row !== undefined && row.index === index ? row : null;
  }

  /** Nearest row at or before `index`, falling back to the first row. */
  search(index: BarIndex): PlotRow | null {
    if (this.rows.length === 0) return null;
    const pos = this.lowerBound(index);
    const row = this.rows[pos];
    if (row !== undefined && row.index === index) return row;
    return this.rows[Math.max(0, pos - 1)];
  }

  /** Row whose time (column 0) equals `time`. Rows are time-ordered as well as index-ordered. */
  findByTime(time: number): PlotRow | null {
    let lo = 0;
    let hi = this.rows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.rows[mid].value[0];
      if (t === time) return this.rows[mid];
      if (t < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** Rows with `from <= index <= to`. */
  range(from: BarIndex, to: BarIndex): PlotRow[] {
    return this.rows.slice(this.lowerBound(from), this.lowerBound(Math.floor(to) + 1));
  }

  all(): readonly PlotRow[] {
    return this.rows;
  }

  /** Min/max over the given value columns, ignoring NaN. */
  minMax(from: BarIndex, to: BarIndex, columns: number[]): MinMax | null {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const row of this.range(from, to)) {
      for (const c of columns) {
        const v = row.value[c];
        if (Number.isNaN(v) || v === undefined) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return min <= max ? { min, max } : null;
  }
}
