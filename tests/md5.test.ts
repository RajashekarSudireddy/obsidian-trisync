import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5Bytes, md5String } from '../src/crypto/md5';

function nodeMd5(input: string | Uint8Array): string {
  return createHash('md5').update(input).digest('hex');
}

describe('Pure-TS RFC 1321 MD5', () => {
  it('matches all official RFC 1321 test vectors', () => {
    const vectors: Array<[string, string]> = [
      ['', 'd41d8cd98f00b204e9800998ecf8427e'],
      ['a', '0cc175b9c0f1b6a831c399e269772661'],
      ['abc', '900150983cd24fb0d6963f7d28e17f72'],
      ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
      ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
      [
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        'd174ab98d277d9f5a5611c2c9f419d9f',
      ],
      [
        '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
        '57edf4a22be3c955ac49da2e2107b67a',
      ],
    ];

    for (const [input, expected] of vectors) {
      expect(md5String(input)).toBe(expected);
      expect(md5Bytes(new TextEncoder().encode(input))).toBe(expected);
    }
  });

  it('handles 0-byte empty Uint8Array cleanly', () => {
    expect(md5Bytes(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('matches Node crypto on multi-byte UTF-8, emojis, CJK, and NFC vs NFD', () => {
    const samples = [
      'Hello 🌍🚀✨ Obsidian TriSync!',
      '日本語テキストと한국어와中文混合测试',
      'café'.normalize('NFC'),
      'café'.normalize('NFD'),
      '👨‍👩‍👧‍👦 ZWJ family emoji + math ∑∫√',
    ];

    for (const s of samples) {
      expect(md5String(s)).toBe(nodeMd5(s));
    }
    // NFC and NFD differ at byte level
    expect(md5String('café'.normalize('NFC'))).not.toBe(
      md5String('café'.normalize('NFD'))
    );
  });

  it('distinguishes CRLF vs LF byte-for-byte', () => {
    const lf = 'line1\nline2\nline3\n';
    const crlf = 'line1\r\nline2\r\nline3\r\n';
    expect(md5String(lf)).toBe(nodeMd5(lf));
    expect(md5String(crlf)).toBe(nodeMd5(crlf));
    expect(md5String(lf)).not.toBe(md5String(crlf));
  });

  it('matches Node crypto across all 64-byte block padding boundary lengths', () => {
    for (const len of [0, 1, 54, 55, 56, 57, 62, 63, 64, 65, 119, 120, 127, 128, 129, 255]) {
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        buf[i] = (i * 37 + 13) & 0xff;
      }
      expect(md5Bytes(buf)).toBe(nodeMd5(buf));
    }
  });

  it('matches Node crypto on a 10 MB binary buffer', () => {
    const size = 10 * 1024 * 1024;
    const buf = new Uint8Array(size);
    // Deterministic pseudo-random fill
    let seed = 0x12345678;
    for (let i = 0; i < size; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      buf[i] = seed & 0xff;
      buf[i + 1] = (seed >>> 8) & 0xff;
      buf[i + 2] = (seed >>> 16) & 0xff;
      buf[i + 3] = (seed >>> 24) & 0xff;
    }

    const expected = nodeMd5(buf);
    const actual = md5Bytes(buf);
    expect(actual).toBe(expected);
  });
});
