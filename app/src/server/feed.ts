import { resolutionToSeconds, type Resolution, type UTCTimestamp } from '../core/types';

export interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MockSymbolSpec {
  ticker: string;
  description: string;
  type: string;
  /** Price is a multiple of 1 / pricescale. */
  pricescale: number;
  basePrice: number;
  /** Daily log-return volatility. */
  dailyVolatility: number;
  baseVolume: number;
}

export const MOCK_SYMBOLS: MockSymbolSpec[] = [
  { ticker: 'MOCK:BTCUSD', description: 'Mock Bitcoin / US Dollar', type: 'crypto', pricescale: 100, basePrice: 64_000, dailyVolatility: 0.035, baseVolume: 25_000 },
  { ticker: 'MOCK:AAPL', description: 'Mock Apple Inc.', type: 'stock', pricescale: 100, basePrice: 190, dailyVolatility: 0.018, baseVolume: 55_000_000 },
  { ticker: 'MOCK:EURUSD', description: 'Mock Euro / US Dollar', type: 'forex', pricescale: 100_000, basePrice: 1.08, dailyVolatility: 0.005, baseVolume: 120_000 },
  { ticker: 'MOCK:SPX', description: 'Mock S&P 500 Index', type: 'index', pricescale: 100, basePrice: 5_200, dailyVolatility: 0.011, baseVolume: 2_500_000_000 },
];

export function findSymbol(ticker: string): MockSymbolSpec | undefined {
  return MOCK_SYMBOLS.find((s) => s.ticker === ticker);
}

/** Deterministic PRNG so the same symbol and resolution always yield the same history. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const MONDAY_EPOCH_OFFSET = 4 * 86_400;

/** Start of the bar that contains `time`. Weekly bars start on Monday 00:00 UTC. */
export function barStart(time: UTCTimestamp, resolution: Resolution): UTCTimestamp {
  const step = resolutionToSeconds(resolution);
  if (step === 7 * 86_400) {
    return Math.floor((time - MONDAY_EPOCH_OFFSET) / step) * step + MONDAY_EPOCH_OFFSET;
  }
  return Math.floor(time / step) * step;
}

function roundToTick(price: number, pricescale: number): number {
  return Math.round(price * pricescale) / pricescale;
}

/**
 * Random-walk OHLCV feed. History is generated backwards from the current bar so the
 * latest close stays near the symbol's base price, then realtime ticks extend it forwards.
 */
export class MockFeed {
  readonly bars: Bar[] = [];
  private readonly random: () => number;
  private readonly barVolatility: number;
  private readonly step: number;

  constructor(
    readonly spec: MockSymbolSpec,
    readonly resolution: Resolution,
    now: UTCTimestamp,
    historyLength: number,
  ) {
    this.random = mulberry32(hashString(`${spec.ticker}|${resolution}`));
    this.step = resolutionToSeconds(resolution);
    this.barVolatility = spec.dailyVolatility * Math.sqrt(this.step / 86_400);
    this.generateHistory(barStart(now, resolution), historyLength);
  }

  private generateHistory(lastBarTime: UTCTimestamp, length: number): void {
    const reversed: Bar[] = [];
    let close = this.spec.basePrice;
    for (let k = 0; k < length; k++) {
      const time = lastBarTime - k * this.step;
      const open = close * Math.exp(-this.barVolatility * gaussian(this.random));
      reversed.push(this.makeBar(time, open, close));
      close = open;
    }
    this.bars.push(...reversed.reverse());
  }

  private makeBar(time: UTCTimestamp, open: number, close: number): Bar {
    const { pricescale } = this.spec;
    const wick = this.barVolatility * 0.6;
    const high = Math.max(open, close) * Math.exp(Math.abs(gaussian(this.random)) * wick);
    const low = Math.min(open, close) * Math.exp(-Math.abs(gaussian(this.random)) * wick);
    const volumeScale = this.spec.baseVolume * (this.step / 86_400);
    const volume = Math.round(volumeScale * Math.exp(0.5 * gaussian(this.random)));
    return {
      time,
      open: roundToTick(open, pricescale),
      high: roundToTick(high, pricescale),
      low: roundToTick(low, pricescale),
      close: roundToTick(close, pricescale),
      volume,
    };
  }

  /**
   * Applies one realtime trade at `now`. Returns the array position of the first bar that
   * changed: the last bar when it was updated in place, or a new bar when one was opened.
   */
  tick(now: UTCTimestamp): number {
    const last = this.bars[this.bars.length - 1];
    const tickVolatility = this.barVolatility * 0.08;
    const price = roundToTick(last.close * Math.exp(tickVolatility * gaussian(this.random)), this.spec.pricescale);
    const tradeVolume = Math.max(1, Math.round((last.volume || this.spec.baseVolume) * 0.002));
    const currentStart = barStart(now, this.resolution);
    if (currentStart > last.time) {
      this.bars.push({ time: currentStart, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: tradeVolume });
      return this.bars.length - 1;
    }
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.volume += tradeVolume;
    return this.bars.length - 1;
  }
}

/** Heikin Ashi transform, computed server-side as a synthetic series (spec §4.2). */
export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: b.time, open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close, volume: b.volume });
  }
  return out;
}
