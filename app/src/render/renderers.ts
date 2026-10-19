import { ChartStyle, SeriesPlotIndex, type PlotRow } from '../core/types';
import type { PriceScale } from '../model/priceScale';
import type { StudySource } from '../model/study';
import type { TimeScale } from '../model/timeScale';
import type { CanvasBinding } from './canvas';
import { THEME } from './theme';

function bodyWidth(barSpacing: number): number {
  return Math.max(1, Math.floor(barSpacing * 0.8));
}

export function drawGrid(binding: CanvasBinding, priceYs: number[], timeXs: number[]): void {
  const { ctx } = binding;
  ctx.save();
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1 / binding.pixelRatio;
  ctx.beginPath();
  for (const y of priceYs) {
    const cy = binding.crisp(y);
    ctx.moveTo(0, cy);
    ctx.lineTo(binding.width, cy);
  }
  for (const x of timeXs) {
    const cx = binding.crisp(x);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, binding.height);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawSeries(binding: CanvasBinding, rows: readonly PlotRow[], ts: TimeScale, ps: PriceScale, style: ChartStyle): void {
  if (rows.length === 0 || !ps.hasRange()) return;
  switch (style) {
    case ChartStyle.Line:
      drawLine(binding, rows, ts, ps, SeriesPlotIndex.Close, THEME.line, 2);
      return;
    case ChartStyle.Area:
      drawArea(binding, rows, ts, ps);
      return;
    case ChartStyle.Bar:
      drawOhlcBars(binding, rows, ts, ps);
      return;
    default:
      drawCandles(binding, rows, ts, ps, style === ChartStyle.HollowCandle);
  }
}

function drawCandles(binding: CanvasBinding, rows: readonly PlotRow[], ts: TimeScale, ps: PriceScale, hollow: boolean): void {
  const { ctx } = binding;
  const spacing = ts.getBarSpacing();
  const width = bodyWidth(spacing);
  const ratio = binding.pixelRatio;
  ctx.save();
  for (const row of rows) {
    const [, open, high, low, close] = row.value;
    if ([open, high, low, close].some(Number.isNaN)) continue;
    const up = close >= open;
    const color = up ? THEME.up : THEME.down;
    const x = ts.indexToCoordinate(row.index);
    const yHigh = ps.priceToCoordinate(high);
    const yLow = ps.priceToCoordinate(low);
    const yOpen = ps.priceToCoordinate(open);
    const yClose = ps.priceToCoordinate(close);
    // Wick, snapped to a device pixel column.
    const wickX = Math.round(x * ratio) / ratio;
    ctx.fillStyle = color;
    ctx.fillRect(wickX - 0.5 / ratio, yHigh, 1 / ratio, Math.max(1 / ratio, yLow - yHigh));
    if (spacing < 2) continue;
    const left = Math.round((x - width / 2) * ratio) / ratio;
    const top = Math.min(yOpen, yClose);
    const height = Math.max(1 / ratio, Math.abs(yClose - yOpen));
    if (hollow && up) {
      ctx.fillStyle = THEME.background;
      ctx.fillRect(left, top, width, height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1 / ratio;
      ctx.strokeRect(left + 0.5 / ratio, top + 0.5 / ratio, width - 1 / ratio, Math.max(0, height - 1 / ratio));
    } else {
      ctx.fillRect(left, top, width, height);
    }
  }
  ctx.restore();
}

function drawOhlcBars(binding: CanvasBinding, rows: readonly PlotRow[], ts: TimeScale, ps: PriceScale): void {
  const { ctx } = binding;
  const half = Math.max(1, Math.floor(ts.getBarSpacing() * 0.35));
  ctx.save();
  ctx.lineWidth = Math.max(1, Math.min(2, ts.getBarSpacing() / 6));
  for (const row of rows) {
    const [, open, high, low, close] = row.value;
    if ([open, high, low, close].some(Number.isNaN)) continue;
    const x = binding.crisp(ts.indexToCoordinate(row.index));
    ctx.strokeStyle = close >= open ? THEME.up : THEME.down;
    ctx.beginPath();
    ctx.moveTo(x, ps.priceToCoordinate(high));
    ctx.lineTo(x, ps.priceToCoordinate(low));
    const yOpen = ps.priceToCoordinate(open);
    const yClose = ps.priceToCoordinate(close);
    ctx.moveTo(x - half, yOpen);
    ctx.lineTo(x, yOpen);
    ctx.moveTo(x, yClose);
    ctx.lineTo(x + half, yClose);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawLine(binding: CanvasBinding, rows: readonly PlotRow[], ts: TimeScale, ps: PriceScale, column: number, color: string, lineWidth: number): void {
  const { ctx } = binding;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let drawing = false;
  for (const row of rows) {
    const v = row.value[column];
    if (v === undefined || Number.isNaN(v)) {
      drawing = false;
      continue;
    }
    const x = ts.indexToCoordinate(row.index);
    const y = ps.priceToCoordinate(v);
    if (drawing) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    drawing = true;
  }
  ctx.stroke();
  ctx.restore();
}

function drawArea(binding: CanvasBinding, rows: readonly PlotRow[], ts: TimeScale, ps: PriceScale): void {
  const { ctx } = binding;
  const points = rows
    .filter((r) => !Number.isNaN(r.value[SeriesPlotIndex.Close]))
    .map((r) => ({ x: ts.indexToCoordinate(r.index), y: ps.priceToCoordinate(r.value[SeriesPlotIndex.Close]) }));
  if (points.length === 0) return;
  ctx.save();
  const gradient = ctx.createLinearGradient(0, 0, 0, binding.height);
  gradient.addColorStop(0, THEME.areaTop);
  gradient.addColorStop(1, THEME.areaBottom);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(points[0].x, binding.height);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, binding.height);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  drawLine(binding, rows, ts, ps, SeriesPlotIndex.Close, THEME.line, 2);
}

function drawHistogram(binding: CanvasBinding, rows: readonly PlotRow[], ts: TimeScale, ps: PriceScale, valueColumn: number, directionColumn: number | null, color: string): void {
  const { ctx } = binding;
  const width = bodyWidth(ts.getBarSpacing());
  const ratio = binding.pixelRatio;
  const base = ps.priceToCoordinate(0);
  ctx.save();
  for (const row of rows) {
    const v = row.value[valueColumn];
    if (v === undefined || Number.isNaN(v)) continue;
    const x = ts.indexToCoordinate(row.index);
    const y = ps.priceToCoordinate(v);
    if (directionColumn !== null) ctx.fillStyle = row.value[directionColumn] === 1 ? THEME.volumeUp : THEME.volumeDown;
    else ctx.fillStyle = color;
    const left = Math.round((x - width / 2) * ratio) / ratio;
    ctx.fillRect(left, Math.min(y, base), width, Math.max(1 / ratio, Math.abs(base - y)));
  }
  ctx.restore();
}

export function drawStudy(binding: CanvasBinding, study: StudySource, rows: readonly PlotRow[], ts: TimeScale, ps: PriceScale): void {
  if (!ps.hasRange()) return;
  const { meta } = study;
  const { ctx } = binding;
  if (meta.bandFill) {
    const top = ps.priceToCoordinate(meta.bandFill.from);
    const bottom = ps.priceToCoordinate(meta.bandFill.to);
    ctx.fillStyle = meta.bandFill.color;
    ctx.fillRect(0, Math.min(top, bottom), binding.width, Math.abs(bottom - top));
  }
  for (const band of meta.bands ?? []) {
    ctx.save();
    ctx.strokeStyle = band.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    const y = binding.crisp(ps.priceToCoordinate(band.value));
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(binding.width, y);
    ctx.stroke();
    ctx.restore();
  }
  const directionColumn = meta.plots.findIndex((p) => p.kind === 'colorer');
  meta.plots.forEach((plot, k) => {
    if (!plot.visible) return;
    const column = k + 1;
    if (plot.kind === 'histogram') drawHistogram(binding, rows, ts, ps, column, directionColumn >= 0 ? directionColumn + 1 : null, plot.color);
    else if (plot.kind === 'line') drawLine(binding, rows, ts, ps, column, plot.color, plot.lineWidth ?? 1);
  });
}

export function drawHorizontalDashed(binding: CanvasBinding, y: number, color: string, dash: number[]): void {
  const { ctx } = binding;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  const cy = binding.crisp(y);
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(binding.width, cy);
  ctx.stroke();
  ctx.restore();
}

export function drawVerticalDashed(binding: CanvasBinding, x: number, color: string, dash: number[]): void {
  const { ctx } = binding;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  const cx = binding.crisp(x);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, binding.height);
  ctx.stroke();
  ctx.restore();
}

/** Filled label box used for the last price and crosshair readouts on the axes. */
export function drawAxisLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, background: string, color = '#ffffff', align: 'left' | 'center' = 'left'): void {
  const height = 18;
  ctx.save();
  ctx.font = THEME.font;
  const textWidth = ctx.measureText(text).width;
  const boxWidth = align === 'center' ? textWidth + 12 : width;
  const left = align === 'center' ? x - boxWidth / 2 : x;
  ctx.fillStyle = background;
  ctx.fillRect(left, y - height / 2, boxWidth, height);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = align === 'center' ? 'center' : 'left';
  ctx.fillText(text, align === 'center' ? x : left + 6, y);
  ctx.restore();
}
