import { afterEach, describe, expect, it } from 'vitest';
import { ChartApi } from '../src/api/chartApi';
import { ChartStyle, SeriesPlotIndex } from '../src/core/types';
import { distanceToSegment, extendSegment, lineYAt } from '../src/drawing/geometry';
import { LineTool } from '../src/drawing/lineTool';
import { MemoryDrawingStorage } from '../src/drawing/storage';
import { toolDefinition, type ToolGeometry } from '../src/drawing/tools';
import { MagnetMode, type LogicalPoint, type PixelPoint } from '../src/drawing/types';
import { ChartModel } from '../src/model/chartModel';
import { decodeFrame } from '../src/protocol/framing';
import type { WireMessage } from '../src/protocol/messages';
import { MockDataServer } from '../src/server/mockServer';

const NOW = 1_792_400_000;

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function geometry(points: PixelPoint[], extra: Partial<ToolGeometry> = {}): ToolGeometry {
  return {
    width: 800,
    height: 400,
    points,
    logical: points.map((p) => ({ index: p.x, price: 400 - p.y })),
    props: { ...toolDefinition('LineToolTrendLine').defaults, linecolor: '#000', linewidth: 1, linestyle: 0, extendLeft: false, extendRight: false, fillBackground: false, backgroundColor: '', showPriceLabels: false },
    priceToY: (price) => 400 - price,
    formatPrice: (price) => price.toFixed(2),
    ...extra,
  };
}

