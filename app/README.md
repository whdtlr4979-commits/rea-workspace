# Chart MVP

A Canvas 2D charting engine built from [`specs/charting.md`](../specs/charting.md). TypeScript + Vite, no UI framework.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # vitest
npm run typecheck
npm run build
```

## Structure

The layers follow the spec's split: the server computes, the client renders.

| Path | Role | Spec |
|---|---|---|
| `src/protocol/` | `~m~` framing, `{m,p}` messages, extended symbol encoding | §6.1, §6.5 |
| `src/server/` | In-process mock data server: random-walk OHLCV feed, Heikin Ashi, indicator math (SMA, EMA, RSI, Volume), sessions, turnaround, realtime ticks | §6, §8.1 |
| `src/api/chartApi.ts` | Client side of the connection: heartbeat echo, routing messages to series and studies | §6.2–6.4 |
| `src/model/` | `PlotList`, `TimeScale`, `PriceScale`, main series, study source, panes, chart model | §4 |
| `src/render/` | Two canvases per surface (data + crosshair), RAF batching by `InvalidationLevel`, renderers, legend | §5 |
| `src/drawing/` | Line tools: geometry, tool definitions, `DrawingManager` (creation, selection, editing, magnet, anchor resolution, persistence) | §9, §7.2 |
| `src/ui/` | Header, footer, drawing toolbar, floating style toolbar, indicator settings dialog | §3 |

The mock server talks to the client through `FrameConnection` (string frames). Swapping in a real WebSocket backend only means providing another `FrameConnection`.

## Supported features

- Chart styles: Candles, Hollow candles, Bars, Line, Area, Heikin Ashi (computed server-side)
- Intervals: 1m, 5m, 15m, 1h, 4h, D, W
- Time axis: wheel zoom (`spacing + delta × spacing / 10`), drag scroll, time-axis drag to change spacing, double-click reset, automatic history loading on scroll and zoom-out, go to realtime (1000 ms easeInOutQuint)
- Price axis: auto-scale (10%/8% margins), Normal / Percentage / IndexedTo100 / Log, drag scaling, double-click reset
- Indicators: Volume (overlay scale in the main pane), SMA, EMA (price overlays), RSI (separate pane, 70/50/30 bands). Settings changes go through `modify_study`; removal waits for `study_deleted`
- Crosshair, OHLC legend, last-price line and label, live ticks (1 s period)
- Drawing tools: trend line, ray, horizontal line and ray, vertical line, parallel channel, Fib retracement, rectangle
  - Place by clicking each anchor or by press-drag-release; Alt+T/H/J/V/F shortcuts, Esc cancels, Delete removes
  - Select to show handles; drag a handle to move one anchor, drag the body to move the whole drawing
  - Floating toolbar for colour, width, line style, extend left/right and delete
  - Magnet (weak snaps within 20 px, strong always snaps to OHLC), keep drawing, lock, hide, remove all
  - Anchors are stored as bar time + bar offset + price + interval (spec §7.2). On another interval they are resolved through the server's `create_pointset` (spec §9.2)
  - Saved per symbol in `localStorage` in the charts-storage DTO shape

## Not yet implemented

Multi-chart layouts, layout save/load, undo/redo, text and annotation tools, symbol search, replay, alerts, compare/overlay symbols, sessions and holidays, timezones other than UTC.
