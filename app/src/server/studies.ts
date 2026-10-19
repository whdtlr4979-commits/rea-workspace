import type { StudyInputs } from '../protocol/messages';
import type { Bar } from './feed';

/**
 * Server-side indicator calculators. The client never computes indicator math; it only
 * renders the plot rows these produce (spec §8.1).
 */
export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

export function priceSource(bar: Bar, source: PriceSource): number {
  switch (source) {
    case 'open': return bar.open;
    case 'high': return bar.high;
    case 'low': return bar.low;
    case 'close': return bar.close;
    case 'hl2': return (bar.high + bar.low) / 2;
    case 'hlc3': return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4': return (bar.open + bar.high + bar.low + bar.close) / 4;
  }
}

export function sma(values: number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) {
      sum = 0;
      valid = 0;
      continue;
    }
    sum += v;
    valid++;
    if (valid > length) sum -= values[i - length];
    if (valid >= length) out[i] = sum / length;
  }
  return out;
}

export function ema(values: number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  const alpha = 2 / (length + 1);
  let prev = Number.NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount === length) {
        prev = seedSum / length;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's moving average (RMA), seeded with an SMA. */
export function rma(values: number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  let prev = Number.NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount === length) {
        prev = seedSum / length;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (length - 1) + v) / length;
    out[i] = prev;
  }
  return out;
}

export function rsi(values: number[], length: number): number[] {
  const gains = values.map((v, i) => (i === 0 ? Number.NaN : Math.max(v - values[i - 1], 0)));
  const losses = values.map((v, i) => (i === 0 ? Number.NaN : Math.max(values[i - 1] - v, 0)));
  const avgGain = rma(gains, length);
  const avgLoss = rma(losses, length);
  return avgGain.map((g, i) => {
    const l = avgLoss[i];
    if (Number.isNaN(g) || Number.isNaN(l)) return Number.NaN;
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  });
}

export interface StudyCalculator {
  /** Returns one array per plot, aligned with `bars`. */
  calculate(bars: Bar[], inputs: StudyInputs): number[][];
}

function intInput(inputs: StudyInputs, id: string, fallback: number): number {
  const value = Number(inputs[id]?.v);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sourceInput(inputs: StudyInputs, id: string): PriceSource {
  return (inputs[id]?.v as PriceSource | undefined) ?? 'close';
}

export const STUDY_CALCULATORS: Record<string, StudyCalculator> = {
  Volume: {
    calculate(bars, inputs) {
      const volume = bars.map((b) => b.volume);
      const direction = bars.map((b) => (b.close >= b.open ? 1 : 0));
      return [volume, direction, sma(volume, intInput(inputs, 'in_0', 20))];
    },
  },
  SMA: {
    calculate(bars, inputs) {
      const src = bars.map((b) => priceSource(b, sourceInput(inputs, 'in_1')));
      return [sma(src, intInput(inputs, 'in_0', 20))];
    },
  },
  EMA: {
    calculate(bars, inputs) {
      const src = bars.map((b) => priceSource(b, sourceInput(inputs, 'in_1')));
      return [ema(src, intInput(inputs, 'in_0', 20))];
    },
  },
  RSI: {
    calculate(bars, inputs) {
      const src = bars.map((b) => priceSource(b, sourceInput(inputs, 'in_1')));
      const value = rsi(src, intInput(inputs, 'in_0', 14));
      return [value, sma(value, intInput(inputs, 'in_2', 14))];
    },
  },
};

/** Study names on the wire look like "RSI@mock-studies-1" (spec §8.2 `<Name>@<package>-<version>`). */
export function calculatorForName(studyName: string): StudyCalculator | undefined {
  return STUDY_CALCULATORS[studyName.split('@')[0]];
}
