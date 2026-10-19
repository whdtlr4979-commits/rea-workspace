import type { BarIndex, Resolution, UTCTimestamp } from '../core/types';

/** Line tool type names follow the saved DTOs in spec §7.2 (`"type": "LineToolRay"`). */
export type LineToolType =
  | 'LineToolTrendLine'
  | 'LineToolRay'
  | 'LineToolHorzLine'
  | 'LineToolHorzRay'
  | 'LineToolVertLine'
  | 'LineToolRectangle'
  | 'LineToolFibRetracement'
  | 'LineToolParallelChannel';

/**
 * A stored anchor (spec §7.2/§9.2): the open time of a real bar, a bar offset from it (for
 * points beyond the data) and the interval the point was placed on.
 */
export interface DrawingPoint {
  time_t: UTCTimestamp;
  offset: number;
  price: number;
  interval: Resolution;
}

/** An anchor resolved against the current series. */
export interface LogicalPoint {
  index: BarIndex;
  price: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export enum LineStyle {
  Solid = 0,
  Dotted = 1,
  Dashed = 2,
}

/** Subset of the per-tool `state` fields seen in spec §7.2. */
export interface LineToolProperties {
  linecolor: string;
  linewidth: number;
  linestyle: LineStyle;
  extendLeft: boolean;
  extendRight: boolean;
  fillBackground: boolean;
  backgroundColor: string;
  showPriceLabels: boolean;
}

/** Spec §4.5: `WeakMagnet = 0`, `StrongMagnet = 1`. */
export enum MagnetMode {
  Weak = 0,
  Strong = 1,
}

/** Drawing DTO as stored by charts-storage (spec §7.2), reduced to the fields this app uses. */
export interface LineToolDTO {
  id: string;
  symbol: string;
  ownerSource: string;
  state: {
    type: LineToolType;
    id: string;
    state: LineToolProperties & { symbol: string; interval: Resolution; visible: boolean; frozen: boolean; title: string };
    points: DrawingPoint[];
    zorder: number;
    ownerSource: string;
    linkKey: string;
    sharingMode: number;
  };
}

export interface DrawingStoragePayload {
  sources: Record<string, LineToolDTO>;
  drawing_groups: Record<string, never>;
}
