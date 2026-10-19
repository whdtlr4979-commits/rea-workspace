import { formatResolution, SeriesPlotIndex, type PlotRow } from '../core/types';
import type { ChartModel, Pane } from '../model/chartModel';
import type { StudySource } from '../model/study';
import { inputsSummary } from '../model/studyMeta';
import { THEME } from './theme';

export interface LegendActions {
  editStudy(study: StudySource): void;
  removeStudy(study: StudySource): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * DOM legend in the top-left of each pane (spec §3.2): symbol, interval and OHLC for the main
 * pane, one row per indicator with settings and remove buttons.
 */
export class Legend {
  private readonly rows = new Map<StudySource, { root: HTMLDivElement; values: HTMLSpanElement; args: HTMLSpanElement; status: HTMLSpanElement }>();
  private seriesTitle: HTMLSpanElement | null = null;
  private seriesValues: HTMLSpanElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly pane: Pane,
    private readonly model: ChartModel,
    private readonly actions: LegendActions,
  ) {
    if (pane.isMain) {
      const line = el('div', 'legend-row legend-series');
      this.seriesTitle = el('span', 'legend-title');
      this.seriesValues = el('span', 'legend-values');
      line.append(this.seriesTitle, this.seriesValues);
      root.appendChild(line);
    }
  }

  update(): void {
    const hovered = this.model.crosshair.visible ? this.model.crosshair.index : null;
    if (this.seriesTitle && this.seriesValues) this.updateSeries(hovered);
    this.syncStudyRows();
    for (const [study, row] of this.rows) {
      row.args.textContent = inputsSummary(study.meta, study.getInputs());
      row.status.textContent = study.getStatus() === 'loading' || study.getStatus() === 'creating' ? '⋯' : study.getStatus() === 'error' ? `⚠ ${study.getError()}` : '';
      const data = hovered === null ? study.data.last() : study.data.valueAt(hovered);
      row.values.replaceChildren(...this.studyValues(study, data));
    }
  }

  private updateSeries(hovered: number | null): void {
    const { series } = this.model;
    const info = series.getSymbolInfo();
    this.seriesTitle!.textContent = `${info?.description ?? series.getTicker()} · ${formatResolution(series.getResolution())}${series.getStatus() === 'loading' ? ' ⋯' : ''}`;
    const row = hovered === null ? series.data.last() : series.data.valueAt(hovered);
    if (!row) {
      this.seriesValues!.replaceChildren();
      return;
    }
    const scale = this.pane.priceScale;
    const [, open, high, low, close] = row.value;
    const previous = series.data.valueAt(row.index - 1);
    const reference = previous ? previous.value[SeriesPlotIndex.Close] : open;
    const change = close - reference;
    const color = close >= open ? THEME.up : THEME.down;
    const parts: HTMLSpanElement[] = [];
    for (const [label, value] of [['O', open], ['H', high], ['L', low], ['C', close]] as const) {
      const span = el('span', 'legend-value');
      span.append(label, el('b', '', scale.formatPrice(value)));
      (span.lastChild as HTMLElement).style.color = color;
      parts.push(span);
    }
    const delta = el('span', 'legend-value', `${change >= 0 ? '+' : ''}${scale.formatPrice(change)} (${change >= 0 ? '+' : ''}${((change / reference) * 100).toFixed(2)}%)`);
    delta.style.color = color;
    parts.push(delta);
    this.seriesValues!.replaceChildren(...parts);
  }

  private studyValues(study: StudySource, row: PlotRow | null): HTMLSpanElement[] {
    if (!row) return [];
    const colorer = study.meta.plots.findIndex((p) => p.kind === 'colorer');
    return study.meta.plots.flatMap((plot, k) => {
      if (plot.kind === 'colorer' || !plot.visible) return [];
      const v = row.value[k + 1];
      const span = el('span', 'legend-value', v === undefined || Number.isNaN(v) ? 'n/a' : formatValue(v, study.meta.precision));
      span.style.color = plot.kind === 'histogram' && colorer >= 0 ? (row.value[colorer + 1] === 1 ? THEME.up : THEME.down) : plot.color;
      return [span];
    });
  }

  private syncStudyRows(): void {
    for (const [study, row] of this.rows) {
      if (!this.pane.studies.includes(study)) {
        row.root.remove();
        this.rows.delete(study);
      }
    }
    for (const study of this.pane.studies) {
      if (this.rows.has(study)) continue;
      const root = el('div', 'legend-row legend-study');
      const name = el('span', 'legend-title', study.meta.shortName);
      const args = el('span', 'legend-args');
      const values = el('span', 'legend-values');
      const status = el('span', 'legend-status');
      const edit = el('button', 'legend-button', '⚙');
      edit.title = 'Settings';
      edit.addEventListener('click', () => this.actions.editStudy(study));
      const remove = el('button', 'legend-button', '✕');
      remove.title = 'Remove';
      remove.addEventListener('click', () => this.actions.removeStudy(study));
      root.append(name, args, values, status, edit, remove);
      this.root.appendChild(root);
      this.rows.set(study, { root, values, args, status });
    }
  }
}

function formatValue(value: number, precision: number): string {
  if (precision === 0 && Math.abs(value) >= 1000) {
    const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [size, suffix] of units) if (Math.abs(value) >= size) return `${(value / size).toFixed(2)} ${suffix}`;
  }
  return value.toFixed(precision);
}
