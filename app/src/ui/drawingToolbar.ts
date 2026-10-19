import type { ActiveTool, DrawingManager } from '../drawing/drawingManager';
import { TOOL_DEFINITIONS } from '../drawing/tools';
import { LineStyle, MagnetMode, type LineToolType } from '../drawing/types';

const svg = (body: string) => `<svg viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">${body}</svg>`;

const ICONS: Record<ActiveTool | 'magnet' | 'keep' | 'lock' | 'hide' | 'trash', string> = {
  cursor: svg('<path d="M14 6v16M6 14h16"/>'),
  LineToolTrendLine: svg('<path d="M7 21 21 7"/><circle cx="7" cy="21" r="1.8"/><circle cx="21" cy="7" r="1.8"/>'),
  LineToolRay: svg('<path d="M7 21 24 4"/><circle cx="7" cy="21" r="1.8"/><circle cx="13" cy="15" r="1.8"/>'),
  LineToolHorzLine: svg('<path d="M3 14h22"/><circle cx="14" cy="14" r="1.8"/>'),
  LineToolHorzRay: svg('<path d="M9 14h16"/><circle cx="9" cy="14" r="1.8"/>'),
  LineToolVertLine: svg('<path d="M14 3v22"/><circle cx="14" cy="14" r="1.8"/>'),
  LineToolParallelChannel: svg('<path d="M5 17 19 5M9 23 23 11"/><path d="M7 20 21 8" stroke-dasharray="2 2"/>'),
  LineToolFibRetracement: svg('<path d="M4 6h20M4 11h20M4 15h20M4 22h20"/><path d="M6 22 22 6" stroke-dasharray="2 2"/>'),
  LineToolRectangle: svg('<rect x="6" y="8" width="16" height="12" rx="1"/>'),
  magnet: svg('<path d="M8 6v8a6 6 0 0 0 12 0V6"/><path d="M8 10h4M16 10h4"/>'),
  keep: svg('<path d="M9 20 19 6M17 16l4 4M21 16l-4 4"/>'),
  lock: svg('<rect x="8" y="13" width="12" height="9" rx="1"/><path d="M10 13V10a4 4 0 0 1 8 0v3"/>'),
  hide: svg('<path d="M4 14s4-6 10-6 10 6 10 6-4 6-10 6S4 14 4 14z"/><circle cx="14" cy="14" r="2.5"/>'),
  trash: svg('<path d="M7 9h14M11 9V6h6v3M9 9l1 13h8l1-13"/>'),
};

function iconButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'draw-button';
  b.title = title;
  b.innerHTML = icon;
  b.addEventListener('click', onClick);
  return b;
}

/** Left drawing toolbar (spec §3.2): tools, then magnet, keep drawing, lock, hide and remove. */
export function buildDrawingToolbar(root: HTMLElement, drawings: DrawingManager): void {
  const toolButtons = new Map<ActiveTool, HTMLButtonElement>();
  const addTool = (tool: ActiveTool, title: string) => {
    const b = iconButton(ICONS[tool], title, () => drawings.setActiveTool(drawings.getActiveTool() === tool && tool !== 'cursor' ? 'cursor' : tool));
    toolButtons.set(tool, b);
    root.appendChild(b);
  };
  addTool('cursor', 'Cross');
  for (const def of TOOL_DEFINITIONS) addTool(def.type, def.shortcut ? `${def.title} (Alt+${def.shortcut.toUpperCase()})` : def.title);

  const separator = document.createElement('div');
  separator.className = 'draw-separator';
  root.appendChild(separator);

  const magnet = iconButton(ICONS.magnet, '', () => drawings.cycleMagnet());
  const keep = iconButton(ICONS.keep, 'Keep drawing', () => drawings.toggleKeepDrawing());
  const lock = iconButton(ICONS.lock, 'Lock all drawings', () => drawings.toggleLocked());
  const hide = iconButton(ICONS.hide, 'Hide all drawings', () => drawings.toggleHidden());
  const trash = iconButton(ICONS.trash, 'Remove all drawings', () => {
    if (drawings.all().length > 0 && confirm('Remove all drawings on this symbol?')) drawings.removeAll();
  });
  root.append(magnet, keep, lock, hide, trash);

  const sync = () => {
    for (const [tool, b] of toolButtons) b.classList.toggle('active', drawings.getActiveTool() === tool);
    const { enabled, mode } = drawings.magnet();
    magnet.classList.toggle('active', enabled);
    magnet.classList.toggle('strong', enabled && mode === MagnetMode.Strong);
    magnet.title = !enabled ? 'Magnet: off (click for weak)' : mode === MagnetMode.Weak ? 'Magnet: weak (click for strong)' : 'Magnet: strong (click to turn off)';
    keep.classList.toggle('active', drawings.isKeepDrawing());
    lock.classList.toggle('active', drawings.isLocked());
    hide.classList.toggle('active', drawings.isHidden());
  };
  drawings.onChange(sync);
  sync();
}

