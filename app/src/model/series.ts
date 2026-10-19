import type { ChartSession, SourceEvent } from '../api/chartApi';
import { ChartStyle, SeriesPlotIndex, type Resolution } from '../core/types';
import type { SymbolInfo } from '../protocol/messages';
import type { ExtendedSymbol } from '../protocol/symbol';
import { PlotList } from './plotList';

export type SeriesStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Initial page size (spec §6.5 `DEFAULT_NUMBARS`). */
export const DEFAULT_BAR_COUNT = 300;

export interface SeriesListener {
  onSeriesData(firstChanged: number | null, resetData: boolean): void;
  onSeriesStatus(): void;
  onSymbolResolved(info: SymbolInfo): void;
}

/**
 * Client view of the main series. Symbol, resolution and synthetic styles are resolved on the
 * server; every change bumps the turnaround so late replies for the old setup are dropped.
 */
export class MainSeries {
  readonly id = 'sds_1';
  readonly data = new PlotList();
  private status: SeriesStatus = 'idle';
  private turnaroundCounter = 1;
  private dataTurnaround: string | null = null;
  private symbolId: string | null = null;
  private symbolInfo: SymbolInfo | null = null;
  private endOfData = false;
  private requestingMore = false;
  private started = false;

  constructor(
    private readonly session: ChartSession,
    private ticker: string,
    private resolution: Resolution,
    private style: ChartStyle,
    private readonly listener: SeriesListener,
  ) {}

  turnaround(): string {
    return `s${this.turnaroundCounter}`;
  }

  getStatus(): SeriesStatus {
    return this.status;
  }

  getTicker(): string {
    return this.ticker;
  }

  getResolution(): Resolution {
    return this.resolution;
  }

  getStyle(): ChartStyle {
    return this.style;
  }

  /** Id of the resolved symbol the series was created with; pointsets must use the same one. */
  getSymbolId(): string | null {
    return this.symbolId;
  }

  getSymbolInfo(): SymbolInfo | null {
    return this.symbolInfo;
  }

  isEndOfData(): boolean {
    return this.endOfData;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.status = 'loading';
    this.symbolId = this.resolve();
    this.session.createSeries(this.id, this.turnaround(), this.symbolId, this.resolution, DEFAULT_BAR_COUNT, (e) => this.onEvent(e));
  }

  /** Changes symbol, resolution or style. Heikin Ashi is a server-side synthetic symbol. */
  modify(changes: { ticker?: string; resolution?: Resolution; style?: ChartStyle }): void {
    const symbolChanged = changes.ticker !== undefined && changes.ticker !== this.ticker;
    const resolutionChanged = changes.resolution !== undefined && changes.resolution !== this.resolution;
    const wasSynthetic = this.style === ChartStyle.HeikinAshi;
    if (changes.ticker !== undefined) this.ticker = changes.ticker;
    if (changes.resolution !== undefined) this.resolution = changes.resolution;
    if (changes.style !== undefined) this.style = changes.style;
    const syntheticChanged = wasSynthetic !== (this.style === ChartStyle.HeikinAshi);
    if (!symbolChanged && !resolutionChanged && !syntheticChanged) {
      this.listener.onSeriesData(null, false);
      return;
    }
    this.turnaroundCounter++;
    this.status = 'loading';
    this.endOfData = false;
    this.requestingMore = false;
    if (symbolChanged || syntheticChanged) this.symbolId = this.resolve();
    this.session.modifySeries(this.id, this.turnaround(), this.symbolId!, this.resolution);
    this.listener.onSeriesStatus();
  }

  /** Spec §4.3: load older bars when the left edge runs past the loaded data. */
  requestMoreData(count: number): void {
    if (this.status !== 'ready' || this.requestingMore || this.endOfData || count <= 0) return;
    this.requestingMore = true;
    this.status = 'loading';
    this.session.requestMoreData(this.id, count);
    this.listener.onSeriesStatus();
  }

  private resolve(): string {
    const plain: ExtendedSymbol = { symbol: this.ticker, adjustment: 'splits' };
    const symbol: ExtendedSymbol = this.style === ChartStyle.HeikinAshi ? { symbol: plain, type: 'BarSetHeikenAshi', inputs: {} } : plain;
    return this.session.resolveSymbol(symbol, (event) => {
      if (event.kind === 'resolved') {
        this.symbolInfo = event.info;
        this.listener.onSymbolResolved(event.info);
      } else {
        this.status = 'error';
        this.listener.onSeriesStatus();
      }
    });
  }

  private onEvent(event: SourceEvent): void {
    if (event.turnaround !== this.turnaround()) return;
    switch (event.kind) {
      case 'loading':
        this.status = 'loading';
        this.listener.onSeriesStatus();
        return;
      case 'data': {
        const reset = this.dataTurnaround !== event.turnaround;
        if (reset) {
          this.data.clear();
          this.dataTurnaround = event.turnaround;
        }
        const first = this.data.merge(event.rows);
        this.listener.onSeriesData(first?.index ?? null, reset);
        return;
      }
      case 'completed':
        this.status = 'ready';
        this.requestingMore = false;
        if (event.endOfData) this.endOfData = true;
        this.listener.onSeriesStatus();
        return;
      case 'error':
      case 'deleted':
        this.status = 'error';
        this.requestingMore = false;
        this.listener.onSeriesStatus();
        return;
    }
  }

  /** Columns that bound the price range for the current style. */
  priceColumns(): number[] {
    return this.style === ChartStyle.Line || this.style === ChartStyle.Area
      ? [SeriesPlotIndex.Close]
      : [SeriesPlotIndex.High, SeriesPlotIndex.Low];
  }
}