describe('geometry', () => {
  it('measures distance to a segment, clamping to its ends', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('extends a segment to the box edges only on the requested sides', () => {
    const [a, b] = extendSegment({ x: 100, y: 100 }, { x: 200, y: 200 }, false, true, 400, 400);
    expect(a).toEqual({ x: 100, y: 100 });
    expect(b.x).toBeCloseTo(400);
    const [c] = extendSegment({ x: 100, y: 100 }, { x: 200, y: 200 }, true, false, 400, 400);
    expect(c.x).toBeCloseTo(0);
  });

  it('evaluates a line at x', () => {
    expect(lineYAt({ x: 0, y: 0 }, { x: 10, y: 20 }, 5)).toBe(10);
  });
});

describe('tool hit tests', () => {
  it('trend line hits near the segment only', () => {
    const def = toolDefinition('LineToolTrendLine');
    const g = geometry([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
    expect(def.hitTest(g, 200, 104, 6)).toBe(true);
    expect(def.hitTest(g, 350, 100, 6)).toBe(false);
  });

  it('ray reaches past its second anchor', () => {
    const def = toolDefinition('LineToolRay');
    const g = geometry([{ x: 100, y: 100 }, { x: 300, y: 100 }], { props: { ...geometry([]).props, extendRight: true } });
    expect(def.hitTest(g, 700, 100, 6)).toBe(true);
  });

  it('horizontal line spans the whole width', () => {
    expect(toolDefinition('LineToolHorzLine').hitTest(geometry([{ x: 100, y: 50 }]), 790, 52, 6)).toBe(true);
    expect(toolDefinition('LineToolHorzRay').hitTest(geometry([{ x: 100, y: 50 }]), 50, 50, 6)).toBe(false);
  });

  it('filled rectangle hits inside, outline-only rectangle only on edges', () => {
    const def = toolDefinition('LineToolRectangle');
    const pts = [{ x: 100, y: 100 }, { x: 200, y: 200 }];
    const filled = geometry(pts, { props: { ...geometry([]).props, fillBackground: true } });
    expect(def.hitTest(filled, 150, 150, 6)).toBe(true);
    expect(def.hitTest(geometry(pts), 150, 150, 6)).toBe(false);
    expect(def.hitTest(geometry(pts), 150, 101, 6)).toBe(true);
  });

  it('parallel channel hits both lines and the fill between them', () => {
    const def = toolDefinition('LineToolParallelChannel');
    const g = geometry([{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 200, y: 160 }], { props: { ...geometry([]).props, fillBackground: true } });
    expect(def.hitTest(g, 250, 160, 6)).toBe(true);
    expect(def.hitTest(g, 250, 130, 6)).toBe(true);
    expect(def.hitTest(g, 250, 200, 6)).toBe(false);
  });
});

describe('LineTool DTO', () => {
  it('round-trips through the charts-storage shape (spec §7.2)', () => {
    const tool = new LineTool('LineToolRay', 'abc123', 'MOCK:AAPL', [
      { time_t: 100, offset: 0, price: 10, interval: 'D' },
      { time_t: 200, offset: 3, price: 12, interval: 'D' },
    ], { linecolor: '#F23645' });
    const dto = tool.toDTO();
    expect(dto.state.type).toBe('LineToolRay');
    expect(dto.state.state.extendRight).toBe(true);
    expect(dto.state.points[1]).toEqual({ time_t: 200, offset: 3, price: 12, interval: 'D' });
    expect(dto.ownerSource).toBe('_seriesId');
    const back = LineTool.fromDTO(JSON.parse(JSON.stringify(dto)))!;
    expect(back.id).toBe('abc123');
    expect(back.props.linecolor).toBe('#F23645');
    expect(back.points).toEqual(tool.points);
  });
});

let apis: ChartApi[] = [];
afterEach(() => {
  apis.forEach((a) => a.close());
  apis = [];
});

async function setup(storage = new MemoryDrawingStorage()) {
  const server = new MockDataServer({ latencyMs: 0, tickIntervalMs: 0, heartbeatIntervalMs: 0, historyLength: 2000, now: () => NOW });
  const connection = server.connect();
  const sent: WireMessage[] = [];
  const api = new ChartApi({
    send: (frame) => {
      for (const body of decodeFrame(frame)) if (body.startsWith('{')) sent.push(JSON.parse(body));
      connection.send(frame);
    },
    onFrame: (l) => connection.onFrame(l),
    close: () => connection.close(),
  });
  apis.push(api);
  const model = new ChartModel(api.createChartSession(), { ticker: 'MOCK:AAPL', resolution: 'D', style: ChartStyle.Candle, drawingStorage: storage, drawingSaveDelayMs: 0 });
  model.timeScale.setWidth(800);
  model.mainPriceScale().setHeight(400);
  model.start();
  await flush();
  return { model, storage, sent, drawings: model.drawings };
}

function px(model: ChartModel, point: LogicalPoint): PixelPoint {
  return model.drawings.toPixel(point);
}

describe('DrawingManager', () => {
  it('draws a trend line with two clicks and stores bar-time anchors', async () => {
    const { model, drawings, storage } = await setup();
    drawings.setActiveTool('LineToolTrendLine');
    expect(drawings.pointerDown(300, 150)).toBe(true);
    drawings.pointerUp(300, 150);
    drawings.pointerMove(500, 250);
    expect(drawings.creatingTool()?.logical).toHaveLength(2);
    drawings.pointerDown(500, 250);
    drawings.pointerUp(500, 250);

    expect(drawings.all()).toHaveLength(1);
    expect(drawings.getActiveTool()).toBe('cursor');
    const tool = drawings.all()[0];
    expect(drawings.getSelected()).toBe(tool);
    const firstRow = model.series.data.valueAt(model.timeScale.coordinateToIndex(300))!;
    expect(tool.points[0]).toMatchObject({ time_t: firstRow.value[SeriesPlotIndex.Time], offset: 0, interval: 'D' });
    expect(storage.data.get('MOCK:AAPL')?.[0].state.type).toBe('LineToolTrendLine');
  });

  it('supports press-drag-release placement', async () => {
    const { drawings } = await setup();
    drawings.setActiveTool('LineToolRectangle');
    drawings.pointerDown(200, 100);
    drawings.pointerMove(260, 160);
    drawings.pointerMove(320, 220);
    drawings.pointerUp(320, 220);
    expect(drawings.all()).toHaveLength(1);
    expect(drawings.all()[0].type).toBe('LineToolRectangle');
  });

  it('places one-click tools immediately and honours keep-drawing', async () => {
    const { drawings } = await setup();
    drawings.toggleKeepDrawing();
    drawings.setActiveTool('LineToolHorzLine');
    drawings.pointerDown(400, 120);
    drawings.pointerDown(400, 200);
    expect(drawings.all()).toHaveLength(2);
    expect(drawings.getActiveTool()).toBe('LineToolHorzLine');
  });

  it('records points beyond the last bar as an offset from it', async () => {
    const { model, drawings } = await setup();
    drawings.setActiveTool('LineToolVertLine');
    drawings.pointerDown(790, 200);
    const point = drawings.all()[0].points[0];
    const last = model.series.data.last()!;
    expect(point.time_t).toBe(last.value[SeriesPlotIndex.Time]);
    expect(point.offset).toBe(model.timeScale.coordinateToIndex(790) - last.index);
    expect(point.offset).toBeGreaterThan(0);
  });

  it('moves one anchor by its handle and the whole drawing by its body', async () => {
    const { model, drawings } = await setup();
    drawings.setActiveTool('LineToolTrendLine');
    drawings.pointerDown(300, 150);
    drawings.pointerDown(500, 250);
    const tool = drawings.all()[0];
    const [h0] = drawings.handlePositions(tool);
    drawings.pointerDown(h0.x, h0.y);
    drawings.pointerMove(h0.x - 60, h0.y);
    drawings.pointerUp(h0.x - 60, h0.y);
    expect(tool.logical[0]!.index).toBe(model.timeScale.coordinateToIndex(h0.x - 60));
    expect(tool.points[0].time_t).toBe(model.series.data.valueAt(tool.logical[0]!.index)!.value[0]);

    const before = tool.resolvedPoints().map((p) => ({ ...p }));
    const mid = { x: (px(model, before[0]).x + px(model, before[1]).x) / 2, y: (px(model, before[0]).y + px(model, before[1]).y) / 2 };
    drawings.pointerDown(mid.x, mid.y);
    drawings.pointerMove(mid.x + 30, mid.y + 20);
    drawings.pointerUp(mid.x + 30, mid.y + 20);
    const shift = model.timeScale.coordinateToIndex(mid.x + 30) - model.timeScale.coordinateToIndex(mid.x);
    expect(tool.logical.map((p) => p!.index)).toEqual(before.map((p) => p.index + shift));
    expect(tool.logical[0]!.price).toBeLessThan(before[0].price);
  });

  it('ignores clicks that do not move past the drag threshold', async () => {
    const { drawings } = await setup();
    drawings.setActiveTool('LineToolHorzLine');
    drawings.pointerDown(400, 200);
    const tool = drawings.all()[0];
    const before = { ...tool.points[0] };
    drawings.pointerDown(400, 200);
    drawings.pointerMove(402, 201);
    drawings.pointerUp(402, 201);
    expect(tool.points[0]).toEqual(before);
  });

  it('cancels creation with Esc and deletes the selection', async () => {
    const { drawings } = await setup();
    drawings.setActiveTool('LineToolTrendLine');
    drawings.pointerDown(300, 150);
    expect(drawings.cancel()).toBe(true);
    expect(drawings.creatingTool()).toBeNull();
    drawings.pointerDown(300, 150);
    drawings.pointerDown(400, 150);
    expect(drawings.removeSelected()).toBe(true);
    expect(drawings.all()).toHaveLength(0);
  });

  it('snaps to the nearest OHLC value with the strong magnet', async () => {
    const { model, drawings } = await setup();
    drawings.setMagnet(true, MagnetMode.Strong);
    const index = model.timeScale.coordinateToIndex(400);
    const row = model.series.data.valueAt(index)!;
    const point = drawings.toLogical(400, 5);
    expect([1, 2, 3, 4].map((c) => row.value[c])).toContain(point.price);
    drawings.setMagnet(true, MagnetMode.Weak);
    expect(drawings.toLogical(400, 5).price).toBe(model.mainPriceScale().coordinateToPrice(5));
  });

  it('leaves the chart alone while drawings are hidden or locked', async () => {
    const { drawings } = await setup();
    drawings.setActiveTool('LineToolHorzLine');
    drawings.pointerDown(400, 200);
    drawings.toggleLocked();
    const tool = drawings.all()[0];
    const before = { ...tool.points[0] };
    drawings.pointerDown(300, 200);
    drawings.pointerMove(300, 260);
    drawings.pointerUp(300, 260);
    expect(tool.points[0]).toEqual(before);
    drawings.toggleHidden();
    expect(drawings.pointerDown(300, 200)).toBe(false);
    expect(drawings.visibleTools()).toHaveLength(0);
  });

  it('re-resolves anchors through a server pointset after an interval change', async () => {
    const { model, drawings, sent } = await setup();
    drawings.setActiveTool('LineToolHorzLine');
    const lastX = model.timeScale.indexToCoordinate(model.series.data.lastIndex()!);
    drawings.pointerDown(lastX, 200);
    const tool = drawings.all()[0];
    const dayStart = tool.points[0].time_t;

    model.setResolution('60');
    await flush();
    const pointset = sent.find((m) => m.m === 'create_pointset')!;
    expect(pointset.p.slice(2, 5)).toEqual(['turnaround', 'sds_sym_1', '60']);
    expect(pointset.p[5]).toEqual([dayStart, 0, 'D']);
    const resolved = tool.logical[0]!;
    expect(model.series.data.valueAt(resolved.index)!.value[SeriesPlotIndex.Time]).toBe(dayStart);
  });

  it('keeps drawings per symbol', async () => {
    const { model, drawings, storage } = await setup();
    drawings.setActiveTool('LineToolHorzLine');
    drawings.pointerDown(400, 200);
    model.setTicker('MOCK:BTCUSD');
    await flush();
    expect(drawings.all()).toHaveLength(0);
    expect(storage.data.get('MOCK:AAPL')).toHaveLength(1);
    model.setTicker('MOCK:AAPL');
    await flush();
    expect(drawings.all()).toHaveLength(1);
    expect(drawings.all()[0].isResolved()).toBe(true);
  });

  it('restores saved drawings when a chart opens', async () => {
    const storage = new MemoryDrawingStorage();
    const first = await setup(storage);
    first.drawings.setActiveTool('LineToolFibRetracement');
    first.drawings.pointerDown(300, 300);
    first.drawings.pointerDown(600, 100);
    const saved = first.drawings.all()[0].points;
    const second = await setup(storage);
    expect(second.drawings.all()).toHaveLength(1);
    expect(second.drawings.all()[0].points).toEqual(saved);
    expect(second.drawings.all()[0].isResolved()).toBe(true);
  });
});

describe('server pointset', () => {
  it('extrapolates offsets past the last bar and maps other intervals by time', async () => {
    const { model, drawings, sent } = await setup();
    const last = model.series.data.last()!;
    let rows: { index: number; value: number[] }[] = [];
    model.session.createPointset('pointset_test', model.series.getSymbolId()!, 'D', [
      [last.value[0], 5, 'D'],
      [last.value[0], 0, '60'],
      [last.value[0] - 86_400 * 3 + 3600 * 5, 0, '60'],
    ], (e) => {
      if (e.kind === 'data') rows = e.rows;
    });
    await flush();
    expect(sent.at(-1)?.m).toBe('create_pointset');
    expect(rows.map((r) => r.value[0])).toEqual([last.index + 5, last.index, last.index - 3]);
    expect(drawings.all()).toHaveLength(0);
  });
});
