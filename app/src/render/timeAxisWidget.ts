import { InvalidationLevel, isIntraday, SeriesPlotIndex } from '../core/types';
import type { ChartModel } from '../model/chartModel';
import { formatCrosshairTime, selectTimeMarks, type TimeMark } from '../model/timeMarks';
import { CanvasBinding } from './canvas';
import { drawAxisLabel } from './renderers';
import { THEME } from './theme';

const MIN_LABEL_SPACING_PX = 72;

export class TimeAxisWidget {
  readonly element: HTMLDivElement;
  private readonly main: CanvasBinding;
  private readonly top: CanvasBinding;
  private marks: TimeMark[] = [];

  constructor(
    private readonly model: ChartModel,
    container: HTMLElement,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'time-axis-cell';
    this.main = new CanvasBinding(this.element, 'layer');
    this.top = new CanvasBinding(this.element, 'layer');
    container.appendChild(this.element);
  }

  setGeometry(top: number, width: number, height: number): void {
    Object.assign(this.element.style, { top: `${top}px`, left: '0px', width: `${width}px`, height: `${height}px` });
    this.main.resize(width, height);
    this.top.resize(width, height);
  }

  /** Recomputes label positions; panes reuse them for vertical grid lines. */
  updateMarks(): number[] {
    const { timeScale, series } = this.model;
    const { from, to } = timeScale.visibleBars();
    const rows = series.data.range(from - 1, to);
    const bars: { index: number; time: number; previousTime: number | null }[] = rows
      .slice(1)
      .map((row, k) => ({ index: row.index, time: row.value[SeriesPlotIndex.Time], previousTime: rows[k].value[SeriesPlotIndex.Time] }));
    if (rows.length > 0 && rows[0].index >= from) {
      bars.unshift({ index: rows[0].index, time: rows[0].value[SeriesPlotIndex.Time], previousTime: null });
    }
    this.marks = selectTimeMarks(bars, (i) => timeScale.indexToCoordinate(i), MIN_LABEL_SPACING_PX).filter((m) => {
      const x = timeScale.indexToCoordinate(m.index);
      return x >= 0 && x <= timeScale.getWidth();
    });
    return this.marks.map((m) => timeScale.indexToCoordinate(m.index));
  }

  paint(level: InvalidationLevel): void {
    if (level > InvalidationLevel.Cursor) {
      const ctx = this.main.begin(THEME.background);
      ctx.fillStyle = THEME.border;
      ctx.fillRect(0, 0, this.main.width, 1);
      ctx.font = THEME.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const mark of this.marks) {
        ctx.fillStyle = mark.weight >= 60 ? THEME.text : THEME.axisText;
        ctx.fillText(mark.label, this.model.timeScale.indexToCoordinate(mark.index), this.main.height / 2);
      }
    }
    const ctx = this.top.begin();
    const { crosshair, series, timeScale } = this.model;
    if (!crosshair.visible) return;
    const row = series.data.valueAt(crosshair.index);
    if (!row) return;
    const label = formatCrosshairTime(row.value[SeriesPlotIndex.Time], isIntraday(series.getResolution()));
    drawAxisLabel(ctx, label, timeScale.indexToCoordinate(crosshair.index), this.top.height / 2, 0, THEME.crosshairLabel, '#ffffff', 'center');
  }
}
