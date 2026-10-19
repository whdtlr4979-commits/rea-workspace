import { InvalidationLevel } from '../core/types';
import type { ChartModel, Pane } from '../model/chartModel';
import { Legend, type LegendActions } from './legend';
import { PaneWidget } from './paneWidget';
import { THEME } from './theme';
import { TimeAxisWidget } from './timeAxisWidget';

const SEPARATOR_PX = 1;

interface PaneEntry {
  widget: PaneWidget;
  legend: Legend;
}

/**
 * DOM/canvas host for a ChartModel. Collects invalidations and repaints once per animation
 * frame at the highest requested level (spec §5.2).
 */
export class ChartWidget {
  private readonly root: HTMLDivElement;
  private readonly panes = new Map<Pane, PaneEntry>();
  private readonly separators: HTMLDivElement[] = [];
  private readonly timeAxis: TimeAxisWidget;
  private readonly corner: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private pending = InvalidationLevel.None;
  private frame = 0;
  private timeMarkXs: number[] = [];
  private axisWidth = THEME.minPriceAxisWidth;
  private drag: { kind: 'pane' | 'price' | 'time' | 'drawing'; pane?: Pane; lastY: number } | null = null;

  constructor(
    container: HTMLElement,
    private readonly model: ChartModel,
    private readonly actions: LegendActions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'chart-widget';
    container.appendChild(this.root);
    this.timeAxis = new TimeAxisWidget(model, this.root);
    this.corner = document.createElement('div');
    this.corner.className = 'axis-corner';
    this.root.appendChild(this.corner);
    this.bindTimeAxis();
    this.syncPanes();
    model.onInvalidate((level) => this.invalidate(level));
    model.onStructureChange(() => {
      this.syncPanes();
      this.layout();
    });
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(container);
    this.layout();
  }

  private syncPanes(): void {
    for (const [pane, entry] of this.panes) {
      if (!this.model.panes.includes(pane)) {
        entry.widget.destroy();
        this.panes.delete(pane);
      }
    }
    for (const pane of this.model.panes) {
      if (this.panes.has(pane)) continue;
      const widget = new PaneWidget(pane, this.model, this.root);
      const legend = new Legend(widget.legendElement, pane, this.model, this.actions);
      this.bindPane(widget);
      this.panes.set(pane, { widget, legend });
    }
  }

