import { ChartStyle, PriceScaleMode, type Resolution } from '../core/types';
import type { ChartModel } from '../model/chartModel';
import { STUDY_META } from '../model/studyMeta';
import { MOCK_SYMBOLS } from '../server/feed';

const INTERVALS: { value: Resolution; label: string }[] = [
  { value: '1', label: '1m' },
  { value: '5', label: '5m' },
  { value: '15', label: '15m' },
  { value: '60', label: '1h' },
  { value: '240', label: '4h' },
  { value: 'D', label: 'D' },
  { value: 'W', label: 'W' },
];

const STYLES: { value: ChartStyle; label: string }[] = [
  { value: ChartStyle.Candle, label: 'Candles' },
  { value: ChartStyle.HollowCandle, label: 'Hollow candles' },
  { value: ChartStyle.Bar, label: 'Bars' },
  { value: ChartStyle.Line, label: 'Line' },
  { value: ChartStyle.Area, label: 'Area' },
  { value: ChartStyle.HeikinAshi, label: 'Heikin Ashi' },
];

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tool-button';
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function separator(): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'tool-separator';
  return d;
}

/** Header toolbar (spec §3.2): symbol, interval, chart style and indicators. */
export function buildHeader(root: HTMLElement, model: ChartModel): void {
  const symbol = document.createElement('select');
  symbol.className = 'tool-select symbol-select';
  symbol.title = 'Symbol';
  for (const s of MOCK_SYMBOLS) symbol.add(new Option(s.ticker, s.ticker));
  symbol.value = model.series.getTicker();
  symbol.addEventListener('change', () => model.setTicker(symbol.value));

  const intervalButtons = INTERVALS.map((i) => {
    const b = button(i.label, `Interval ${i.label}`, () => {
      model.setResolution(i.value);
      intervalButtons.forEach((x) => x.classList.toggle('active', x === b));
    });
    b.classList.toggle('active', i.value === model.series.getResolution());
    return b;
  });

  const style = document.createElement('select');
  style.className = 'tool-select';
  style.title = 'Chart style';
  for (const s of STYLES) style.add(new Option(s.label, String(s.value)));
  style.value = String(model.series.getStyle());
  style.addEventListener('change', () => model.setStyle(Number(style.value) as ChartStyle));

  const indicators = document.createElement('select');
  indicators.className = 'tool-select';
  indicators.title = 'Add indicator';
  indicators.add(new Option('Indicators +', ''));
  for (const meta of Object.values(STUDY_META)) indicators.add(new Option(meta.description, meta.id));
  indicators.addEventListener('change', () => {
    if (indicators.value) model.addStudy(indicators.value);
    indicators.value = '';
  });

  root.append(symbol, separator(), ...intervalButtons, separator(), style, separator(), indicators);
}

/** Bottom bar (spec §3.2): go to realtime, UTC clock and price scale modes. */
export function buildFooter(root: HTMLElement, model: ChartModel): void {
  const realtime = button('⇥ Realtime', 'Scroll to the latest bar', () => model.scrollToRealtime());
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const clock = document.createElement('span');
  clock.className = 'clock';
  const tick = () => {
    clock.textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
  };
  tick();
  setInterval(tick, 1000);

  const modes: { mode: PriceScaleMode; label: string; title: string }[] = [
    { mode: PriceScaleMode.Normal, label: 'auto', title: 'Normal price scale' },
    { mode: PriceScaleMode.Percentage, label: '%', title: 'Percentage scale' },
    { mode: PriceScaleMode.IndexedTo100, label: '100', title: 'Indexed to 100' },
    { mode: PriceScaleMode.Log, label: 'log', title: 'Logarithmic scale' },
  ];
  const modeButtons = modes.map((m) => {
    const b = button(m.label, m.title, () => {
      model.setPriceScaleMode(m.mode);
      modeButtons.forEach((x) => x.classList.toggle('active', x === b));
    });
    b.classList.toggle('active', m.mode === PriceScaleMode.Normal);
    return b;
  });
  root.append(realtime, spacer, clock, separator(), ...modeButtons);
}
