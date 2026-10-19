import type { ChartSession } from '../api/chartApi';
import { InvalidationLevel, SeriesPlotIndex } from '../core/types';
import type { PriceScale } from '../model/priceScale';
import type { MainSeries } from '../model/series';
import type { TimeScale } from '../model/timeScale';
import type { PointsetPoint } from '../protocol/messages';
import { distance } from './geometry';
import { LineTool } from './lineTool';
import type { DrawingStorage } from './storage';
import type { ToolGeometry, ToolRenderContext } from './tools';
import { MagnetMode, type DrawingPoint, type LineToolProperties, type LineToolType, type LogicalPoint, type PixelPoint } from './types';

export type ActiveTool = 'cursor' | LineToolType;

/** Pointer travel (px) that turns a click into a drag. */
const DRAG_THRESHOLD_PX = 4;
const HIT_TOLERANCE_PX = 6;
const HANDLE_HIT_PX = 8;
/** Weak magnet only snaps when an OHLC value is this close (spec §4.5 names the modes, not the radius). */
const WEAK_MAGNET_PX = 20;

export interface DrawingHost {
  readonly timeScale: TimeScale;
  readonly series: MainSeries;
  readonly session: ChartSession;
  mainPriceScale(): PriceScale;
  invalidate(level: InvalidationLevel): void;
}

type Drag =
  | { kind: 'point'; tool: LineTool; pointIndex: number }
  | { kind: 'body'; tool: LineTool; start: LogicalPoint; original: LogicalPoint[] };

interface Creation {
  tool: LineTool;
  down: PixelPoint;
  moved: boolean;
}

export type DrawingCursor = 'crosshair' | 'pointer' | 'move' | 'grabbing';

/**
 * Owns the drawings of the current symbol: creation, selection, editing, anchor resolution
 * (locally or through the server pointset, spec §9.2) and persistence (spec §7.2).
 */