  private layout(): void {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width === 0 || height === 0) return;
    const axisWidth = this.axisWidth;
    const paneWidth = Math.max(0, width - axisWidth);
    const panes = this.model.panes;
    const available = height - THEME.timeAxisHeight - SEPARATOR_PX * (panes.length - 1);
    const totalStretch = panes.reduce((s, p) => s + p.stretchFactor, 0);
    this.separators.forEach((s) => s.remove());
    this.separators.length = 0;
    let top = 0;
    panes.forEach((pane, k) => {
      const paneHeight = k === panes.length - 1 ? available - (top - k * SEPARATOR_PX) : Math.round((available * pane.stretchFactor) / totalStretch);
      this.panes.get(pane)!.widget.setGeometry(top, paneWidth, paneHeight, axisWidth);
      top += paneHeight;
      if (k < panes.length - 1) {
        const sep = document.createElement('div');
        sep.className = 'pane-separator';
        Object.assign(sep.style, { top: `${top}px`, width: `${width}px` });
        this.root.appendChild(sep);
        this.separators.push(sep);
        top += SEPARATOR_PX;
      }
    });
    this.timeAxis.setGeometry(top, paneWidth, THEME.timeAxisHeight);
    Object.assign(this.corner.style, { top: `${top}px`, left: `${paneWidth}px`, width: `${axisWidth}px`, height: `${THEME.timeAxisHeight}px` });
    this.model.timeScale.setWidth(paneWidth);
    this.model.updateAutoScale();
    this.model.requestHistoryIfNeeded();
    this.invalidate(InvalidationLevel.Full);
  }

  invalidate(level: InvalidationLevel): void {
    if (level <= this.pending && this.frame !== 0) return;
    this.pending = Math.max(this.pending, level);
    if (this.frame === 0) this.frame = requestAnimationFrame(() => this.paint());
  }

  private paint(): void {
    const level = this.pending;
    this.pending = InvalidationLevel.None;
    this.frame = 0;
    if (level > InvalidationLevel.Cursor) this.timeMarkXs = this.timeAxis.updateMarks();
    for (const { widget, legend } of this.panes.values()) {
      widget.paint(level, this.timeMarkXs);
      legend.update();
    }
    this.timeAxis.paint(level);
    if (level > InvalidationLevel.Cursor) this.fitAxisWidth();
  }

  /** Grows or shrinks the shared price axis column to fit the widest label of any pane. */
  private fitAxisWidth(): void {
    let required = THEME.minPriceAxisWidth;
    for (const { widget } of this.panes.values()) required = Math.max(required, widget.requiredAxisWidth());
    if (required !== this.axisWidth) {
      this.axisWidth = required;
      this.layout();
    }
  }

  private updateCursor(element: HTMLElement, x: number, y: number): void {
    element.style.cursor = this.model.drawings.cursorAt(x, y);
  }

  private localPoint(event: PointerEvent | WheelEvent | MouseEvent, element: HTMLElement): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private bindPane(widget: PaneWidget): void {
    const { element, axisElement, pane } = widget;
    const { drawings } = this.model;
    element.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.legend')) return;
      if (e.button !== 0) return;
      const p = this.localPoint(e, element);
      element.setPointerCapture(e.pointerId);
      // Drawings only live in the main pane; they get the first chance at the press.
      if (pane.isMain && drawings.pointerDown(p.x, p.y)) {
        this.drag = { kind: 'drawing', pane, lastY: p.y };
        this.updateCursor(element, p.x, p.y);
        return;
      }
      this.drag = { kind: 'pane', pane, lastY: p.y };
      this.model.startScroll(p.x);
    });
    element.addEventListener('pointermove', (e) => {
      const p = this.localPoint(e, element);
      if (this.drag?.kind === 'pane') {
        this.model.scrollTo(p.x);
        pane.priceScale.scrollBy(p.y - this.drag.lastY);
        this.drag.lastY = p.y;
      } else if (pane.isMain) {
        drawings.pointerMove(p.x, p.y);
      }
      if (pane.isMain) this.updateCursor(element, p.x, p.y);
      this.model.setCrosshair(p.x, p.y, pane);
    });
    const endDrag = (e: PointerEvent) => {
      if (this.drag?.kind === 'pane') this.model.endScroll();
      if (pane.isMain) {
        const p = this.localPoint(e, element);
        drawings.pointerUp(p.x, p.y);
        this.updateCursor(element, p.x, p.y);
      }
      this.drag = null;
    };
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
    element.addEventListener('pointerleave', () => {
      if (!this.drag) this.model.clearCrosshair();
    });
    element.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.localPoint(e, element);
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          this.model.startScroll(0);
          this.model.scrollTo(-e.deltaX);
          this.model.endScroll();
          return;
        }
        const delta = -Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100);
        this.model.zoom(p.x, delta);
      },
      { passive: false },
    );

    axisElement.addEventListener('pointerdown', (e) => {
      const p = this.localPoint(e, axisElement);
      axisElement.setPointerCapture(e.pointerId);
      this.drag = { kind: 'price', pane, lastY: p.y };
      pane.priceScale.startScale(p.y);
    });
    axisElement.addEventListener('pointermove', (e) => {
      if (this.drag?.kind !== 'price') return;
      pane.priceScale.scaleTo(this.localPoint(e, axisElement).y);
      this.invalidate(InvalidationLevel.Full);
    });
    axisElement.addEventListener('pointerup', () => {
      pane.priceScale.endScale();
      this.drag = null;
    });
    axisElement.addEventListener('dblclick', () => this.model.resetPriceScale(pane));
  }

  private bindTimeAxis(): void {
    const element = this.timeAxis.element;
    element.addEventListener('pointerdown', (e) => {
      element.setPointerCapture(e.pointerId);
      this.drag = { kind: 'time', lastY: 0 };
      this.model.startTimeScale(this.localPoint(e, element).x);
    });
    element.addEventListener('pointermove', (e) => {
      if (this.drag?.kind === 'time') this.model.scaleTimeTo(this.localPoint(e, element).x);
    });
    element.addEventListener('pointerup', () => {
      this.model.endTimeScale();
      this.drag = null;
    });
    element.addEventListener('dblclick', () => this.model.resetTimeScale());
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.root.remove();
  }
}

