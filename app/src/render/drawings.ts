import type { DrawingManager } from '../drawing/drawingManager';
import type { LineTool } from '../drawing/lineTool';
import type { CanvasBinding } from './canvas';
import { THEME } from './theme';

const HANDLE_RADIUS = 5;

function drawTool(binding: CanvasBinding, manager: DrawingManager, tool: LineTool): void {
  const rc = manager.renderContext(tool, binding.ctx);
  if (!rc) return;
  binding.ctx.save();
  binding.ctx.beginPath();
  binding.ctx.rect(0, 0, binding.width, binding.height);
  binding.ctx.clip();
  tool.definition.draw(rc);
  binding.ctx.restore();
}

function drawHandles(binding: CanvasBinding, manager: DrawingManager, tool: LineTool): void {
  const { ctx } = binding;
  ctx.save();
  for (const h of manager.handlePositions(tool)) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = THEME.background;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = tool.props.linecolor;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Settled drawings go on the main canvas. The drawing being created or dragged and the
 * selection handles go on the top canvas, so editing only repaints the cursor layer (spec §5.3).
 */
export function drawDrawingsMain(binding: CanvasBinding, manager: DrawingManager): void {
  for (const tool of manager.visibleTools()) {
    if (!manager.isDragging(tool)) drawTool(binding, manager, tool);
  }
}

export function drawDrawingsTop(binding: CanvasBinding, manager: DrawingManager, active: LineTool | null): void {
  for (const tool of manager.visibleTools()) {
    if (manager.isDragging(tool)) drawTool(binding, manager, tool);
  }
  if (active) drawTool(binding, manager, active);
  const selected = manager.getSelected();
  if (selected && !manager.isHidden()) drawHandles(binding, manager, selected);
}
