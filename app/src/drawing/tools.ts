import { distanceToSegment, extendSegment, lineYAt, pointInRect } from './geometry';
import { LineStyle, type LineToolProperties, type LineToolType, type LogicalPoint, type PixelPoint } from './types';

/** Where a drawing sits on screen; enough for hit testing. */
export interface ToolGeometry {
  width: number;
  height: number;
  /** Anchors in pane pixels, in the order they were placed. */
  points: PixelPoint[];
  logical: LogicalPoint[];
  props: LineToolProperties;
  priceToY(price: number): number;
  formatPrice(price: number): string;
}

export interface ToolRenderContext extends ToolGeometry {
  ctx: CanvasRenderingContext2D;
}

export interface ToolDefinition {
  type: LineToolType;
  title: string;
  /** Alt+<key> shortcut. */
  shortcut?: string;
  pointCount: number;
  defaults: Partial<LineToolProperties>;
  draw(rc: ToolRenderContext): void;
  /** True when (x, y) lies within `tolerance` px of the drawn shape. */
  hitTest(geometry: ToolGeometry, x: number, y: number, tolerance: number): boolean;
  /** Pixel positions of the draggable anchors; defaults to `points`. */
  handles?(geometry: ToolGeometry): PixelPoint[];
}

export const DEFAULT_PROPERTIES: LineToolProperties = {
  linecolor: '#2962FF',
  linewidth: 2,
  linestyle: LineStyle.Solid,
  extendLeft: false,
  extendRight: false,
  fillBackground: false,
  backgroundColor: 'rgba(41, 98, 255, 0.15)',
  showPriceLabels: false,
};

/** Spec-style Fibonacci retracement levels with their usual colours. */
export const FIB_LEVELS: { level: number; color: string }[] = [
  { level: 0, color: '#787B86' },
  { level: 0.236, color: '#F23645' },
  { level: 0.382, color: '#FF9800' },
  { level: 0.5, color: '#4CAF50' },
  { level: 0.618, color: '#089981' },
  { level: 0.786, color: '#00BCD4' },
  { level: 1, color: '#787B86' },
];

function applyStroke(ctx: CanvasRenderingContext2D, props: LineToolProperties, color = props.linecolor): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = props.linewidth;
  ctx.lineCap = 'round';
  const unit = Math.max(1, props.linewidth);
  ctx.setLineDash(props.linestyle === LineStyle.Dotted ? [unit, unit * 2] : props.linestyle === LineStyle.Dashed ? [unit * 4, unit * 3] : []);
}

function strokeLine(ctx: CanvasRenderingContext2D, a: PixelPoint, b: PixelPoint): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function priceLabel(rc: ToolRenderContext, price: number, x: number, y: number, color: string, align: CanvasTextAlign = 'right'): void {
  const { ctx } = rc;
  ctx.save();
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'bottom';
  ctx.fillText(rc.formatPrice(price), x, y - 3);
  ctx.restore();
}

function segmentTool(type: LineToolType, title: string, shortcut: string | undefined, defaults: Partial<LineToolProperties>): ToolDefinition {
  const ends = (rc: ToolGeometry) => extendSegment(rc.points[0], rc.points[1], rc.props.extendLeft, rc.props.extendRight, rc.width, rc.height);
  return {
    type,
    title,
    shortcut,
    pointCount: 2,
    defaults,
    draw(rc) {
      const [a, b] = ends(rc);
      rc.ctx.save();
      applyStroke(rc.ctx, rc.props);
      strokeLine(rc.ctx, a, b);
      rc.ctx.restore();
    },
    hitTest(rc, x, y, tolerance) {
      const [a, b] = ends(rc);
      return distanceToSegment({ x, y }, a, b) <= tolerance;
    },
  };
}

const TREND_LINE = segmentTool('LineToolTrendLine', 'Trend line', 't', {});
const RAY = segmentTool('LineToolRay', 'Ray', undefined, { extendRight: true });

