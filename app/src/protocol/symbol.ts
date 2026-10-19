/**
 * Extended symbol encoding (spec §6.5): `"=" + JSON.stringify(object with sorted keys)`.
 * Plain symbols travel as bare strings.
 */
export interface ExtendedSymbol {
  symbol: string | ExtendedSymbol;
  adjustment?: string;
  /** Synthetic chart style computed on the server, e.g. "BarSetHeikenAshi" (spec §4.2). */
  type?: string;
  inputs?: Record<string, unknown>;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function encodeSymbol(symbol: string | ExtendedSymbol): string {
  return typeof symbol === 'string' ? symbol : `=${JSON.stringify(sortKeys(symbol))}`;
}

export function decodeSymbol(encoded: string): ExtendedSymbol {
  if (!encoded.startsWith('=')) return { symbol: encoded };
  return JSON.parse(encoded.slice(1)) as ExtendedSymbol;
}

/** Innermost ticker of a possibly nested extended symbol. */
export function baseTicker(symbol: ExtendedSymbol): string {
  let current: string | ExtendedSymbol = symbol.symbol;
  while (typeof current !== 'string') current = current.symbol;
  return current;
}
