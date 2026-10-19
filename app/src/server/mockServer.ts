import { resolutionToSeconds, type PlotRow, type Resolution, type UTCTimestamp } from '../core/types';
import { decodeFrame, encodeFrame, heartbeat, isHeartbeat } from '../protocol/framing';
import { toWireRows, type ClientRequests, type PointsetPoint, type StudyInputs, type SymbolInfo, type WireMessage } from '../protocol/messages';
import { baseTicker, decodeSymbol } from '../protocol/symbol';
import { findSymbol, heikinAshi, MockFeed, type Bar } from './feed';
import { calculatorForName, type StudyCalculator } from './studies';

/** A bidirectional string-frame pipe, the in-process stand-in for the WebSocket. */
export interface FrameConnection {
  send(frame: string): void;
  onFrame(listener: (frame: string) => void): void;
  close(): void;
}

export interface MockServerOptions {
  /** Delay applied to every frame in both directions. */
  latencyMs?: number;
  /** Realtime tick period; 0 disables ticks (tests). */
  tickIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** Bars generated per series; `create_series` and `request_more_data` page through them. */
  historyLength?: number;
  now?: () => UTCTimestamp;
}

interface ResolvedSymbol {
  ticker: string;
  heikinAshi: boolean;
}

interface SeriesState {
  id: string;
  turnaround: string;
  symbolId: string;
  resolution: Resolution;
  feed: MockFeed;
  /** Position in `feed.bars` of bar index 0. Older bars get negative indices. */
  anchor: number;
  /** Position in `feed.bars` of the oldest bar sent to the client. */
  loadedFrom: number;
}

interface StudyState {
  id: string;
  turnaround: string;
  parentId: string;
  calculator: StudyCalculator;
  inputs: StudyInputs;
}

interface ChartSessionState {
  symbols: Map<string, ResolvedSymbol>;
  series: Map<string, SeriesState>;
  studies: Map<string, StudyState>;
}

const PACKAGE_RELEASE = 'mock-release-1';
/** `modify_series` reloads the series from scratch with the default page size (spec §6.6). */
const MODIFY_SERIES_BAR_COUNT = 300;

/**
 * In-process server that speaks the chart protocol from spec §6. It owns bar generation and
 * all indicator math, mirroring the "compute on the server, render on the client" split.
 */
export class MockDataServer {
  private readonly latencyMs: number;
  private readonly tickIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly historyLength: number;
  private readonly now: () => UTCTimestamp;

