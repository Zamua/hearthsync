import { describe, it, expect } from 'vitest';
import { sha256, sha256Hex, toHex } from '../src/sha256.js';
import { makeRng } from '../src/rng.js';

describe('sha256', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with Web Crypto on random inputs of every padding length', async () => {
    const rng = makeRng(7);
    for (let n = 0; n < 200; n++) {
      const bytes = Uint8Array.from({ length: n }, () => rng.int(0, 255));
      const ref = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      expect(toHex(sha256(bytes))).toBe(toHex(ref));
    }
  });
});
