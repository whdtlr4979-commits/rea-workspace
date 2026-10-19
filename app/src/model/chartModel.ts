import type { ChartSession } from '../api/chartApi';
import { ChartStyle, InvalidationLevel, PriceScaleMode, SeriesPlotIndex, type BarIndex, type Resolution } from '../core/types';
import type { StudyInputs, SymbolInfo } from '../protocol/messages';
import type { MinMax } from './plotList';
import { PriceScale } from './priceScale';
import { MainSeries } from './series';
import { StudySource } from './study';
import { defaultInputs, STUDY_META, type StudyMeta } from './studyMeta';
import { easeInOutQuint, TimeScale } from './timeScale';

/** Spec §7.1 saved layout: main pane stretch factor 2000; indicator panes get half of that. */
const MAIN_PANE_STRETCH = 2000;
const STUDY_PANE_STRETCH = 1000;
/**
 * Spec §4.3 asks for exactly the missing bar count. We round small gaps up so slow scrolling
 * does not issue a request every few bars.
 */
const MIN_HISTORY_REQUEST = 100;
const SCROLL_TO_REALTIME_MS = 1000;

export class Pane {
  readonly priceScale: PriceScale;
  readonly overlayScales = new Map<string, PriceScale>();
  readonly studies: StudySource[] = [];
  height = 0;

  constructor(
    readonly id: string,
    readonly isMain: boolean,
    readonly stretchFactor: number,
  ) {
    this.priceScale = new PriceScale(`${id}-right`);
  }

  scaleFor(study: StudySource): PriceScale {
    return this.overlayScales.get(study.id) ?? this.priceScale;
  }

  allScales(): PriceScale[] {
    return [this.priceScale, ...this.overlayScales.values()];
  }
}

export interface CrosshairState {
  visible: boolean;
  /** Pointer position; `x` is snapped to the bar centre, `pointerX` is where the mouse is. */
  pointerX: number;
  x: number;
  y: number;
  index: BarIndex;
  pane: Pane | null;
}

export interface ChartModelOptions {
  ticker: string;
  resolution: Resolution;
  style: ChartStyle;
}

type InvalidateListener = (level: InvalidationLevel) => void;

export class ChartModel {
  readonly timeScale = new TimeScale();
  readonly panes: Pane[] = [];
  readonly series: MainSeries;
  readonly crosshair: CrosshairState = { visible: false, pointerX: 0, x: 0, y: 0, index: 0, pane: null };
  private readonly listeners: InvalidateListener[] = [];
  private readonly structureListeners: (() => void)[] = [];
  private paneCounter = 0;
  private animationFrame = 0;
  private dataSeen = false;

  constructor(
    private readonly session: ChartSession,
    options: ChartModelOptions,
  ) {
    this.panes.push(new Pane(this.nextPaneId(), true, MAIN_PANE_STRETCH));
    this.series = new MainSeries(session, options.ticker, options.resolution, options.style, {
      onSeriesData: (_first, reset) => this.onSeriesData(reset),
      onSeriesStatus: () => {
        this.requestHistoryIfNeeded();
        this.invalidate(InvalidationLevel.Light);
      },
      onSymbolResolved: (info) => this.onSymbolResolved(info),
    });
  }

  start(): void {
    this.series.start();
  }

  mainPane(): Pane {
    return this.panes[0];
  }

  onInvalidate(listener: InvalidateListener): void {
    this.listeners.push(listener);
  }

  /** Fired when panes are added or removed so the widget can rebuild its layout. */
  onStructureChange(listener: () => void): void {
    this.structureListeners.push(listener);
  }

  invalidate(level: InvalidationLevel): void {
    this.listeners.forEach((l) => l(level));
  }

  private nextPaneId(): string {
    return `pane${++this.paneCounter}`;
  }

  private onSymbolResolved(info: SymbolInfo): void {
    this.mainPane().priceScale.setPrecision(Math.log10(info.pricescale));
    this.invalidate(InvalidationLevel.Full);
  }

  private onSeriesData(reset: boolean): void {
    const data = this.series.data;
    this.timeScale.setDataRange(data.firstIndex(), data.lastIndex());
    if (reset && this.dataSeen) this.timeScale.reset();
    this.dataSeen = true;
    this.snapCrosshair();
    this.updateAutoScale();
    this.invalidate(InvalidationLevel.Full);
  }

  // --- user-facing operations -------------------------------------------------------------

  setTicker(ticker: string): void {
    this.series.modify({ ticker });
  }

  setResolution(resolution: Resolution): void {
    this.series.modify({ resolution });
  }

  setStyle(style: ChartStyle): void {
    this.series.modify({ style });
    this.updateAutoScale();
    this.invalidate(InvalidationLevel.Full);
  }

  setPriceScaleMode(mode: PriceScaleMode): void {
    this.mainPane().priceScale.setMode(mode);
    this.updateAutoScale();
    this.invalidate(InvalidationLevel.Full);
  }

  resetPriceScale(pane: Pane): void {
    pane.priceScale.setAutoScale(true);
    this.updateAutoScale();
    this.invalidate(InvalidationLevel.Full);
  }

