import { InvalidationLevel, SeriesPlotIndex } from '../core/types';
import type { ChartModel, Pane } from '../model/chartModel';
import { CanvasBinding } from './canvas';
import { drawAxisLabel, drawGrid, drawHorizontalDashed, drawSeries, drawStudy, drawVerticalDashed } from './renderers';
import { THEME } from './theme';

const CROSSHAIR_DASH = [4, 4];
const LAST_PRICE_DASH = [1, 2];

/**
 * One pane plus its right price axis. Each surface has a main canvas (data) and a top canvas
 * (crosshair), so cursor moves only repaint the top layer (spec §5.1–5.2).
 */
export class PaneWidget {
  readonly element: HTMLDivElement;
  readonly axisElement: HTMLDivElement;
  readonly legendElement: HTMLDivElement;
  private readonly main: CanvasBinding;
  private readonly top: CanvasBinding;
  private readonly axisMain: CanvasBinding;
  private readonly axisTop: CanvasBinding;

  constructor(
    readonly pane: Pane,
    private readonly model: ChartModel,
    container: HTMLElement,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'pane-cell';
    this.axisElement = document.createElement('div');
    this.axisElement.className = 'price-axis-cell';
    this.main = new CanvasBinding(this.element, 'layer');
    this.top = new CanvasBinding(this.element, 'layer');
    this.axisMain = new CanvasBinding(this.axisElement, 'layer');
    this.axisTop = new CanvasBinding(this.axisElement, 'layer');
    this.legendElement = document.createElement('div');
    this.legendElement.className = 'legend';
    this.element.appendChild(this.legendElement);
    container.append(this.element, this.axisElement);
  }

  setGeometry(top: number, width: number, height: number, axisWidth: number): void {
    Object.assign(this.element.style, { top: `${top}px`, left: '0px', width: `${width}px`, height: `${height}px` });
    Object.assign(this.axisElement.style, { top: `${top}px`, left: `${width}px`, width: `${axisWidth}px`, height: `${height}px` });
    this.main.resize(width, height);
    this.top.resize(width, height);
    this.axisMain.resize(axisWidth, height);
    this.axisTop.resize(axisWidth, height);
    this.pane.height = height;
    for (const scale of this.pane.allScales()) scale.setHeight(height);
  }

  paint(level: InvalidationLevel, timeMarkXs: number[]): void {
    if (level === InvalidationLevel.None) return;
    if (level > InvalidationLevel.Cursor) {
      this.paintMain(timeMarkXs);
      this.paintAxis();
    }
    this.paintTop();
  }

  private paintMain(timeMarkXs: number[]): void {
    const { timeScale, series } = this.model;
    const ps = this.pane.priceScale;
    this.main.begin(THEME.background);
    drawGrid(this.main, ps.marks().map((m) => m.coordinate), timeMarkXs);
    const { from, to } = timeScale.visibleBars();
    for (const study of this.pane.studies) {
      if (this.pane.overlayScales.has(study.id)) drawStudy(this.main, study, study.data.range(from - 1, to + 1), timeScale, this.pane.scaleFor(study));
    }
    if (this.pane.isMain) {
      drawSeries(this.main, series.data.range(from - 1, to + 1), timeScale, ps, series.getStyle());
      const last = series.data.last();
      if (last && ps.hasRange()) {
        const color = last.value[SeriesPlotIndex.Close] >= last.value[SeriesPlotIndex.Open] ? THEME.up : THEME.down;
        drawHorizontalDashed(this.main, ps.priceToCoordinate(last.value[SeriesPlotIndex.Close]), color, LAST_PRICE_DASH);
      }
    }
    for (const study of this.pane.studies) {
      if (!this.pane.overlayScales.has(study.id)) drawStudy(this.main, study, study.data.range(from - 1, to + 1), timeScale, ps);
    }
  }

  private paintAxis(): void {
    const ps = this.pane.priceScale;
    const ctx = this.axisMain.begin(THEME.background);
    ctx.fillStyle = THEME.border;
    ctx.fillRect(0, 0, 1, this.axisMain.height);
    ctx.font = THEME.font;
    ctx.fillStyle = THEME.axisText;
    ctx.textBaseline = 'middle';
    for (const mark of ps.marks()) {
      if (mark.coordinate < 8 || mark.coordinate > this.axisMain.height - 8) continue;
      ctx.fillText(mark.label, 8, mark.coordinate);
    }
    if (!ps.hasRange()) return;
    for (const study of this.pane.studies) {
      if (this.pane.overlayScales.has(study.id)) continue;
      const last = study.data.last();
      if (!last) continue;
      study.meta.plots.forEach((plot, k) => {
        const v = last.value[k + 1];
        if (plot.kind !== 'line' || !plot.visible || v === undefined || Number.isNaN(v)) return;
        drawAxisLabel(ctx, v.toFixed(study.meta.precision), 1, ps.priceToCoordinate(v), this.axisMain.width - 1, plot.color);
      });
    }
    // The series' last price goes on top of indicator labels.
    const last = this.pane.isMain ? this.model.series.data.last() : null;
    if (last) {
      const close = last.value[SeriesPlotIndex.Close];
      const color = close >= last.value[SeriesPlotIndex.Open] ? THEME.up : THEME.down;
      drawAxisLabel(ctx, ps.formatLabel(close), 1, ps.priceToCoordinate(close), this.axisMain.width - 1, color);
    }
  }

  /** Width the price axis needs for its widest label (marks, last values, crosshair). */
  requiredAxisWidth(): number {
    const ps = this.pane.priceScale;
    const labels = ps.marks().map((m) => m.label);
    const last = this.pane.isMain ? this.model.series.data.last() : null;
    if (last && ps.hasRange()) labels.push(ps.formatLabel(last.value[SeriesPlotIndex.High]));
    for (const study of this.pane.studies) {
      const row = study.data.last();
      if (row && !this.pane.overlayScales.has(study.id)) row.value.slice(1).forEach((v) => Number.isFinite(v) && labels.push(v.toFixed(study.meta.precision)));
    }
    const { ctx } = this.axisMain;
    ctx.save();
    ctx.font = THEME.font;
    const widest = labels.reduce((w, label) => Math.max(w, ctx.measureText(label).width), 0);
    ctx.restore();
    return Math.ceil(widest) + 16;
  }

  private paintTop(): void {
    this.top.begin();
    const axis = this.axisTop.begin();
    const { crosshair } = this.model;
    if (!crosshair.visible) return;
    drawVerticalDashed(this.top, crosshair.x, THEME.crosshair, CROSSHAIR_DASH);
    if (crosshair.pane !== this.pane) return;
    drawHorizontalDashed(this.top, crosshair.y, THEME.crosshair, CROSSHAIR_DASH);
    const ps = this.pane.priceScale;
    if (ps.hasRange()) drawAxisLabel(axis, ps.formatLabel(ps.coordinateToPrice(crosshair.y)), 1, crosshair.y, this.axisTop.width - 1, THEME.crosshairLabel);
  }

  destroy(): void {
    this.element.remove();
    this.axisElement.remove();
  }
}