const HORZ_LINE: ToolDefinition = {
  type: 'LineToolHorzLine',
  title: 'Horizontal line',
  shortcut: 'h',
  pointCount: 1,
  defaults: { showPriceLabels: true },
  draw(rc) {
    const y = rc.points[0].y;
    rc.ctx.save();
    applyStroke(rc.ctx, rc.props);
    strokeLine(rc.ctx, { x: 0, y }, { x: rc.width, y });
    rc.ctx.restore();
    if (rc.props.showPriceLabels) priceLabel(rc, rc.logical[0].price, rc.width - 4, y, rc.props.linecolor);
  },
  hitTest(rc, _x, y, tolerance) {
    return Math.abs(y - rc.points[0].y) <= tolerance;
  },
};

const HORZ_RAY: ToolDefinition = {
  type: 'LineToolHorzRay',
  title: 'Horizontal ray',
  shortcut: 'j',
  pointCount: 1,
  defaults: { showPriceLabels: true },
  draw(rc) {
    const { x, y } = rc.points[0];
    rc.ctx.save();
    applyStroke(rc.ctx, rc.props);
    strokeLine(rc.ctx, { x, y }, { x: rc.width, y });
    rc.ctx.restore();
    if (rc.props.showPriceLabels) priceLabel(rc, rc.logical[0].price, x + 4, y, rc.props.linecolor, 'left');
  },
  hitTest(rc, x, y, tolerance) {
    return x >= rc.points[0].x - tolerance && Math.abs(y - rc.points[0].y) <= tolerance;
  },
};

const VERT_LINE: ToolDefinition = {
  type: 'LineToolVertLine',
  title: 'Vertical line',
  shortcut: 'v',
  pointCount: 1,
  defaults: {},
  draw(rc) {
    const x = rc.points[0].x;
    rc.ctx.save();
    applyStroke(rc.ctx, rc.props);
    strokeLine(rc.ctx, { x, y: 0 }, { x, y: rc.height });
    rc.ctx.restore();
  },
  hitTest(rc, x, _y, tolerance) {
    return Math.abs(x - rc.points[0].x) <= tolerance;
  },
};

const RECTANGLE: ToolDefinition = {
  type: 'LineToolRectangle',
  title: 'Rectangle',
  pointCount: 2,
  defaults: { fillBackground: true, linewidth: 1 },
  draw(rc) {
    const [a, b] = rc.points;
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    rc.ctx.save();
    if (rc.props.fillBackground) {
      rc.ctx.fillStyle = rc.props.backgroundColor;
      rc.ctx.fillRect(left, top, w, h);
    }
    applyStroke(rc.ctx, rc.props);
    rc.ctx.strokeRect(left, top, w, h);
    rc.ctx.restore();
  },
  hitTest(rc, x, y, tolerance) {
    const [a, b] = rc.points;
    if (rc.props.fillBackground && pointInRect({ x, y }, a, b)) return true;
    const corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    return corners.some((c, k) => distanceToSegment({ x, y }, c, corners[(k + 1) % 4]) <= tolerance);
  },
  handles(rc) {
    const [a, b] = rc.points;
    return [a, b];
  },
};

/** Level 0 sits on the second anchor and level 1 on the first, as when dragging from a swing low to a high. */
function fibPrice(logical: LogicalPoint[], level: number): number {
  return logical[1].price + (logical[0].price - logical[1].price) * level;
}

