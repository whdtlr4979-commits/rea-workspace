import { afterEach, describe, expect, it } from 'vitest';
import { ChartApi } from '../src/api/chartApi';
import { ChartStyle, SeriesPlotIndex } from '../src/core/types';
import { ChartModel } from '../src/model/chartModel';
import { DEFAULT_BAR_COUNT } from '../src/model/series';
import { decodeFrame, encodeFrame } from '../src/protocol/framing';
import type { WireMessage } from '../src/protocol/messages';
import { MockDataServer, type FrameConnection } from '../src/server/mockServer';

const NOW = 1_792_400_000;

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Records every message crossing the connection so tests can assert on the wire format. */
function recording(connection: FrameConnection) {
  const sent: WireMessage[] = [];
  const received: WireMessage[] = [];
  const parse = (frame: string, into: WireMessage[]) => {
    for (const body of decodeFrame(frame)) {
      const msg = JSON.parse(body);
      if ('m' in msg) into.push(msg);
    }
  };
  connection.onFrame((f) => parse(f, received));
  return {
    sent,
    received,
    connection: {
      send: (frame: string) => {
        parse(frame, sent);
        connection.send(frame);
      },
      onFrame: (l: (f: string) => void) => connection.onFrame(l),
      close: () => connection.close(),
    } satisfies FrameConnection,
  };
}

let toClose: ChartApi[] = [];
afterEach(() => {
  toClose.forEach((a) => a.close());
  toClose = [];
});

function setup() {
  const server = new MockDataServer({ latencyMs: 0, tickIntervalMs: 0, heartbeatIntervalMs: 0, historyLength: 1000, now: () => NOW });
  const wire = recording(server.connect());
  const api = new ChartApi(wire.connection);
  toClose.push(api);
  const model = new ChartModel(api.createChartSession(), { ticker: 'MOCK:AAPL', resolution: 'D', style: ChartStyle.Candle });
  model.timeScale.setWidth(800);
  return { model, wire, api };
}

