import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_SCALE_OPTIONS, easeInOutQuint, TimeScale } from '../src/model/timeScale';

function scale(width = 600, first = 0, last = 299): TimeScale {
  const ts = new TimeScale();
  ts.setWidth(width);
  ts.setDataRange(first, last);
  return ts;
}

describe('TimeScale defaults (spec §4.3)', () => {
  it('starts with 6px bars and a 10-bar right offset', () => {
    const ts = scale();
    expect(ts.getBarSpacing()).toBe(6);
    expect(ts.getRightOffset()).toBe(10);
  });

  it('clamps bar spacing to [0.5, width / 2]', () => {
    const ts = scale(600);
    ts.setBarSpacing(0.01);
    expect(ts.getBarSpacing()).toBe(0.5);
    ts.setBarSpacing(10_000);
    expect(ts.getBarSpacing()).toBe(300);
  });
});

describe('coordinates', () => {
  it('places the last bar `rightOffset + 0.5` slots from the right edge', () => {
    const ts = scale(600);
    expect(ts.indexToCoordinate(299)).toBe(600 - 10.5 * 6);
  });

  it('inverts index <-> coordinate', () => {
    const ts = scale(600);
    for (const i of [250, 280, 299]) {
      expect(ts.coordinateToIndex(ts.indexToCoordinate(i))).toBe(i);
      expect(ts.coordinateToFloatIndex(ts.indexToCoordinate(i))).toBeCloseTo(i, 10);
    }
  });
});

describe('zoom', () => {
  it('applies spacing + delta * spacing / 10 and keeps the right offset', () => {
    const ts = scale(600);
    ts.zoom(300, 1);
    expect(ts.getBarSpacing()).toBeCloseTo(6.6, 10);
    expect(ts.getRightOffset()).toBe(10);
    ts.zoom(300, -1);
    expect(ts.getBarSpacing()).toBeCloseTo(5.94, 10);
  });

  it('keeps the bar under the cursor when rightBarStaysOnScroll is off', () => {
    const ts = new TimeScale({ ...DEFAULT_TIME_SCALE_OPTIONS, rightBarStaysOnScroll: false });
    ts.setWidth(600);
    ts.setDataRange(0, 299);
    const before = ts.coordinateToFloatIndex(200);
    ts.zoom(200, 1);
    expect(ts.coordinateToFloatIndex(200)).toBeCloseTo(before, 6);
  });
});

describe('scrolling and history', () => {
  it('drags right into history', () => {
    const ts = scale(600);
    ts.startScroll(100);
    ts.scrollTo(160);
    ts.endScroll();
    expect(ts.getRightOffset()).toBe(10 - 60 / 6);
  });

  it('reports how many bars are missing on the left', () => {
    const ts = scale(600, 200, 299);
    // 100 visible slots, last bar 10.5 slots from the right: left edge sits at index 210.
    expect(ts.missingHistoryBars()).toBe(0);
    ts.setBarSpacing(3);
    expect(ts.missingHistoryBars()).toBe(Math.ceil(200 - ts.logicalRange().left));
    expect(ts.missingHistoryBars()).toBeGreaterThan(0);
  });

  it('does not scroll the first bar past the right edge', () => {
    const ts = scale(600, 0, 299);
    ts.startScroll(0);
    ts.scrollTo(100_000);
    expect(ts.coordinateToFloatIndex(600)).toBeGreaterThanOrEqual(1);
  });
});

describe('easeInOutQuint', () => {
  it('starts at 0, ends at 1 and is symmetric', () => {
    expect(easeInOutQuint(0)).toBe(0);
    expect(easeInOutQuint(1)).toBe(1);
    expect(easeInOutQuint(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutQuint(0.25) + easeInOutQuint(0.75)).toBeCloseTo(1, 10);
  });
});
