import { describe, it, expect } from 'vitest';
import { ALPHABET, CODE_LENGTH, checkSymbols, codeFromRoom, codeSymbols, formatCode, isRoomId, parseCode, qrText } from '../src/code.js';
import { makeRng } from '../src/rng.js';
import { randomRoom } from '../src/testing/random.js';

const rooms = (n: number, seed: number) => { const rng = makeRng(seed); return Array.from({ length: n }, () => randomRoom(rng)); };
const roomOf = (text: string, prefix?: string): string | null => { const r = parseCode(text, prefix); return 'room' in r ? r.room : null; };

describe('the account code', () => {
  it('is 27 symbols of the alphabet, and decodes to exactly the room it encodes', () => {
    for (const room of rooms(500, 1)) {
      const code = codeFromRoom(room);
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every(c => ALPHABET.includes(c))).toBe(true);
      expect(parseCode(code)).toEqual({ room, code });
    }
  });

  it('pins known answers: a change in the format would orphan every account', () => {
    expect(codeFromRoom('00000000-0000-4000-8000-000000000000')).toBe('000000000000000000000000000');
    expect(codeFromRoom('ffffffff-ffff-4fff-bfff-ffffffffffff')).toBe('3ZZZZZZZZZZZZZZZZZZZZZZZZXY');
    expect(codeFromRoom('0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b')).toBe(KNOWN);
    expect(parseCode(KNOWN)).toEqual({ room: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b', code: KNOWN });
    expect(formatCode(KNOWN)).toBe(KNOWN.match(/.{1,4}/g)!.join(' '));
    expect(formatCode(KNOWN).split(' ').map(g => g.length)).toEqual([4, 4, 4, 4, 4, 4, 3]);
  });

  it('reads codes as people type them: groups, dashes, lower case, O for 0, I and L for 1', () => {
    for (const room of rooms(50, 2)) {
      const code = codeFromRoom(room);
      expect(roomOf(formatCode(code))).toBe(room);
      expect(roomOf(` ${formatCode(code).toLowerCase().replace(/ /g, '-')} `)).toBe(room);
      expect(roomOf(code.replace(/0/g, 'O').replace(/1/g, 'l'))).toBe(room);
    }
  });

  it("drops the app's QR prefix, in any case and format digit, and only that app's", () => {
    for (const room of rooms(20, 7)) {
      const code = codeFromRoom(room);
      expect(roomOf(qrText(code, 'notes'), 'notes')).toBe(room);
      expect(roomOf(`notes12:${code}`, 'NOTES')).toBe(room);
      expect(roomOf(` NOTES:${formatCode(code)}`, 'Notes')).toBe(room);
      expect(roomOf(qrText(code, 'notes'))).toBeNull();
      expect(roomOf(qrText(code, 'todo'), 'notes')).toBeNull();
    }
    expect(qrText(KNOWN, 'notes')).toBe(`NOTES1:${KNOWN}`);
    expect(codeSymbols(`a.b+1:${KNOWN}`, 'a.b+')).toBe(KNOWN);
    expect(codeSymbols(`aXb+1:${KNOWN}`, 'a.b+')).not.toBe(KNOWN);
  });

  it('catches every single wrong symbol', () => {
    for (const room of rooms(40, 3)) {
      const code = codeFromRoom(room);
      for (let i = 0; i < code.length; i++) for (const c of ALPHABET) {
        if (c === code[i]) continue;
        expect(parseCode(code.slice(0, i) + c + code.slice(i + 1))).toEqual({ error: 'check' });
      }
    }
  });

  it('catches every swap of two different symbols, adjacent or not', () => {
    for (const room of rooms(60, 4)) {
      const code = codeFromRoom(room);
      for (let i = 0; i < code.length; i++) for (let j = i + 1; j < code.length; j++) {
        if (code[i] === code[j]) continue;
        const s = [...code];
        [s[i], s[j]] = [s[j]!, s[i]!];
        expect(parseCode(s.join(''))).toEqual({ error: 'check' });
      }
    }
  });

  it('names what is wrong with anything else', () => {
    const code = codeFromRoom(rooms(1, 5)[0]!);
    expect(parseCode(code.slice(1))).toEqual({ error: 'length' });
    expect(parseCode(code + '0')).toEqual({ error: 'length' });
    expect(parseCode('')).toEqual({ error: 'length' });
    expect(parseCode(code.slice(0, 26) + 'U')).toEqual({ error: 'symbol' });
    expect(parseCode(code.replace(/.$/, '*'))).toEqual({ error: 'symbol' });
    // A future format: valid checks, format bits 001.
    const data = [...code.slice(0, 25)].map(c => ALPHABET.indexOf(c));
    data[0] = (data[0]! & 0b00011) | (1 << 2);
    const future = [...data, ...checkSymbols(data)].map(x => ALPHABET[x]).join('');
    expect(parseCode(future)).toEqual({ error: 'format' });
  });

  it('every codeword sums to zero in GF(32): the check symbols are a Reed-Solomon remainder', () => {
    for (const room of rooms(100, 6)) expect([...codeFromRoom(room)].reduce((a, c) => a ^ ALPHABET.indexOf(c), 0)).toBe(0);
  });

  it('only encodes room ids', () => {
    expect(isRoomId('0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(isRoomId('0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b')).toBe(false);
    expect(isRoomId('0F1E2D3C-4B5A-4978-8A9B-0C1D2E3F4A5B')).toBe(false);
    expect(() => codeFromRoom('local-abc')).toThrow();
  });
});

// Computed independently, by solving c(1) = c(a) = 0 for the two check symbols.
const KNOWN = '07HWB9W9DD9F0N6RC3MQ3YJJVS3';
