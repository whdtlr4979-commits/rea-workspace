import { describe, expect, it } from 'vitest';
import { PriceScaleMode } from '../src/core/types';
import { niceStep, PriceScale } from '../src/model/priceScale';

function scale(mode = PriceScaleMode.Normal): PriceScale {
  const ps = new PriceScale('test');
  ps.setHeight(500);
  ps.setMode(mode);
  return ps;
}

describe('PriceScale margins (spec §4.4)', () => {
  it('maps the range into the area between 10% top and 8% bottom margins', () => {
    const ps = scale();
    ps.autoScaleTo({ min: 100, max: 200 });
    expect(ps.priceToCoordinate(200)).toBeCloseTo(50, 10);
    expect(ps.priceToCoordinate(100)).toBeCloseTo(460, 10);
    expect(ps.coordinateToPrice(ps.priceToCoordinate(137.5))).toBeCloseTo(137.5, 10);
  });

  it('pads a flat range so it still has height', () => {
    const ps = scale();
    ps.autoScaleTo({ min: 50, max: 50 });
    expect(ps.priceToCoordinate(50)).toBeGreaterThan(0);
    expect(ps.priceToCoordinate(50)).toBeLessThan(500);
  });
});

describe('modes', () => {
  it('log mode spaces equal ratios equally', () => {
    const ps = scale(PriceScaleMode.Log);
    ps.autoScaleTo({ min: 10, max: 1000 });
    const a = ps.priceToCoordinate(10) - ps.priceToCoordinate(100);
    const b = ps.priceToCoordinate(100) - ps.priceToCoordinate(1000);
    expect(a).toBeCloseTo(b, 8);
  });

  it('percentage mode is relative to the base value', () => {
    const ps = scale(PriceScaleMode.Percentage);
    ps.setBaseValue(200);
    expect(ps.toInternal(220)).toBeCloseTo(10, 10);
    expect(ps.fromInternal(-5)).toBeCloseTo(190, 10);
    expect(ps.formatLabel(250)).toBe('25.00%');
  });

  it('indexed-to-100 mode maps the base value to 100', () => {
    const ps = scale(PriceScaleMode.IndexedTo100);
    ps.setBaseValue(50);
    expect(ps.toInternal(50)).toBe(100);
    expect(ps.toInternal(75)).toBe(150);
  });
});

describe('manual scaling', () => {
  it('turns auto-scale off and ignores later auto-scale input', () => {
    const ps = scale();
    ps.autoScaleTo({ min: 0, max: 100 });
    ps.startScale(250);
    ps.scaleTo(400);
    ps.endScale();
    expect(ps.isAutoScale()).toBe(false);
    const y = ps.priceToCoordinate(100);
    ps.autoScaleTo({ min: 0, max: 1 });
    expect(ps.priceToCoordinate(100)).toBe(y);
  });
});

describe('marks', () => {
  it('uses 1/2/2.5/5 steps', () => {
    expect(niceStep(100, 400, 40)).toBe(10);
    expect(niceStep(100, 400, 70)).toBe(20);
    expect(niceStep(1, 400, 40)).toBe(0.1);
  });

  it('produces ordered labels inside the pane', () => {
    const ps = scale();
    ps.setPrecision(2);
    ps.autoScaleTo({ min: 100, max: 200 });
    const marks = ps.marks();
    expect(marks.length).toBeGreaterThan(3);
    for (let i = 1; i < marks.length; i++) expect(marks[i].coordinate).toBeLessThan(marks[i - 1].coordinate);
    // Tick labels use the step's decimals (10-point steps → integers), capped by the symbol precision.
    expect(marks.every((m) => /^\d+$/.test(m.label))).toBe(true);
  });

  it('keeps decimals for fine steps up to the symbol precision', () => {
    const ps = scale();
    ps.setPrecision(5);
    ps.autoScaleTo({ min: 1.08, max: 1.09 });
    expect(ps.marks().every((m) => /^1\.0\d{2,3}$/.test(m.label))).toBe(true);
  });
});
