import type { StudyInputs, StudyInputValue } from '../protocol/messages';

export interface StudyInputMeta {
  id: string;
  name: string;
  type: StudyInputValue['t'];
  defval: number | string | boolean;
  min?: number;
  max?: number;
  options?: string[];
}

export interface StudyPlotMeta {
  /** Column in the plot row is `position + 1` (column 0 is time), as in spec §8.4. */
  id: string;
  title: string;
  kind: 'line' | 'histogram' | 'colorer';
  color: string;
  lineWidth?: number;
  visible: boolean;
}

export interface StudyBand {
  value: number;
  color: string;
}

export interface StudyMeta {
  id: string;
  /** Name sent in `create_study` (spec §8.2 `<Name>@<package>-<version>`). */
  wireName: string;
  description: string;
  shortName: string;
  /** Price studies overlay the main pane and share its price scale. */
  isPriceStudy: boolean;
  /** Overlay studies with their own scale inside the main pane (e.g. volume at the bottom). */
  overlay?: { margins: { top: number; bottom: number } };
  inputs: StudyInputMeta[];
  plots: StudyPlotMeta[];
  bands?: StudyBand[];
  bandFill?: { from: number; to: number; color: string };
  precision: number;
}

const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'];

export const STUDY_META: Record<string, StudyMeta> = {
  Volume: {
    id: 'Volume',
    wireName: 'Volume@mock-studies-1',
    description: 'Volume',
    shortName: 'Vol',
    isPriceStudy: false,
    overlay: { margins: { top: 0.75, bottom: 0 } },
    inputs: [{ id: 'in_0', name: 'MA Length', type: 'integer', defval: 20, min: 1, max: 500 }],
    plots: [
      { id: 'plot_0', title: 'Volume', kind: 'histogram', color: '#26a69a', visible: true },
      { id: 'plot_1', title: 'Direction', kind: 'colorer', color: '', visible: false },
      { id: 'plot_2', title: 'Volume MA', kind: 'line', color: '#2962FF', lineWidth: 1, visible: false },
    ],
    precision: 0,
  },
  SMA: {
    id: 'SMA',
    wireName: 'SMA@mock-studies-1',
    description: 'Simple moving average',
    shortName: 'SMA',
    isPriceStudy: true,
    inputs: [
      { id: 'in_0', name: 'Length', type: 'integer', defval: 20, min: 1, max: 1000 },
      { id: 'in_1', name: 'Source', type: 'source', defval: 'close', options: SOURCES },
    ],
    plots: [{ id: 'plot_0', title: 'SMA', kind: 'line', color: '#2962FF', lineWidth: 2, visible: true }],
    precision: 2,
  },
  EMA: {
    id: 'EMA',
    wireName: 'EMA@mock-studies-1',
    description: 'Exponential moving average',
    shortName: 'EMA',
    isPriceStudy: true,
    inputs: [
      { id: 'in_0', name: 'Length', type: 'integer', defval: 50, min: 1, max: 1000 },
      { id: 'in_1', name: 'Source', type: 'source', defval: 'close', options: SOURCES },
    ],
    plots: [{ id: 'plot_0', title: 'EMA', kind: 'line', color: '#FF6D00', lineWidth: 2, visible: true }],
    precision: 2,
  },
  RSI: {
    id: 'RSI',
    wireName: 'RSI@mock-studies-1',
    description: 'Relative strength index',
    shortName: 'RSI',
    isPriceStudy: false,
    inputs: [
      { id: 'in_0', name: 'RSI Length', type: 'integer', defval: 14, min: 1, max: 500 },
      { id: 'in_1', name: 'Source', type: 'source', defval: 'close', options: SOURCES },
      { id: 'in_2', name: 'MA Length', type: 'integer', defval: 14, min: 1, max: 500 },
    ],
    plots: [
      { id: 'plot_0', title: 'RSI', kind: 'line', color: '#7E57C2', lineWidth: 2, visible: true },
      { id: 'plot_1', title: 'RSI-based MA', kind: 'line', color: '#F7A600', lineWidth: 1, visible: true },
    ],
    bands: [
      { value: 70, color: '#787B86' },
      { value: 50, color: '#787B8680' },
      { value: 30, color: '#787B86' },
    ],
    bandFill: { from: 70, to: 30, color: 'rgba(126, 87, 194, 0.08)' },
    precision: 2,
  },
};

export function defaultInputs(meta: StudyMeta): StudyInputs {
  const inputs: StudyInputs = {};
  for (const input of meta.inputs) inputs[input.id] = { v: input.defval, t: input.type };
  return inputs;
}

/** Legend argument string, e.g. "14 close 14". */
export function inputsSummary(meta: StudyMeta, inputs: StudyInputs): string {
  return meta.inputs.map((i) => String(inputs[i.id]?.v ?? i.defval)).join(' ');
}
