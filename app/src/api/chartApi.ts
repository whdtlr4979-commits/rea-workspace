import type { PlotRow, Resolution } from '../core/types';
import { decodeFrame, encodeFrame, isHeartbeat } from '../protocol/framing';
import { fromWireRows, type ClientMethod, type ClientRequests, type PointsetPoint, type StudyInputs, type SymbolInfo, type TimescaleChangeset, type WireMessage, type WirePlotRow } from '../protocol/messages';
import { encodeSymbol, type ExtendedSymbol } from '../protocol/symbol';
import type { FrameConnection } from '../server/mockServer';

/** Events delivered to a single series or study, already unpacked from the wire. */
export type SourceEvent =
  | { kind: 'loading'; turnaround: string }
  | { kind: 'completed'; turnaround: string; endOfData: boolean }
  | { kind: 'data'; turnaround: string; rows: PlotRow[]; changeset?: TimescaleChangeset }
  | { kind: 'error'; turnaround: string; message: string }
  | { kind: 'deleted'; turnaround: string };

export type SymbolEvent = { kind: 'resolved'; info: SymbolInfo } | { kind: 'error'; message: string };

type SourceHandler = (event: SourceEvent) => void;
type SymbolHandler = (event: SymbolEvent) => void;

export interface ServerHello {
  session_id: string;
  release: string;
  protocol: string;
}

function randomId(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** Client side of the data connection: framing, heartbeats and per-session routing. */
export class ChartApi {
  private readonly sessions = new Map<string, ChartSession>();
  private hello: ServerHello | null = null;

  constructor(private readonly connection: FrameConnection) {
    connection.onFrame((frame) => this.onFrame(frame));
  }

  serverHello(): ServerHello | null {
    return this.hello;
  }

  createChartSession(): ChartSession {
    const session = new ChartSession(`cs_${randomId(12)}`, this);
    this.sessions.set(session.id, session);
    this.send('chart_create_session', [session.id, '']);
    return session;
  }

  /** @internal */
  send<M extends ClientMethod>(method: M, params: ClientRequests[M]): void {
    this.connection.send(encodeFrame([JSON.stringify({ m: method, p: params })]));
  }

  /** @internal */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  close(): void {
    this.connection.close();
  }

  private onFrame(frame: string): void {
    for (const body of decodeFrame(frame)) {
      if (isHeartbeat(body)) {
        this.connection.send(encodeFrame([body]));
        continue;
      }
      const parsed = JSON.parse(body) as WireMessage | ServerHello;
      if (!('m' in parsed)) {
        this.hello = parsed;
        continue;
      }
      const sessionId = parsed.p[0] as string;
      this.sessions.get(sessionId)?.dispatch(parsed.m, parsed.p.slice(1));
    }
  }
}

export class ChartSession {
  private readonly sourceHandlers = new Map<string, SourceHandler>();
  private readonly symbolHandlers = new Map<string, SymbolHandler>();
  private symbolCounter = 0;

  constructor(
    readonly id: string,
    private readonly api: ChartApi,
  ) {}

  resolveSymbol(symbol: string | ExtendedSymbol, handler: SymbolHandler): string {
    const symbolId = `sds_sym_${++this.symbolCounter}`;
    this.symbolHandlers.set(symbolId, handler);
    this.api.send('resolve_symbol', [this.id, symbolId, encodeSymbol(symbol)]);
    return symbolId;
  }

  createSeries(seriesId: string, turnaround: string, symbolId: string, resolution: Resolution, barCount: number, handler: SourceHandler): void {
    this.sourceHandlers.set(seriesId, handler);
    this.api.send('create_series', [this.id, seriesId, turnaround, symbolId, resolution, barCount]);
  }

  modifySeries(seriesId: string, turnaround: string, symbolId: string, resolution: Resolution): void {
    this.api.send('modify_series', [this.id, seriesId, turnaround, symbolId, resolution]);
  }

  requestMoreData(seriesId: string, count: number): void {
    this.api.send('request_more_data', [this.id, seriesId, count]);
  }

  createStudy(studyId: string, turnaround: string, parentId: string, studyName: string, inputs: StudyInputs, handler: SourceHandler): void {
    this.sourceHandlers.set(studyId, handler);
    this.api.send('create_study', [this.id, studyId, turnaround, parentId, studyName, inputs]);
  }

  modifyStudy(studyId: string, turnaround: string, inputs: StudyInputs): void {
    this.api.send('modify_study', [this.id, studyId, turnaround, inputs]);
  }

  removeStudy(studyId: string): void {
    this.api.send('remove_study', [this.id, studyId]);
  }

  /** Pointset replies arrive as one `du` whose rows map request order to `[barIndex, time]`. */
  createPointset(pointsetId: string, symbolId: string, resolution: Resolution, points: PointsetPoint[], handler: SourceHandler): void {
    this.sourceHandlers.set(pointsetId, (event) => {
      handler(event);
      if (event.kind === 'data' || event.kind === 'error') this.sourceHandlers.delete(pointsetId);
    });
    this.api.send('create_pointset', [this.id, pointsetId, 'turnaround', symbolId, resolution, ...points]);
  }

  delete(): void {
    this.api.send('chart_delete_session', [this.id]);
    this.api.forget(this.id);
  }

  /** @internal Routes one server message (session id already stripped). */
  dispatch(method: string, params: unknown[]): void {
    switch (method) {
      case 'symbol_resolved':
        this.symbolHandlers.get(params[0] as string)?.({ kind: 'resolved', info: params[1] as SymbolInfo });
        return;
      case 'symbol_error':
        this.symbolHandlers.get(params[0] as string)?.({ kind: 'error', message: String(params[1]) });
        return;
      case 'timescale_update':
      case 'du': {
        const objects = params[0] as Record<string, { s?: WirePlotRow[]; st?: WirePlotRow[]; plots?: PlotRow[]; t: string }>;
        const changeset = method === 'timescale_update' ? (params[1] as TimescaleChangeset) : undefined;
        for (const [objectId, payload] of Object.entries(objects)) {
          const rows = payload.plots ?? fromWireRows(payload.s ?? payload.st ?? []);
          this.sourceHandlers.get(objectId)?.({ kind: 'data', turnaround: payload.t, rows, changeset });
        }
        return;
      }
      case 'series_loading':
      case 'study_loading':
        this.sourceHandlers.get(params[0] as string)?.({ kind: 'loading', turnaround: params[1] as string });
        return;
      case 'series_completed': {
        const extra = params[3] as { data_completed?: string } | undefined;
        this.sourceHandlers.get(params[0] as string)?.({ kind: 'completed', turnaround: params[2] as string, endOfData: extra?.data_completed === 'end' });
        return;
      }
      case 'study_completed':
        this.sourceHandlers.get(params[0] as string)?.({ kind: 'completed', turnaround: params[1] as string, endOfData: false });
        return;
      case 'series_error':
      case 'study_error':
      case 'pointset_error':
        this.sourceHandlers.get(params[0] as string)?.({ kind: 'error', turnaround: params[1] as string, message: String(params[2]) });
        return;
      case 'study_deleted': {
        const studyId = params[0] as string;
        this.sourceHandlers.get(studyId)?.({ kind: 'deleted', turnaround: params[1] as string });
        this.sourceHandlers.delete(studyId);
        return;
      }
    }
  }
}