export class DrawingManager {
  private tools: LineTool[] = [];
  private symbol: string;
  private activeTool: ActiveTool = 'cursor';
  private selected: LineTool | null = null;
  private creation: Creation | null = null;
  private drag: Drag | null = null;
  private dragDown: PixelPoint | null = null;
  private magnetEnabled = false;
  private magnetMode = MagnetMode.Weak;
  private keepDrawing = false;
  private hidden = false;
  private locked = false;
  private generation = 0;
  private pointsetCounter = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> = Promise.resolve();
  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly host: DrawingHost,
    private readonly storage: DrawingStorage,
    private readonly saveDelayMs = 300,
  ) {
    this.symbol = host.series.getTicker();
    this.loading = this.load(this.symbol);
  }

  // --- state accessors ----------------------------------------------------------------------

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(level = InvalidationLevel.Light): void {
    this.listeners.forEach((l) => l());
    this.host.invalidate(level);
  }

  all(): readonly LineTool[] {
    return this.tools;
  }

  getActiveTool(): ActiveTool {
    return this.activeTool;
  }

  getSelected(): LineTool | null {
    return this.selected;
  }

  isHidden(): boolean {
    return this.hidden;
  }

  isLocked(): boolean {
    return this.locked;
  }

  isKeepDrawing(): boolean {
    return this.keepDrawing;
  }

  magnet(): { enabled: boolean; mode: MagnetMode } {
    return { enabled: this.magnetEnabled, mode: this.magnetMode };
  }

  /** Settles once the drawings for the current symbol have been read from storage. */
  ready(): Promise<void> {
    return this.loading;
  }

  /** The drawing currently being placed, if any. */
  creatingTool(): LineTool | null {
    return this.creation?.tool ?? null;
  }

  isDragging(tool: LineTool): boolean {
    return this.drag?.tool === tool;
  }

  // --- toolbar commands ---------------------------------------------------------------------

  setActiveTool(tool: ActiveTool): void {
    this.cancelCreation();
    this.activeTool = tool;
    if (tool !== 'cursor') this.selected = null;
    this.changed();
  }

  /** Cycles off → weak → strong → off, like the toolbar magnet button. */
  cycleMagnet(): void {
    if (!this.magnetEnabled) {
      this.magnetEnabled = true;
      this.magnetMode = MagnetMode.Weak;
    } else if (this.magnetMode === MagnetMode.Weak) {
      this.magnetMode = MagnetMode.Strong;
    } else {
      this.magnetEnabled = false;
    }
    this.changed(InvalidationLevel.Cursor);
  }

  setMagnet(enabled: boolean, mode = this.magnetMode): void {
    this.magnetEnabled = enabled;
    this.magnetMode = mode;
    this.changed(InvalidationLevel.Cursor);
  }

  toggleKeepDrawing(): void {
    this.keepDrawing = !this.keepDrawing;
    this.changed(InvalidationLevel.Cursor);
  }

  toggleHidden(): void {
    this.hidden = !this.hidden;
    if (this.hidden) {
      this.cancelCreation();
      this.selected = null;
    }
    this.changed();
  }

  toggleLocked(): void {
    this.locked = !this.locked;
    this.changed(InvalidationLevel.Cursor);
  }

  removeAll(): void {
    this.cancelCreation();
    this.tools = [];
    this.selected = null;
    this.scheduleSave();
    this.changed();
  }

  removeSelected(): boolean {
    if (!this.selected) return false;
    this.tools = this.tools.filter((t) => t !== this.selected);
    this.selected = null;
    this.scheduleSave();
    this.changed();
    return true;
  }

  updateSelectedProperties(props: Partial<LineToolProperties>): void {
    if (!this.selected) return;
    this.selected.props = { ...this.selected.props, ...props };
    this.scheduleSave();
    this.changed();
  }

  /** Esc: cancel the drawing in progress, otherwise drop the selection. */
  cancel(): boolean {
    if (this.creation) {
      this.cancelCreation();
      this.changed();
      return true;
    }
    if (this.selected) {
      this.selected = null;
      this.changed();
      return true;
    }
    if (this.activeTool !== 'cursor') {
      this.setActiveTool('cursor');
      return true;
    }
    return false;
  }

  private cancelCreation(): void {
    this.creation = null;
  }

  // --- symbol / series lifecycle ------------------------------------------------------------

  /** Called before the main series switches symbol: persist the old set, load the new one. */
  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return;
    this.flushSave();
    this.cancelCreation();
    this.drag = null;
    this.selected = null;
    this.symbol = symbol;
    this.tools = [];
    this.loading = this.load(symbol);
    this.changed();
  }

  /** Called whenever the series data was replaced (new turnaround): re-resolve every anchor. */
  onSeriesReset(): void {
    this.generation++;
    for (const tool of this.tools) tool.logical = tool.points.map(() => null);
    this.resolvePending();
  }

  private async load(symbol: string): Promise<void> {
    const dtos = await this.storage.load(symbol);
    if (symbol !== this.symbol) return;
    this.tools = dtos.map(LineTool.fromDTO).filter((t): t is LineTool => t !== null && t.symbol === symbol);
    this.resolvePending();
    this.changed();
  }

  /** Resolves anchors from loaded bars when possible; the rest go to the server as one pointset. */
  private resolvePending(): void {
    const { series } = this.host;
    const symbolId = series.getSymbolId();
    if (series.data.isEmpty() || symbolId === null) return;
    const resolution = series.getResolution();
    const pending: { tool: LineTool; k: number }[] = [];
    for (const tool of this.tools) {
      tool.points.forEach((point, k) => {
        if (tool.logical[k] !== null) return;
        const row = point.interval === resolution ? series.data.findByTime(point.time_t) : null;
        if (row) tool.logical[k] = { index: row.index + point.offset, price: point.price };
        else pending.push({ tool, k });
      });
    }
    if (pending.length === 0) {
      this.host.invalidate(InvalidationLevel.Light);
      return;
    }
    const generation = this.generation;
    const points: PointsetPoint[] = pending.map(({ tool, k }) => [tool.points[k].time_t, tool.points[k].offset, tool.points[k].interval]);
    this.host.session.createPointset(`pointset_${++this.pointsetCounter}`, symbolId, resolution, points, (event) => {
      if (event.kind !== 'data' || generation !== this.generation) return;
      for (const row of event.rows) {
        const target = pending[row.index];
        if (target) target.tool.logical[target.k] = { index: row.value[0], price: target.tool.points[target.k].price };
      }
      this.host.invalidate(InvalidationLevel.Light);
    });
  }

  // --- coordinate conversion ----------------------------------------------------------------

  toPixel(point: LogicalPoint): PixelPoint {
    return { x: this.host.timeScale.indexToCoordinate(point.index), y: this.host.mainPriceScale().priceToCoordinate(point.price) };
  }

  /** Pixel → bar index + price, with the magnet applied when enabled. */
  toLogical(x: number, y: number, useMagnet = true): LogicalPoint {
    const index = this.host.timeScale.coordinateToIndex(x);
    const scale = this.host.mainPriceScale();
    let price = scale.coordinateToPrice(y);
    if (useMagnet && this.magnetEnabled) price = this.snapToBar(index, y, price);
    return { index, price };
  }

  private snapToBar(index: number, y: number, price: number): number {
    const row = this.host.series.data.valueAt(index);
    if (!row) return price;
    const scale = this.host.mainPriceScale();
    let best = price;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const column of [SeriesPlotIndex.Open, SeriesPlotIndex.High, SeriesPlotIndex.Low, SeriesPlotIndex.Close]) {
      const candidate = row.value[column];
      const d = Math.abs(scale.priceToCoordinate(candidate) - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    return this.magnetMode === MagnetMode.Strong || bestDistance <= WEAK_MAGNET_PX ? best : price;
  }

  /** Inverse of anchor resolution: the nearest real bar's time plus a bar offset (spec §7.2). */
  toDrawingPoint(point: LogicalPoint): DrawingPoint {
    const { data } = this.host.series;
    const interval = this.host.series.getResolution();
    const first = data.first();
    const last = data.last();
    if (!first || !last) throw new Error('Cannot place a drawing point without series data');
    let row = data.search(point.index)!;
    if (point.index > last.index) row = last;
    else if (point.index < first.index) row = first;
    return { time_t: row.value[SeriesPlotIndex.Time], offset: point.index - row.index, price: point.price, interval };
  }

  renderContext(tool: LineTool, ctx: CanvasRenderingContext2D): ToolRenderContext | null {
    const geometry = this.geometry(tool);
    return geometry ? { ...geometry, ctx } : null;
  }

  /** Screen placement of a drawing, or null while an anchor is unresolved. */
  geometry(tool: LineTool): ToolGeometry | null {
    if (!tool.isResolved()) return null;
    const logical = tool.resolvedPoints();
    const scale = this.host.mainPriceScale();
    if (!scale.hasRange()) return null;
    return {
      width: this.host.timeScale.getWidth(),
      height: scale.getHeight(),
      logical,
      points: logical.map((p) => this.toPixel(p)),
      props: tool.props,
      priceToY: (price) => scale.priceToCoordinate(price),
      formatPrice: (price) => scale.formatPrice(price),
    };
  }

  /** Visible drawings in z-order. */
  visibleTools(): LineTool[] {
    if (this.hidden) return [];
    return [...this.tools].sort((a, b) => a.zorder - b.zorder);
  }

  /** Pixel positions of the draggable anchors. */
  handlePositions(tool: LineTool): PixelPoint[] {
    const geometry = this.geometry(tool);
    if (!geometry) return [];
    return tool.definition.handles?.(geometry) ?? geometry.points;
  }

  private hitTest(x: number, y: number): LineTool | null {
    const tools = this.visibleTools();
    for (let k = tools.length - 1; k >= 0; k--) {
      const geometry = this.geometry(tools[k]);
      if (geometry && tools[k].definition.hitTest(geometry, x, y, HIT_TOLERANCE_PX)) return tools[k];
    }
    return null;
  }

  private handleAt(tool: LineTool, x: number, y: number): number {
    return this.handlePositions(tool).findIndex((h) => distance(h, { x, y }) <= HANDLE_HIT_PX);
  }

  cursorAt(x: number, y: number): DrawingCursor {
    if (this.drag) return 'grabbing';
    if (this.activeTool !== 'cursor' || this.hidden) return 'crosshair';
    if (this.selected && this.handleAt(this.selected, x, y) >= 0) return 'pointer';
    return this.hitTest(x, y) ? (this.locked ? 'pointer' : 'move') : 'crosshair';
  }

  // --- pointer handling ---------------------------------------------------------------------

  /** Returns true when the drawing layer consumed the press (no chart scroll should start). */
  pointerDown(x: number, y: number): boolean {
    if (this.hidden) return false;
    if (this.activeTool !== 'cursor') {
      if (this.host.series.data.isEmpty()) return true;
      this.placePoint(x, y);
      return true;
    }
    if (this.selected && !this.locked) {
      const handle = this.handleAt(this.selected, x, y);
      if (handle >= 0) {
        this.drag = { kind: 'point', tool: this.selected, pointIndex: handle };
        this.dragDown = { x, y };
        this.changed(InvalidationLevel.Light);
        return true;
      }
    }
    const hit = this.hitTest(x, y);
    if (!hit) {
      if (this.selected) {
        this.selected = null;
        this.changed();
      }
      return false;
    }
    this.selected = hit;
    if (!this.locked) {
      this.drag = { kind: 'body', tool: hit, start: this.toLogical(x, y, false), original: hit.resolvedPoints().map((p) => ({ ...p })) };
      this.dragDown = { x, y };
    }
    this.changed();
    return true;
  }

  private placePoint(x: number, y: number): void {
    const point = this.toLogical(x, y);
    if (!this.creation) {
      const tool = new LineTool(this.activeTool as LineToolType, undefined, this.symbol);
      const count = tool.definition.pointCount;
      tool.logical = count === 1 ? [point] : [point, { ...point }];
      this.creation = { tool, down: { x, y }, moved: false };
      if (count === 1) this.finishCreation();
      else this.changed(InvalidationLevel.Cursor);
      return;
    }
    const { tool } = this.creation;
    tool.logical[tool.logical.length - 1] = point;
    this.creation.down = { x, y };
    this.creation.moved = false;
    if (tool.logical.length >= tool.definition.pointCount) this.finishCreation();
    else {
      tool.logical.push({ ...point });
      this.changed(InvalidationLevel.Cursor);
    }
  }

  private finishCreation(): void {
    const creation = this.creation;
    if (!creation) return;
    const { tool } = creation;
    tool.points = tool.resolvedPoints().map((p) => this.toDrawingPoint(p));
    tool.zorder = this.tools.reduce((z, t) => Math.max(z, t.zorder), tool.zorder - 1) + 1;
    this.tools.push(tool);
    this.creation = null;
    this.selected = tool;
    if (!this.keepDrawing) this.activeTool = 'cursor';
    this.scheduleSave();
    this.changed();
  }

  /** Returns true when the move belongs to the drawing layer (preview or drag). */
  pointerMove(x: number, y: number): boolean {
    if (this.creation) {
      const { tool, down } = this.creation;
      if (distance(down, { x, y }) > DRAG_THRESHOLD_PX) this.creation.moved = true;
      tool.logical[tool.logical.length - 1] = this.toLogical(x, y);
      this.host.invalidate(InvalidationLevel.Cursor);
      return true;
    }
    if (!this.drag) return false;
    if (this.dragDown && distance(this.dragDown, { x, y }) <= DRAG_THRESHOLD_PX) return true;
    this.dragDown = null;
    const { drag } = this;
    if (drag.kind === 'point') {
      drag.tool.logical[drag.pointIndex] = this.toLogical(x, y);
    } else {
      const now = this.toLogical(x, y, false);
      const dIndex = now.index - drag.start.index;
      const dPrice = now.price - drag.start.price;
      drag.tool.logical = drag.original.map((p) => ({ index: p.index + dIndex, price: p.price + dPrice }));
    }
    this.host.invalidate(InvalidationLevel.Cursor);
    return true;
  }

  pointerUp(x: number, y: number): boolean {
    if (this.creation) {
      // Press-drag-release places the next anchor at the release point.
      if (this.creation.moved) this.placePoint(x, y);
      return true;
    }
    if (!this.drag) return false;
    const { tool } = this.drag;
    const moved = this.dragDown === null;
    this.drag = null;
    this.dragDown = null;
    if (moved) {
      tool.points = tool.resolvedPoints().map((p) => this.toDrawingPoint(p));
      this.scheduleSave();
    }
    this.changed();
    return true;
  }

  // --- persistence --------------------------------------------------------------------------

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    if (this.saveDelayMs <= 0) {
      void this.storage.save(this.symbol, this.tools.map((t) => t.toDTO()));
      return;
    }
    this.saveTimer = setTimeout(() => this.flushSave(), this.saveDelayMs);
  }

  private flushSave(): void {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.storage.save(this.symbol, this.tools.map((t) => t.toDTO()));
  }
}
