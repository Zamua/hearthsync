// The account code: the account room's UUIDv4, as 25 Crockford base32 symbols (a 3-bit format number, then the 122
// random bits) and 2 Reed-Solomon check symbols over GF(32). The code has distance 3, so any one or two wrong symbols
// (a typo, a swap) are detected; nothing is ever corrected, since correcting would turn a swap into another valid code.

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA = 25, FORMAT = 0;
export const CODE_LENGTH = DATA + 2;

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A room id: a canonical lowercase UUIDv4. */
export const isRoomId = (s: unknown): s is string => typeof s === 'string' && ROOM_ID.test(s);

// GF(32) from x^5 + x^2 + 1 (primitive).
const EXP: number[] = [], LOG: number[] = [];
for (let i = 0, x = 1; i < 31; i++) {
  EXP[i] = EXP[i + 31] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 32) x ^= 0b100101;
}
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

/** The two check symbols: the remainder of data(x) * x^2 by g(x) = (x + 1)(x + a) = x^2 + 3x + 2. */
export function checkSymbols(data: readonly number[]): [number, number] {
  let r0 = 0, r1 = 0;
  for (const s of data) {
    const f = s ^ r0;
    r0 = r1 ^ mul(f, 3);
    r1 = mul(f, 2);
  }
  return [r0, r1];
}

// Bits 48-51 (version) and 64-65 (variant) of a UUIDv4 are fixed.
const fixed = (i: number): boolean => (i >= 48 && i < 52) || i === 64 || i === 65;

export function codeFromRoom(room: string): string {
  if (!isRoomId(room)) throw new Error(`not a UUIDv4 room id: ${room}`);
  const hex = room.replace(/-/g, ''), bits: number[] = [];
  for (let b = 2; b >= 0; b--) bits.push((FORMAT >> b) & 1);
  for (let i = 0; i < 128; i++) if (!fixed(i)) bits.push((parseInt(hex[i >> 2]!, 16) >> (3 - (i & 3))) & 1);
  const data = Array.from({ length: DATA }, (_, k) => bits.slice(k * 5, k * 5 + 5).reduce((a, x) => a * 2 + x, 0));
  return [...data, ...checkSymbols(data)].map(x => ALPHABET[x]).join('');
}

/** Groups of 4 for reading aloud and typing. */
export const formatCode = (code: string): string => code.match(/.{1,4}/g)?.join(' ') ?? '';

/**
 * A code as QR text: `<prefix><format>:<code>`, never a URL (an installed web app never opens from a link, and a URL
 * lands in the browser's history).
 */
export const qrText = (code: string, qrPrefix: string): string => `${qrPrefix.toUpperCase()}1:${code}`;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What was typed, pasted or scanned, upper case, with the QR prefix, spaces and dashes taken out. */
export function codeSymbols(text: string, qrPrefix = ''): string {
  const s = text.toUpperCase();
  return (qrPrefix ? s.replace(new RegExp(`^\\s*${escape(qrPrefix.toUpperCase())}\\d*:`), '') : s).replace(/[\s-]/g, '');
}

export type CodeError = 'symbol' | 'length' | 'check' | 'format';

const ALIAS: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' };

/** Whatever was typed, pasted or scanned: the room id and the canonical code, or why it is not one. */
export function parseCode(text: string, qrPrefix = ''): { room: string; code: string } | { error: CodeError } {
  const syms: number[] = [];
  for (const c of codeSymbols(text, qrPrefix)) {
    const i = ALPHABET.indexOf(ALIAS[c] ?? c);
    if (i === -1) return { error: 'symbol' };
    syms.push(i);
  }
  if (syms.length !== CODE_LENGTH) return { error: 'length' };
  const data = syms.slice(0, DATA), [a, b] = checkSymbols(data);
  if (a !== syms[DATA] || b !== syms[DATA + 1]) return { error: 'check' };
  const bits = data.flatMap(x => [4, 3, 2, 1, 0].map(k => (x >> k) & 1));
  if (bits[0]! * 4 + bits[1]! * 2 + bits[2]! !== FORMAT) return { error: 'format' };
  const out: number[] = [];
  for (let i = 0, j = 3; i < 128; i++) out.push(i >= 48 && i < 52 ? (0b0100 >> (51 - i)) & 1 : i === 64 ? 1 : i === 65 ? 0 : bits[j++]!);
  const hex = Array.from({ length: 32 }, (_, k) => (out[k * 4]! * 8 + out[k * 4 + 1]! * 4 + out[k * 4 + 2]! * 2 + out[k * 4 + 3]!).toString(16)).join('');
  const room = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { room, code: syms.map(x => ALPHABET[x]).join('') };
}