const COLORS = ['#2962FF', '#F23645', '#089981', '#FF9800', '#9C27B0', '#131722'];
const WIDTHS = [1, 2, 3, 4];

/** Floating toolbar for the selected drawing: colour, width, line style, extend, delete. */
export function buildFloatingToolbar(host: HTMLElement, drawings: DrawingManager): void {
  const bar = document.createElement('div');
  bar.className = 'floating-toolbar';
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  host.appendChild(bar);

  const render = () => {
    const tool = drawings.getSelected();
    bar.style.display = tool && !drawings.isHidden() ? 'flex' : 'none';
    if (!tool) return;
    bar.replaceChildren();
    for (const color of COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.title = color;
      swatch.style.background = color;
      swatch.classList.toggle('active', tool.props.linecolor === color);
      swatch.addEventListener('click', () => drawings.updateSelectedProperties({ linecolor: color, backgroundColor: withAlpha(color, 0.15) }));
      bar.appendChild(swatch);
    }
    bar.appendChild(divider());
    for (const width of WIDTHS) {
      const b = textButton(`${width}px`, `Line width ${width}`, () => drawings.updateSelectedProperties({ linewidth: width }));
      b.classList.toggle('active', tool.props.linewidth === width);
      bar.appendChild(b);
    }
    bar.appendChild(divider());
    const styles: [LineStyle, string][] = [[LineStyle.Solid, '━'], [LineStyle.Dashed, '╍'], [LineStyle.Dotted, '┅']];
    for (const [style, label] of styles) {
      const b = textButton(label, LineStyle[style], () => drawings.updateSelectedProperties({ linestyle: style }));
      b.classList.toggle('active', tool.props.linestyle === style);
      bar.appendChild(b);
    }
    const extendable: LineToolType[] = ['LineToolTrendLine', 'LineToolRay', 'LineToolFibRetracement'];
    if (extendable.includes(tool.type)) {
      bar.appendChild(divider());
      const right = textButton('→', 'Extend right', () => drawings.updateSelectedProperties({ extendRight: !tool.props.extendRight }));
      right.classList.toggle('active', tool.props.extendRight);
      bar.appendChild(right);
      if (tool.type !== 'LineToolFibRetracement') {
        const left = textButton('←', 'Extend left', () => drawings.updateSelectedProperties({ extendLeft: !tool.props.extendLeft }));
        left.classList.toggle('active', tool.props.extendLeft);
        bar.appendChild(left);
      }
    }
    bar.appendChild(divider());
    bar.appendChild(textButton('🗑', 'Remove (Delete)', () => drawings.removeSelected()));
  };
  drawings.onChange(render);
  render();
}

function textButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'floating-button';
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function divider(): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'floating-divider';
  return d;
}

function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Alt+<letter> picks a tool, Esc cancels, Delete removes the selection. */
export function bindDrawingShortcuts(drawings: DrawingManager): void {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    if (e.key === 'Escape') {
      if (drawings.cancel()) e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (drawings.removeSelected()) e.preventDefault();
      return;
    }
    if (!e.altKey) return;
    const def = TOOL_DEFINITIONS.find((d) => d.shortcut && e.code === `Key${d.shortcut.toUpperCase()}`);
    if (def) {
      e.preventDefault();
      drawings.setActiveTool(def.type);
    }
  });
}