const FIB_RETRACEMENT: ToolDefinition = {
  type: 'LineToolFibRetracement',
  title: 'Fib retracement',
  shortcut: 'f',
  pointCount: 2,
  defaults: { linewidth: 1, linestyle: LineStyle.Dashed, linecolor: '#787B86' },
  draw(rc) {
    const [a, b] = rc.points;
    const left = Math.min(a.x, b.x);
    const right = rc.props.extendRight ? rc.width : Math.max(a.x, b.x);
    const { ctx } = rc;
    ctx.save();
    for (let k = 0; k < FIB_LEVELS.length - 1; k++) {
      const y0 = rc.priceToY(fibPrice(rc.logical, FIB_LEVELS[k].level));
      const y1 = rc.priceToY(fibPrice(rc.logical, FIB_LEVELS[k + 1].level));
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = FIB_LEVELS[k + 1].color;
      ctx.fillRect(left, Math.min(y0, y1), right - left, Math.abs(y1 - y0));
    }
    ctx.globalAlpha = 1;
    for (const { level, color } of FIB_LEVELS) {
      const price = fibPrice(rc.logical, level);
      const y = rc.priceToY(price);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      strokeLine(ctx, { x: left, y }, { x: right, y });
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${level} (${rc.formatPrice(price)})`, left - 4, y);
    }
    applyStroke(ctx, rc.props);
    strokeLine(ctx, a, b);
    ctx.restore();
  },
  hitTest(rc, x, y, tolerance) {
    const [a, b] = rc.points;
    const left = Math.min(a.x, b.x) - tolerance;
    const right = (rc.props.extendRight ? rc.width : Math.max(a.x, b.x)) + tolerance;
    if (x < left || x > right) return distanceToSegment({ x, y }, a, b) <= tolerance;
    return FIB_LEVELS.some(({ level }) => Math.abs(rc.priceToY(fibPrice(rc.logical, level)) - y) <= tolerance) || distanceToSegment({ x, y }, a, b) <= tolerance;
  },
};

/** The third anchor sets the channel width: the second line runs parallel to a–b through it. */
function channelLines(rc: ToolGeometry): { a: PixelPoint; b: PixelPoint; c: PixelPoint; d: PixelPoint } {
  const [a, b, p] = rc.points;
  const dy = p ? p.y - lineYAt(a, b, p.x) : 0;
  return { a, b, c: { x: a.x, y: a.y + dy }, d: { x: b.x, y: b.y + dy } };
}

const PARALLEL_CHANNEL: ToolDefinition = {
  type: 'LineToolParallelChannel',
  title: 'Parallel channel',
  pointCount: 3,
  defaults: { fillBackground: true },
  draw(rc) {
    const { ctx } = rc;
    const { a, b, c, d } = channelLines(rc);
    ctx.save();
    if (rc.points.length >= 3 && rc.props.fillBackground) {
      ctx.fillStyle = rc.props.backgroundColor;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(d.x, d.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.fill();
    }
    applyStroke(ctx, rc.props);
    strokeLine(ctx, a, b);
    if (rc.points.length >= 3) {
      strokeLine(ctx, c, d);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      strokeLine(ctx, { x: a.x, y: (a.y + c.y) / 2 }, { x: b.x, y: (b.y + d.y) / 2 });
    }
    ctx.restore();
  },
  hitTest(rc, x, y, tolerance) {
    const { a, b, c, d } = channelLines(rc);
    const p = { x, y };
    if (distanceToSegment(p, a, b) <= tolerance || distanceToSegment(p, c, d) <= tolerance) return true;
    if (!rc.props.fillBackground || x < Math.min(a.x, b.x) || x > Math.max(a.x, b.x)) return false;
    const top = lineYAt(a, b, x);
    const bottom = lineYAt(c, d, x);
    return y >= Math.min(top, bottom) && y <= Math.max(top, bottom);
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [TREND_LINE, RAY, HORZ_LINE, HORZ_RAY, VERT_LINE, PARALLEL_CHANNEL, FIB_RETRACEMENT, RECTANGLE];

export function toolDefinition(type: LineToolType): ToolDefinition {
  const def = TOOL_DEFINITIONS.find((d) => d.type === type);
  if (!def) throw new Error(`Unknown line tool ${type}`);
  return def;
}
