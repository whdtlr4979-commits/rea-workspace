import type { DrawingStoragePayload, LineToolDTO } from './types';

/**
 * Per-symbol drawing persistence. Drawings live apart from the layout, keyed by symbol, as in
 * spec §7.2 (charts-storage); this app keeps them in the browser instead of a server.
 */
export interface DrawingStorage {
  load(symbol: string): Promise<LineToolDTO[]>;
  save(symbol: string, drawings: LineToolDTO[]): Promise<void>;
}

const KEY_PREFIX = 'chart-mvp:drawings:';

export class LocalDrawingStorage implements DrawingStorage {
  async load(symbol: string): Promise<LineToolDTO[]> {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + symbol);
      if (!raw) return [];
      const payload = JSON.parse(raw) as DrawingStoragePayload;
      return Object.values(payload.sources ?? {});
    } catch {
      return [];
    }
  }

  async save(symbol: string, drawings: LineToolDTO[]): Promise<void> {
    const payload: DrawingStoragePayload = { sources: Object.fromEntries(drawings.map((d) => [d.id, d])), drawing_groups: {} };
    try {
      if (drawings.length === 0) localStorage.removeItem(KEY_PREFIX + symbol);
      else localStorage.setItem(KEY_PREFIX + symbol, JSON.stringify(payload));
    } catch {
      // Storage can be unavailable (private mode, quota); drawings then last for the session only.
    }
  }
}

export class MemoryDrawingStorage implements DrawingStorage {
  readonly data = new Map<string, LineToolDTO[]>();

  async load(symbol: string): Promise<LineToolDTO[]> {
    return structuredClone(this.data.get(symbol) ?? []);
  }

  async save(symbol: string, drawings: LineToolDTO[]): Promise<void> {
    this.data.set(symbol, structuredClone(drawings));
  }
}
