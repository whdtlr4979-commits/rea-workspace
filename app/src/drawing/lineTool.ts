import { DEFAULT_PROPERTIES, toolDefinition, type ToolDefinition } from './tools';
import type { DrawingPoint, LineToolDTO, LineToolProperties, LineToolType, LogicalPoint } from './types';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomId(length: number): string {
  let id = '';
  for (let i = 0; i < length; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return id;
}

/** Drawings sit below zero in z-order, under the series (spec §7.2 `"zorder": -5000`). */
export const BASE_ZORDER = -5000;

/** One drawing. `points` are what gets stored; `logical` is their resolution on the current series. */
export class LineTool {
  readonly definition: ToolDefinition;
  points: DrawingPoint[];
  logical: (LogicalPoint | null)[];
  props: LineToolProperties;

  constructor(
    readonly type: LineToolType,
    readonly id = randomId(6),
    readonly symbol = '',
    points: DrawingPoint[] = [],
    props: Partial<LineToolProperties> = {},
    public zorder = BASE_ZORDER,
    readonly linkKey = randomId(12),
  ) {
    this.definition = toolDefinition(type);
    this.points = points;
    this.logical = points.map(() => null);
    this.props = { ...DEFAULT_PROPERTIES, ...this.definition.defaults, ...props };
  }

  isResolved(): boolean {
    return this.logical.length > 0 && this.logical.every((p) => p !== null);
  }

  resolvedPoints(): LogicalPoint[] {
    return this.logical.filter((p): p is LogicalPoint => p !== null);
  }

  toDTO(): LineToolDTO {
    const interval = this.points[0]?.interval ?? '';
    return {
      id: this.id,
      symbol: this.symbol,
      ownerSource: '_seriesId',
      state: {
        type: this.type,
        id: this.id,
        state: { ...this.props, symbol: this.symbol, interval, visible: true, frozen: false, title: '' },
        points: this.points.map((p) => ({ ...p })),
        zorder: this.zorder,
        ownerSource: '_seriesId',
        linkKey: this.linkKey,
        sharingMode: 0,
      },
    };
  }

  static fromDTO(dto: LineToolDTO): LineTool | null {
    try {
      const { type, state, points, zorder, linkKey } = dto.state;
      const props: Partial<LineToolProperties> = {
        linecolor: state.linecolor,
        linewidth: state.linewidth,
        linestyle: state.linestyle,
        extendLeft: state.extendLeft,
        extendRight: state.extendRight,
        fillBackground: state.fillBackground,
        backgroundColor: state.backgroundColor,
        showPriceLabels: state.showPriceLabels,
      };
      const definedProps = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
      return new LineTool(type, dto.id, dto.symbol, points, definedProps, zorder, linkKey);
    } catch {
      return null;
    }
  }
}
