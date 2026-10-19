import type { PlotRow, Resolution } from '../core/types';

/** Wire message shape shared by both directions (spec §6.1): `{"m": method, "p": params}`. */
export interface WireMessage {
  m: string;
  p: unknown[];
}

/** Values at or above this magnitude mean "no value" on the wire (spec §4.2). */
export const EMPTY_VALUE = 1e100;

export interface WirePlotRow {
  i: number;
  v: number[];
}

export interface SeriesPayload {
  s: WirePlotRow[];
  t: string;
  lbs?: { bar_close_time: number };
}

export interface StudyPayload {
  st: WirePlotRow[];
  t: string;
}

export interface TimescaleChangeset {
  index: number;
  changes: number[];
}

export interface SymbolInfo {
  name: string;
  full_name: string;
  description: string;
  pricescale: number;
  minmov: number;
  timezone: string;
  type: string;
}

export interface StudyInputValue {
  v: number | string | boolean;
  t: 'integer' | 'float' | 'source' | 'bool' | 'text';
}

export type StudyInputs = Record<string, StudyInputValue>;

/** Client → server requests (spec §6.3). Tuples mirror the parameter order on the wire. */
export interface ClientRequests {
  chart_create_session: [session: string, flags: string];
  chart_delete_session: [session: string];
  resolve_symbol: [session: string, symbolId: string, symbol: string];
  create_series: [
    session: string,
    seriesId: string,
    turnaround: string,
    symbolId: string,
    resolution: Resolution,
    barCount: number,
  ];
  modify_series: [
    session: string,
    seriesId: string,
    turnaround: string,
    symbolId: string,
    resolution: Resolution,
  ];
  remove_series: [session: string, seriesId: string];
  request_more_data: [session: string, seriesId: string, count: number];
  create_study: [
    session: string,
    studyId: string,
    turnaround: string,
    parentId: string,
    studyName: string,
    inputs: StudyInputs,
  ];
  modify_study: [session: string, studyId: string, turnaround: string, inputs: StudyInputs];
  remove_study: [session: string, studyId: string];
}

export type ClientMethod = keyof ClientRequests;

export function toWireValue(value: number): number {
  return Number.isFinite(value) ? value : EMPTY_VALUE;
}

export function fromWireRows(rows: WirePlotRow[]): PlotRow[] {
  return rows.map((row) => ({
    index: row.i,
    value: row.v.map((x) => (Math.abs(x) >= EMPTY_VALUE ? Number.NaN : x)),
  }));
}

export function toWireRows(rows: PlotRow[]): WirePlotRow[] {
  return rows.map((row) => ({ i: row.index, v: row.value.map(toWireValue) }));
}
