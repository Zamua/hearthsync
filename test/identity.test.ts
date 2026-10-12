import { describe, it, expect } from 'vitest';
import { nameTag, publicId, resolveForward, tagOf } from '../src/identity.js';

const A = '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b';

describe('what others see', () => {
  it('pins the public id per salt: a change would split every account from what it wrote into shared rooms', () => {
    expect(publicId(A, 'notes/public/')).toBe('2db3a75f88f972d0');
    expect(publicId('00000000-0000-4000-8000-000000000000', 'notes/public/')).toBe('99ea0d35b52c6179');
    expect(publicId(A, 'todo/public/')).not.toBe(publicId(A, 'notes/public/'));
  });

  it('shows a name with four hex digits of the public id, never the code', () => {
    expect(tagOf('d1858d7bd161d486')).toBe('D185');
    expect(nameTag('Robin', publicId(A, 'notes/public/'))).toBe('Robin #2DB3');
  });
});

describe('following forwards', () => {
  const map = (m: Record<string, string | null>) => (r: string) => (r in m ? m[r] : undefined);

  it('follows a chain to the room with no forward', () => {
    expect(resolveForward('b', map({ b: 'a', a: 'c', c: null }))).toEqual({ room: 'c' });
    expect(resolveForward('a', map({ a: null }))).toEqual({ room: 'a' });
  });

  it('asks for the first room it has not read', () => {
    expect(resolveForward('b', map({ b: 'a' }))).toEqual({ need: 'a' });
  });

  it('settles a cycle on its smallest room, from anywhere that leads into it', () => {
    const m = map({ x: 'c', c: 'b', b: 'c' });
    expect(resolveForward('c', m)).toEqual({ room: 'b' });
    expect(resolveForward('b', m)).toEqual({ room: 'b' });
    expect(resolveForward('x', m)).toEqual({ room: 'b' });
    expect(resolveForward('s', map({ s: 's' }))).toEqual({ room: 's' });
  });
});
