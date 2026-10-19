/**
 * socket.io-style framing used by the data connection (spec §6.1):
 * every message is `~m~<length>~m~<body>`, several messages may share one frame,
 * heartbeats are `~h~<n>` bodies.
 */
const MARK = '~m~';
const HEARTBEAT = '~h~';

export function encodeFrame(bodies: string[]): string {
  return bodies.map((body) => `${MARK}${body.length}${MARK}${body}`).join('');
}

export function decodeFrame(frame: string): string[] {
  const bodies: string[] = [];
  let rest = frame;
  while (rest.length > 0) {
    if (!rest.startsWith(MARK)) throw new Error('Malformed frame: missing length marker');
    rest = rest.slice(MARK.length);
    const end = rest.indexOf(MARK);
    if (end < 0) throw new Error('Malformed frame: unterminated length');
    const length = Number(rest.slice(0, end));
    if (!Number.isInteger(length) || length < 0) throw new Error('Malformed frame: bad length');
    rest = rest.slice(end + MARK.length);
    if (rest.length < length) throw new Error('Malformed frame: truncated body');
    bodies.push(rest.slice(0, length));
    rest = rest.slice(length);
  }
  return bodies;
}

export function isHeartbeat(body: string): boolean {
  return body.startsWith(HEARTBEAT);
}

export function heartbeat(n: number): string {
  return `${HEARTBEAT}${n}`;
}