  addStudy(metaId: keyof typeof STUDY_META | string, inputs?: StudyInputs): StudySource {
    const meta: StudyMeta | undefined = STUDY_META[metaId];
    if (!meta) throw new Error(`Unknown study ${metaId}`);
    const study = new StudySource(meta, inputs ?? defaultInputs(meta), this.session, this.series, () => {
      this.updateAutoScale();
      this.invalidate(InvalidationLevel.Full);
    });
    let pane: Pane;
    if (meta.isPriceStudy || meta.overlay) {
      pane = this.mainPane();
      if (meta.overlay) {
        const scale = new PriceScale(`${pane.id}-${study.id}`, meta.overlay.margins);
        scale.setPrecision(meta.precision);
        pane.overlayScales.set(study.id, scale);
      }
    } else {
      pane = new Pane(this.nextPaneId(), false, STUDY_PANE_STRETCH);
      pane.priceScale.setPrecision(meta.precision);
      this.panes.push(pane);
    }
    pane.studies.push(study);
    study.create();
    this.structureListeners.forEach((l) => l());
    this.invalidate(InvalidationLevel.Full);
    return study;
  }

  modifyStudy(study: StudySource, inputs: StudyInputs): void {
    study.modify(inputs);
  }

  removeStudy(study: StudySource): void {
    const pane = this.paneOf(study);
    if (!pane) return;
    study.remove();
    pane.studies.splice(pane.studies.indexOf(study), 1);
    pane.overlayScales.delete(study.id);
    if (!pane.isMain && pane.studies.length === 0) this.panes.splice(this.panes.indexOf(pane), 1);
    this.structureListeners.forEach((l) => l());
    this.updateAutoScale();
    this.invalidate(InvalidationLevel.Full);
  }

  paneOf(study: StudySource): Pane | undefined {
    return this.panes.find((p) => p.studies.includes(study));
  }

  allStudies(): StudySource[] {
    return this.panes.flatMap((p) => p.studies);
  }

  // --- viewport ------------------------------------------------------------------------------

  zoom(x: number, delta: number): void {
    this.timeScale.zoom(x, delta);
    this.onViewportChanged();
  }

  startScroll(x: number): void {
    this.stopAnimation();
    this.timeScale.startScroll(x);
  }

  scrollTo(x: number): void {
    this.timeScale.scrollTo(x);
    this.onViewportChanged();
  }

  endScroll(): void {
    this.timeScale.endScroll();
  }

  startTimeScale(x: number): void {
    this.timeScale.startScale(x);
  }

  scaleTimeTo(x: number): void {
    this.timeScale.scaleTo(x);
    this.onViewportChanged();
  }

  endTimeScale(): void {
    this.timeScale.endScale();
  }

  resetTimeScale(): void {
    this.timeScale.reset();
    this.onViewportChanged();
  }

  /** Spec §4.3: 1000 ms `easeInOutQuint` animation back to the default right offset. */
  scrollToRealtime(): void {
    this.stopAnimation();
    const from = this.timeScale.getRightOffset();
    const to = this.timeScale.options.defaultRightOffset;
    if (typeof requestAnimationFrame === 'undefined') {
      this.timeScale.setRightOffset(to);
      this.onViewportChanged();
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / SCROLL_TO_REALTIME_MS);
      this.timeScale.setRightOffset(from + (to - from) * easeInOutQuint(t));
      this.onViewportChanged();
      this.animationFrame = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.animationFrame = requestAnimationFrame(step);
  }

  private stopAnimation(): void {
    if (this.animationFrame !== 0 && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  private onViewportChanged(): void {
    this.snapCrosshair();
    this.updateAutoScale();
    this.requestHistoryIfNeeded();
    this.invalidate(InvalidationLevel.Light);
  }

  requestHistoryIfNeeded(): void {
    const missing = this.timeScale.missingHistoryBars();
    if (missing > 0) this.series.requestMoreData(Math.max(missing, MIN_HISTORY_REQUEST));
  }

  setCrosshair(x: number, y: number, pane: Pane | null): void {
    Object.assign(this.crosshair, { visible: pane !== null, pointerX: x, y, pane });
    this.snapCrosshair();
    this.invalidate(InvalidationLevel.Cursor);
  }

  /** Re-derives the hovered bar after the viewport or data moved under a still pointer. */
  private snapCrosshair(): void {
    const index = this.timeScale.coordinateToIndex(this.crosshair.pointerX);
    this.crosshair.index = index;
    this.crosshair.x = this.timeScale.indexToCoordinate(index);
  }

  clearCrosshair(): void {
    this.crosshair.visible = false;
    this.crosshair.pane = null;
    this.invalidate(InvalidationLevel.Cursor);
  }

  // --- auto-scale ---------------------------------------------------------------------------

  updateAutoScale(): void {
    const { from, to } = this.timeScale.visibleBars();
    for (const pane of this.panes) {
      let range: MinMax | null = null;
      if (pane.isMain) {
        range = this.series.data.minMax(from, to, this.series.priceColumns());
        const firstVisible = this.series.data.search(Math.max(from, this.series.data.firstIndex() ?? from));
        if (firstVisible) pane.priceScale.setBaseValue(firstVisible.value[SeriesPlotIndex.Close]);
      }
      for (const study of pane.studies) {
        const columns = study.meta.plots.flatMap((p, k) => (p.visible && p.kind !== 'colorer' ? [k + 1] : []));
        const studyRange = study.data.minMax(from, to, columns);
        const overlay = pane.overlayScales.get(study.id);
        if (overlay) {
          if (studyRange) overlay.autoScaleTo({ min: 0, max: studyRange.max });
          continue;
        }
        range = unionRange(range, studyRange);
        for (const band of study.meta.bands ?? []) range = unionRange(range, { min: band.value, max: band.value });
      }
      pane.priceScale.autoScaleTo(range);
    }
  }
}

function unionRange(a: MinMax | null, b: MinMax | null): MinMax | null {
  if (a === null) return b;
  if (b === null) return a;
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
}
