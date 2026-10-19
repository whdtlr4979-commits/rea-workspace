import { describe, expect, it } from 'vitest';
import { PlotList } from '../src/model/plotList';

const row = (index: number, ...values: number[]) => ({ index, value: [index * 60, ...values] });

describe('PlotList.merge', () => {
  it('fills an empty list', () => {
    const list = new PlotList();
    list.merge([row(1, 10), row(0, 5)]);
    expect(list.all().map((r) => r.index)).toEqual([0, 1]);
  });

  it('prepends history with negative indices', () => {
    const list = new PlotList();
    list.merge([row(0, 1), row(1, 2)]);
    const first = list.merge([row(-2, 3), row(-1, 4)]);
    expect(first?.index).toBe(-2);
    expect(list.all().map((r) => r.index)).toEqual([-2, -1, 0, 1]);
  });

  it('appends a new bar and updates the last bar in place', () => {
    const list = new PlotList();
    list.merge([row(0, 1), row(1, 2)]);
    list.merge([row(2, 3)]);
    list.merge([row(2, 9)]);
    expect(list.size()).toBe(3);
    expect(list.last()?.value[1]).toBe(9);
  });

  it('merges overlapping rows, replacing duplicates', () => {
    const list = new PlotList();
    list.merge([row(0, 1), row(2, 3), row(4, 5)]);
    list.merge([row(1, 20), row(2, 30), row(5, 50)]);
    expect(list.all().map((r) => [r.index, r.value[1]])).toEqual([[0, 1], [1, 20], [2, 30], [4, 5], [5, 50]]);
  });
});

describe('PlotList queries', () => {
  const list = new PlotList();
  list.merge([row(0, 5, 1), row(1, 7, Number.NaN), row(2, 3, 2), row(4, 9, 0)]);

  it('finds exact and nearest rows', () => {
    expect(list.valueAt(1)?.value[1]).toBe(7);
    expect(list.valueAt(3)).toBeNull();
    expect(list.search(3)?.index).toBe(2);
    expect(list.search(-5)?.index).toBe(0);
  });

  it('slices inclusive ranges', () => {
    expect(list.range(1, 3).map((r) => r.index)).toEqual([1, 2]);
    expect(list.range(1.5, 4.2).map((r) => r.index)).toEqual([2, 4]);
  });

  it('computes min/max ignoring NaN', () => {
    expect(list.minMax(0, 2, [1, 2])).toEqual({ min: 1, max: 7 });
    expect(list.minMax(10, 20, [1])).toBeNull();
  });
});
