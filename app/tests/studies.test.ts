import { describe, expect, it } from 'vitest';
import { barStart, heikinAshi, MockFeed, MOCK_SYMBOLS, type Bar } from '../src/server/feed';
import { ema, rma, rsi, sma } from '../src/server/studies';

describe('moving averages', () => {
  it('sma averages the trailing window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it('ema seeds with an SMA and uses alpha = 2 / (n + 1)', () => {
    const out = ema([1, 2, 3, 4], 3);
    expect(out[2]).toBe(2);
    expect(out[3]).toBeCloseTo(0.5 * 4 + 0.5 * 2, 12);
  });

  it('rma (Wilder) seeds with an SMA and uses alpha = 1 / n', () => {
    const out = rma([2, 4, 6, 8], 3);
    expect(out[2]).toBe(4);
    expect(out[3]).toBeCloseTo((4 * 2 + 8) / 3, 12);
  });
});

describe('rsi', () => {
  it('is 100 for a strictly rising series and 0 for a falling one', () => {
    const rising = Array.from({ length: 30 }, (_, i) => i);
    expect(rsi(rising, 14).at(-1)).toBe(100);
    expect(rsi(rising.map((x) => -x), 14).at(-1)).toBe(0);
  });

  it('matches a hand computation on a short series', () => {
    const closes = [10, 11, 10, 12, 12, 11];
    // Gains 1,0,2,0,0 and losses 0,1,0,0,1 with length 2.
    const out = rsi(closes, 2);
    const avgGain = (((1 + 0) / 2) * 1 + 2) / 2; // after the third change
    const avgLoss = (((0 + 1) / 2) * 1 + 0) / 2;
    expect(out[3]).toBeCloseTo(100 - 100 / (1 + avgGain / avgLoss), 12);
    expect(out.slice(1).every((v) => Number.isNaN(v) || (v >= 0 && v <= 100))).toBe(true);
  });
});

describe('feed', () => {
  const spec = MOCK_SYMBOLS[0];

  it('aligns bars to the resolution grid', () => {
    const feed = new MockFeed(spec, '60', 1_700_000_123, 50);
    expect(feed.bars).toHaveLength(50);
    for (let i = 1; i < feed.bars.length; i++) expect(feed.bars[i].time - feed.bars[i - 1].time).toBe(3600);
    expect(feed.bars.at(-1)!.time).toBe(barStart(1_700_000_123, '60'));
  });

  it('keeps OHLC consistent', () => {
    const feed = new MockFeed(spec, 'D', 1_700_000_000, 500);
    for (const b of feed.bars) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    }
  });

  it('is deterministic per symbol and resolution', () => {
    const a = new MockFeed(spec, 'D', 1_700_000_000, 20).bars;
    const b = new MockFeed(spec, 'D', 1_700_000_000, 20).bars;
    expect(a).toEqual(b);
  });

  it('updates the last bar in place, then opens a new one', () => {
    const feed = new MockFeed(spec, '1', 1_700_000_000, 10);
    const last = feed.bars.at(-1)!;
    expect(feed.tick(last.time + 30)).toBe(9);
    expect(feed.bars).toHaveLength(10);
    expect(feed.tick(last.time + 61)).toBe(10);
    expect(feed.bars.at(-1)!.time).toBe(last.time + 60);
  });

  it('starts weekly bars on Monday', () => {
    const monday = barStart(Date.UTC(2026, 9, 21) / 1000, 'W');
    expect(new Date(monday * 1000).getUTCDay()).toBe(1);
  });
});

describe('heikin ashi', () => {
  it('follows HA close = ohlc4 and open = midpoint of previous HA body', () => {
    const bars: Bar[] = [
      { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { time: 60, open: 11, high: 13, low: 10, close: 12, volume: 1 },
    ];
    const ha = heikinAshi(bars);
    expect(ha[0].close).toBe(10.5);
    expect(ha[1].open).toBeCloseTo((ha[0].open + ha[0].close) / 2, 12);
    expect(ha[1].high).toBeGreaterThanOrEqual(Math.max(ha[1].open, ha[1].close));
  });
});