  constructor(options: MockServerOptions = {}) {
    this.latencyMs = options.latencyMs ?? 20;
    this.tickIntervalMs = options.tickIntervalMs ?? 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.historyLength = options.historyLength ?? 5000;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  connect(): FrameConnection {
    const clientListeners: ((frame: string) => void)[] = [];
    const connection = new ServerConnection(this, (frame) => {
      this.deliver(() => clientListeners.forEach((l) => l(frame)));
    });
    return {
      send: (frame) => this.deliver(() => connection.receive(frame)),
      onFrame: (listener) => clientListeners.push(listener),
      close: () => connection.close(),
    };
  }

  /** @internal */
  deliver(fn: () => void): void {
    if (this.latencyMs <= 0) queueMicrotask(fn);
    else setTimeout(fn, this.latencyMs);
  }

  /** @internal */
  options() {
    return {
      tickIntervalMs: this.tickIntervalMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      historyLength: this.historyLength,
      now: this.now,
    };
  }
}

/** Array position of the bar containing `time`, extrapolated past either end of the feed. */
function locateBar(series: SeriesState, time: UTCTimestamp): number {
  const { bars } = series.feed;
  const step = resolutionToSeconds(series.resolution);
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (time < first.time) return -Math.ceil((first.time - time) / step);
  if (time >= last.time) return bars.length - 1 + Math.floor((time - last.time) / step);
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

class ServerConnection {
  private readonly sessions = new Map<string, ChartSessionState>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private heartbeatCounter = 0;
  private closed = false;

  constructor(
    private readonly server: MockDataServer,
    private readonly sendFrame: (frame: string) => void,
  ) {
    const { tickIntervalMs, heartbeatIntervalMs } = server.options();
    this.sendRaw(JSON.stringify({ session_id: `mock_${Math.random().toString(36).slice(2, 10)}`, release: PACKAGE_RELEASE, protocol: 'json' }));
    if (tickIntervalMs > 0) this.timers.push(setInterval(() => this.onTick(), tickIntervalMs));
    if (heartbeatIntervalMs > 0) {
      this.timers.push(setInterval(() => this.sendRaw(heartbeat(++this.heartbeatCounter)), heartbeatIntervalMs));
    }
  }

  close(): void {
    this.closed = true;
    this.timers.forEach(clearInterval);
  }

  receive(frame: string): void {
    if (this.closed) return;
    for (const body of decodeFrame(frame)) {
      if (isHeartbeat(body)) continue;
      const message = JSON.parse(body) as WireMessage;
      this.handle(message.m as keyof ClientRequests, message.p);
    }
  }

  private sendRaw(body: string): void {
    if (!this.closed) this.sendFrame(encodeFrame([body]));
  }

  private emit(method: string, params: unknown[]): void {
    this.sendRaw(JSON.stringify({ m: method, p: params }));
  }

  private handle(method: keyof ClientRequests, params: unknown[]): void {
    switch (method) {
      case 'chart_create_session': {
        const [cs] = params as ClientRequests['chart_create_session'];
        this.sessions.set(cs, { symbols: new Map(), series: new Map(), studies: new Map() });
        return;
      }
      case 'chart_delete_session': {
        const [cs] = params as ClientRequests['chart_delete_session'];
        this.sessions.delete(cs);
        return;
      }
      case 'resolve_symbol': {
        const [cs, symbolId, symbol] = params as ClientRequests['resolve_symbol'];
        this.resolveSymbol(cs, symbolId, symbol);
        return;
      }
      case 'create_series': {
        const [cs, seriesId, turnaround, symbolId, resolution, barCount] = params as ClientRequests['create_series'];
        this.createSeries(cs, seriesId, turnaround, symbolId, resolution, barCount);
        return;
      }
      case 'modify_series': {
        const [cs, seriesId, turnaround, symbolId, resolution] = params as ClientRequests['modify_series'];
        if (!this.session(cs)?.series.has(seriesId)) return;
        this.createSeries(cs, seriesId, turnaround, symbolId, resolution, MODIFY_SERIES_BAR_COUNT);
        return;
      }
      case 'remove_series': {
        const [cs, seriesId] = params as ClientRequests['remove_series'];
        this.session(cs)?.series.delete(seriesId);
        return;
      }
      case 'request_more_data': {
        const [cs, seriesId, count] = params as ClientRequests['request_more_data'];
        this.requestMoreData(cs, seriesId, count);
        return;
      }
      case 'create_study': {
        const [cs, studyId, turnaround, parentId, studyName, inputs] = params as ClientRequests['create_study'];
        this.createStudy(cs, studyId, turnaround, parentId, studyName, inputs);
        return;
      }
      case 'modify_study': {
        const [cs, studyId, turnaround, inputs] = params as ClientRequests['modify_study'];
        const study = this.session(cs)?.studies.get(studyId);
        if (!study) return;
        study.turnaround = turnaround;
        study.inputs = inputs;
        this.recalculateStudy(cs, study);
        return;
      }
      case 'create_pointset': {
        const [cs, pointsetId, turnaround, symbolId, resolution, ...points] = params as ClientRequests['create_pointset'];
        this.createPointset(cs, pointsetId, turnaround, symbolId, resolution, points);
        return;
      }
      case 'remove_pointset':
        return;
      case 'remove_study': {
        const [cs, studyId] = params as ClientRequests['remove_study'];
        const session = this.session(cs);
        const study = session?.studies.get(studyId);
        if (!session || !study) return;
        session.studies.delete(studyId);
        this.emit('study_deleted', [cs, studyId, this.studyTurnaround(session, study)]);
        return;
      }
    }
  }

  private session(cs: string): ChartSessionState | undefined {
    return this.sessions.get(cs);
  }

  private resolveSymbol(cs: string, symbolId: string, encoded: string): void {
    const session = this.session(cs);
    if (!session) return;
    const ext = decodeSymbol(encoded);
    const ticker = baseTicker(ext);
    const spec = findSymbol(ticker);
    if (!spec) {
      this.emit('symbol_error', [cs, symbolId, 'invalid symbol']);
      return;
    }
    session.symbols.set(symbolId, { ticker, heikinAshi: ext.type === 'BarSetHeikenAshi' });
    const info: SymbolInfo = {
      name: ticker.split(':')[1],
      full_name: ticker,
      description: spec.description,
      pricescale: spec.pricescale,
      minmov: 1,
      timezone: 'Etc/UTC',
      type: spec.type,
    };
    this.emit('symbol_resolved', [cs, symbolId, info]);
  }

  private createSeries(cs: string, seriesId: string, turnaround: string, symbolId: string, resolution: Resolution, barCount: number): void {
    const session = this.session(cs);
    const symbol = session?.symbols.get(symbolId);
    if (!session || !symbol) {
      this.emit('series_error', [cs, seriesId, turnaround, 'unknown symbol']);
      return;
    }
    const spec = findSymbol(symbol.ticker)!;
    const { historyLength, now } = this.server.options();
    const feed = new MockFeed(spec, resolution, now(), historyLength);
    const count = Math.max(1, Math.min(barCount, feed.bars.length));
    const anchor = feed.bars.length - count;
    const series: SeriesState = { id: seriesId, turnaround, symbolId, resolution, feed, anchor, loadedFrom: anchor };
    session.series.set(seriesId, series);

    this.emit('series_loading', [cs, seriesId, turnaround]);
    const rows = this.seriesRows(session, series, series.loadedFrom, feed.bars.length);
    this.emit('timescale_update', [cs, { [seriesId]: { s: toWireRows(rows), t: turnaround } }, { index: rows[0].index, changes: rows.map((r) => r.value[0]) }]);
    this.emit('series_completed', [cs, seriesId, 'streaming', turnaround]);

    for (const study of session.studies.values()) {
      if (study.parentId === seriesId) this.recalculateStudy(cs, study);
    }
  }

  private requestMoreData(cs: string, seriesId: string, count: number): void {
    const session = this.session(cs);
    const series = session?.series.get(seriesId);
    if (!session || !series) return;
    const from = Math.max(0, series.loadedFrom - Math.max(0, Math.floor(count)));
    if (from === series.loadedFrom) {
      this.emit('series_completed', [cs, seriesId, 'streaming', series.turnaround, { data_completed: 'end' }]);
      return;
    }
    const rows = this.seriesRows(session, series, from, series.loadedFrom);
    series.loadedFrom = from;
    this.emit('series_loading', [cs, seriesId, series.turnaround]);
    this.emit('timescale_update', [cs, { [seriesId]: { s: toWireRows(rows), t: series.turnaround } }, { index: rows[0].index, changes: rows.map((r) => r.value[0]) }]);
    this.emit('series_completed', [cs, seriesId, 'streaming', series.turnaround]);
    for (const study of session.studies.values()) {
      if (study.parentId === seriesId) this.recalculateStudy(cs, study);
    }
  }

  /**
   * Resolves drawing anchors to bar indices on the current series (spec §9.2). Points recorded
   * on another interval are placed by time; times outside the history are extrapolated.
   */
  private createPointset(cs: string, pointsetId: string, turnaround: string, symbolId: string, resolution: Resolution, points: PointsetPoint[]): void {
    const session = this.session(cs);
    const series = session ? [...session.series.values()].find((s) => s.symbolId === symbolId && s.resolution === resolution) : undefined;
    if (!series) {
      this.emit('pointset_error', [cs, pointsetId, turnaround, 'no matching series']);
      return;
    }
    const plots = points.map(([time, offset, interval], k) => {
      const position = interval === resolution ? locateBar(series, time) + offset : locateBar(series, time + offset * resolutionToSeconds(interval));
      return { index: k, value: [position - series.anchor, time] };
    });
    this.emit('du', [cs, { [pointsetId]: { plots, t: turnaround } }]);
  }

  private createStudy(cs: string, studyId: string, turnaround: string, parentId: string, studyName: string, inputs: StudyInputs): void {
    const session = this.session(cs);
    if (!session) return;
    const calculator = calculatorForName(studyName);
    if (!calculator) {
      this.emit('study_error', [cs, studyId, turnaround, `unknown study ${studyName}`]);
      return;
    }
    const study: StudyState = { id: studyId, turnaround, parentId, calculator, inputs };
    session.studies.set(studyId, study);
    this.recalculateStudy(cs, study);
  }

  private studyTurnaround(session: ChartSessionState, study: StudyState): string {
    const parent = session.series.get(study.parentId);
    return parent ? `${parent.turnaround}_${study.turnaround}` : study.turnaround;
  }

  /** Full recalculation; sent as one `du` with every loaded row. */
  private recalculateStudy(cs: string, study: StudyState): void {
    const session = this.session(cs);
    const series = session?.series.get(study.parentId);
    if (!session || !series) return;
    const turnaround = this.studyTurnaround(session, study);
    this.emit('study_loading', [cs, study.id, turnaround]);
    const rows = this.studyRows(session, series, study, series.loadedFrom);
    this.emit('du', [cs, { [study.id]: { st: toWireRows(rows), t: turnaround } }]);
    this.emit('study_completed', [cs, study.id, turnaround]);
  }

  private seriesBars(session: ChartSessionState, series: SeriesState): Bar[] {
    const symbol = session.symbols.get(series.symbolId);
    const loaded = series.feed.bars.slice(series.loadedFrom);
    return symbol?.heikinAshi ? heikinAshi(loaded) : loaded;
  }

  private seriesRows(session: ChartSessionState, series: SeriesState, from: number, to: number): PlotRow[] {
    const symbol = session.symbols.get(series.symbolId);
    let bars: Bar[];
    if (symbol?.heikinAshi) {
      // Heikin Ashi depends on earlier bars, so transform from the oldest bar the client will hold.
      const start = Math.min(from, series.loadedFrom);
      bars = heikinAshi(series.feed.bars.slice(start, to)).slice(from - start);
    } else {
      bars = series.feed.bars.slice(from, to);
    }
    return bars.map((b, k) => ({ index: from + k - series.anchor, value: [b.time, b.open, b.high, b.low, b.close, b.volume] }));
  }

  private studyRows(session: ChartSessionState, series: SeriesState, study: StudyState, fromPosition: number): PlotRow[] {
    const bars = this.seriesBars(session, series);
    const plots = study.calculator.calculate(bars, study.inputs);
    const rows: PlotRow[] = [];
    for (let k = fromPosition - series.loadedFrom; k < bars.length; k++) {
      rows.push({ index: series.loadedFrom + k - series.anchor, value: [bars[k].time, ...plots.map((p) => p[k])] });
    }
    return rows;
  }

  private onTick(): void {
    const now = this.server.options().now();
    for (const [cs, session] of this.sessions) {
      for (const series of session.series.values()) {
        const position = series.feed.tick(now);
        const rows = this.seriesRows(session, series, position, series.feed.bars.length);
        const lastBarOpen = rows[rows.length - 1].value[0];
        const barCloseTime = lastBarOpen + resolutionToSeconds(series.resolution) - 1;
        this.emit('du', [cs, { [series.id]: { s: toWireRows(rows), t: series.turnaround, lbs: { bar_close_time: barCloseTime } } }]);
        for (const study of session.studies.values()) {
          if (study.parentId !== series.id) continue;
          const studyRows = this.studyRows(session, series, study, position);
          this.emit('du', [cs, { [study.id]: { st: toWireRows(studyRows), t: this.studyTurnaround(session, study) } }]);
        }
      }
    }
  }
}
