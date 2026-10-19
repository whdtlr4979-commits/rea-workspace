/**
 * A canvas whose bitmap tracks its CSS size times the device pixel ratio (spec §5.1).
 * Drawing code uses CSS-pixel ("media") coordinates; `crisp` snaps 1px lines to device pixels.
 */
export class CanvasBinding {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private cssWidth = 0;
  private cssHeight = 0;
  private ratio = 1;

  constructor(parent: HTMLElement, className: string) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = className;
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not available');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    const ratio = window.devicePixelRatio || 1;
    if (width === this.cssWidth && height === this.cssHeight && ratio === this.ratio) return;
    this.cssWidth = width;
    this.cssHeight = height;
    this.ratio = ratio;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
  }

  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  get pixelRatio(): number {
    return this.ratio;
  }

  /** Clears the bitmap and returns a context scaled to CSS pixels. */
  begin(background?: string): CanvasRenderingContext2D {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    return ctx;
  }

  crisp(value: number): number {
    return (Math.round(value * this.ratio) + 0.5) / this.ratio;
  }

  destroy(): void {
    this.canvas.remove();
  }
}
