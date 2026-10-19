import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, heartbeat, isHeartbeat } from '../src/protocol/framing';
import { decodeSymbol, encodeSymbol } from '../src/protocol/symbol';

describe('framing', () => {
  it('round-trips several messages in one frame', () => {
    const bodies = ['{"m":"a","p":[]}', '~h~3', '{"m":"b","p":["x~m~y"]}'];
    const frame = encodeFrame(bodies);
    expect(frame.startsWith('~m~16~m~')).toBe(true);
    expect(decodeFrame(frame)).toEqual(bodies);
  });

  it('counts length in UTF-16 code units, matching the JS client', () => {
    const body = '{"d":"한글"}';
    expect(decodeFrame(encodeFrame([body]))).toEqual([body]);
  });

  it('rejects truncated frames', () => {
    expect(() => decodeFrame('~m~10~m~short')).toThrow(/truncated/);
    expect(() => decodeFrame('garbage')).toThrow(/missing length/);
  });

  it('recognises heartbeats', () => {
    expect(isHeartbeat(heartbeat(7))).toBe(true);
    expect(isHeartbeat('{"m":"x"}')).toBe(false);
  });
});

describe('extended symbol encoding', () => {
  it('sorts keys recursively and prefixes "="', () => {
    const encoded = encodeSymbol({ symbol: { symbol: 'MOCK:AAPL', adjustment: 'splits' }, type: 'BarSetHeikenAshi', inputs: {} });
    expect(encoded).toBe('={"inputs":{},"symbol":{"adjustment":"splits","symbol":"MOCK:AAPL"},"type":"BarSetHeikenAshi"}');
    expect(decodeSymbol(encoded).type).toBe('BarSetHeikenAshi');
  });

  it('passes plain tickers through', () => {
    expect(encodeSymbol('MOCK:AAPL')).toBe('MOCK:AAPL');
    expect(decodeSymbol('MOCK:AAPL')).toEqual({ symbol: 'MOCK:AAPL' });
  });
});