describe('chart session protocol', () => {
  it('loads the first page of bars with index 0 at the oldest bar', async () => {
    const { model, wire, api } = setup();
    model.start();
    await flush();
    expect(api.serverHello()?.protocol).toBe('json');
    const create = wire.sent.find((m) => m.m === 'create_series')!;
    expect(create.p.slice(1)).toEqual(['sds_1', 's1', 'sds_sym_1', 'D', DEFAULT_BAR_COUNT]);
    expect(wire.received.map((m) => m.m)).toEqual(['symbol_resolved', 'series_loading', 'timescale_update', 'series_completed']);
    expect(model.series.data.size()).toBe(DEFAULT_BAR_COUNT);
    expect(model.series.data.firstIndex()).toBe(0);
    expect(model.series.getStatus()).toBe('ready');
    expect(model.series.getSymbolInfo()?.pricescale).toBe(100);
  });

  it('prepends history with negative indices when scrolled past the left edge', async () => {
    const { model, wire } = setup();
    model.start();
    await flush();
    model.timeScale.setBarSpacing(1);
    model.requestHistoryIfNeeded();
    await flush();
    const request = wire.sent.find((m) => m.m === 'request_more_data')!;
    expect(request.p[2]).toBeGreaterThan(0);
    expect(model.series.data.firstIndex()).toBe(-(request.p[2] as number));
    expect(model.series.data.lastIndex()).toBe(DEFAULT_BAR_COUNT - 1);
  });

  it('stops asking once the server reports the end of history', async () => {
    const { model, wire } = setup();
    model.start();
    await flush();
    model.timeScale.setBarSpacing(0.5);
    for (let i = 0; i < 10; i++) {
      model.requestHistoryIfNeeded();
      await flush();
    }
    expect(model.series.data.size()).toBe(1000);
    expect(model.series.isEndOfData()).toBe(true);
    const requests = wire.sent.filter((m) => m.m === 'request_more_data').length;
    model.requestHistoryIfNeeded();
    await flush();
    expect(wire.sent.filter((m) => m.m === 'request_more_data').length).toBe(requests);
  });

  it('bumps the turnaround on resolution change and drops stale data', async () => {
    const { model, wire } = setup();
    model.start();
    await flush();
    const dailyClose = model.series.data.last()!.value[SeriesPlotIndex.Close];
    model.setResolution('60');
    await flush();
    const modify = wire.sent.find((m) => m.m === 'modify_series')!;
    expect(modify.p.slice(1)).toEqual(['sds_1', 's2', 'sds_sym_1', '60']);
    const rows = model.series.data.all();
    expect(rows[1].value[0] - rows[0].value[0]).toBe(3600);
    expect(model.series.turnaround()).toBe('s2');
    expect(typeof dailyClose).toBe('number');
  });

  it('runs a study lifecycle: create → modify → remove (spec §8.3.1)', async () => {
    const { model, wire } = setup();
    model.start();
    await flush();
    const study = model.addStudy('RSI');
    await flush();
    const create = wire.sent.find((m) => m.m === 'create_study')!;
    expect(create.p.slice(2, 5)).toEqual(['st1', 'sds_1', 'RSI@mock-studies-1']);
    expect(create.p[5]).toMatchObject({ in_0: { v: 14, t: 'integer' }, in_1: { v: 'close', t: 'source' } });
    expect(study.getStatus()).toBe('ready');
    expect(study.data.size()).toBe(DEFAULT_BAR_COUNT);
    expect(model.panes).toHaveLength(2);

    model.modifyStudy(study, { ...study.getInputs(), in_0: { v: 21, t: 'integer' } });
    await flush();
    const modify = wire.sent.find((m) => m.m === 'modify_study')!;
    expect(modify.p.slice(1, 3)).toEqual([study.id, 'st2']);
    const loading = wire.received.filter((m) => m.m === 'study_loading').map((m) => m.p[2]);
    expect(loading).toEqual(['s1_st1', 's1_st2']);
    // RSI(21) needs 21 changes before its first value.
    expect(Number.isNaN(study.data.valueAt(20)!.value[1])).toBe(true);
    expect(Number.isNaN(study.data.valueAt(21)!.value[1])).toBe(false);

    model.removeStudy(study);
    await flush();
    expect(wire.received.at(-1)).toEqual({ m: 'study_deleted', p: [expect.any(String), study.id, 's1_st2'] });
    expect(model.panes).toHaveLength(1);
  });

  it('recomputes child studies on the server after the series changes', async () => {
    const { model, wire } = setup();
    model.start();
    await flush();
    const study = model.addStudy('SMA');
    await flush();
    model.setTicker('MOCK:BTCUSD');
    await flush();
    const loading = wire.received.filter((m) => m.m === 'study_loading').map((m) => m.p[2]);
    expect(loading).toEqual(['s1_st1', 's2_st1']);
    const lastClose = model.series.data.last()!.value[SeriesPlotIndex.Close];
    const sma = study.data.last()!.value[1];
    expect(Math.abs(sma - lastClose) / lastClose).toBeLessThan(0.5);
    expect(wire.sent.filter((m) => m.m === 'create_study')).toHaveLength(1);
  });

  it('streams realtime ticks as update-last rows', async () => {
    let now = NOW;
    const server = new MockDataServer({ latencyMs: 0, tickIntervalMs: 5, heartbeatIntervalMs: 0, historyLength: 400, now: () => now });
    const api = new ChartApi(server.connect());
    toClose.push(api);
    const model = new ChartModel(api.createChartSession(), { ticker: 'MOCK:EURUSD', resolution: '1', style: ChartStyle.Candle });
    model.timeScale.setWidth(800);
    model.start();
    await flush();
    const before = model.series.data.size();
    await new Promise((r) => setTimeout(r, 30));
    expect(model.series.data.size()).toBe(before);
    now += 60;
    await new Promise((r) => setTimeout(r, 30));
    expect(model.series.data.size()).toBe(before + 1);
  });

  it('echoes heartbeats back to the server', async () => {
    const server = new MockDataServer({ latencyMs: 0, tickIntervalMs: 0, heartbeatIntervalMs: 5, now: () => NOW });
    const inner = server.connect();
    const echoed: string[] = [];
    const api = new ChartApi({
      send: (frame) => {
        echoed.push(...decodeFrame(frame));
        inner.send(frame);
      },
      onFrame: (l) => inner.onFrame(l),
      close: () => inner.close(),
    });
    toClose.push(api);
    await new Promise((r) => setTimeout(r, 25));
    expect(echoed.some((b) => b.startsWith('~h~'))).toBe(true);
    expect(encodeFrame(['~h~1'])).toBe('~m~4~m~~h~1');
  });
});
