/**
 * Pure TypeScript RFC 1321 MD5 implementation.
 * Zero Node.js runtime dependencies — matches Google Drive's `md5Checksum`
 * byte-for-byte on desktop Electron, iOS WKWebView, and Android WebView.
 */

const SHIFT_AMOUNTS = new Int32Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const K = new Int32Array([
  0xd76aa478 | 0, 0xe8c7b756 | 0, 0x242070db | 0, 0xc1bdceee | 0,
  0xf57c0faf | 0, 0x4787c62a | 0, 0xa8304613 | 0, 0xfd469501 | 0,
  0x698098d8 | 0, 0x8b44f7af | 0, 0xffff5bb1 | 0, 0x895cd7be | 0,
  0x6b901122 | 0, 0xfd987193 | 0, 0xa679438e | 0, 0x49b40821 | 0,
  0xf61e2562 | 0, 0xc040b340 | 0, 0x265e5a51 | 0, 0xe9b6c7aa | 0,
  0xd62f105d | 0, 0x02441453 | 0, 0xd8a1e681 | 0, 0xe7d3fbc8 | 0,
  0x21e1cde6 | 0, 0xc33707d6 | 0, 0xf4d50d87 | 0, 0x455a14ed | 0,
  0xa9e3e905 | 0, 0xfcefa3f8 | 0, 0x676f02d9 | 0, 0x8d2a4c8a | 0,
  0xfffa3942 | 0, 0x8771f681 | 0, 0x6d9d6122 | 0, 0xfde5380c | 0,
  0xa4beea44 | 0, 0x4bdecfa9 | 0, 0xf6bb4b60 | 0, 0xbebfbc70 | 0,
  0x289b7ec6 | 0, 0xeaa127fa | 0, 0xd4ef3085 | 0, 0x04881d05 | 0,
  0xd9d4d039 | 0, 0xe6db99e5 | 0, 0x1fa27cf8 | 0, 0xc4ac5665 | 0,
  0xf4292244 | 0, 0x432aff97 | 0, 0xab9423a7 | 0, 0xfc93a039 | 0,
  0x655b59c3 | 0, 0x8f0ccc92 | 0, 0xffeff47d | 0, 0x85845dd1 | 0,
  0x6fa87e4f | 0, 0xfe2ce6e0 | 0, 0xa3014314 | 0, 0x4e0811a1 | 0,
  0xf7537e82 | 0, 0xbd3af235 | 0, 0x2ad7d2bb | 0, 0xeb86d391 | 0,
]);

const HEX_CHARS = '0123456789abcdef';
const utf8Encoder = new TextEncoder();

function wordToHexLE(word: number): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    const byte = (word >>> (i * 8)) & 0xff;
    out += HEX_CHARS[(byte >>> 4) & 0x0f] + HEX_CHARS[byte & 0x0f];
  }
  return out;
}

/**
 * Computes lowercase 32-char hexadecimal RFC 1321 MD5 digest of raw bytes.
 */
export function md5Bytes(input: Uint8Array): string {
  const len = input.byteLength;
  const fullBlocksEnd = len & ~63;

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  const M = new Int32Array(16);

  const processBlock = (buf: Uint8Array, offset: number): void => {
    for (let j = 0; j < 16; j++) {
      const idx = offset + (j << 2);
      M[j] =
        (buf[idx] |
          (buf[idx + 1] << 8) |
          (buf[idx + 2] << 16) |
          (buf[idx + 3] << 24)) | 0;
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }

      const sum = (A + F + K[i] + M[g]) | 0;
      const s = SHIFT_AMOUNTS[i];
      const rotated = (sum << s) | (sum >>> (32 - s));
      A = D;
      D = C;
      C = B;
      B = (B + rotated) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  };

  for (let offset = 0; offset < fullBlocksEnd; offset += 64) {
    processBlock(input, offset);
  }

  // Final 1 or 2 padded blocks (64 or 128 bytes)
  const rem = len - fullBlocksEnd;
  const tailLen = rem < 56 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  if (rem > 0) {
    tail.set(input.subarray(fullBlocksEnd, len), 0);
  }
  tail[rem] = 0x80;

  // 64-bit little-endian bit length
  const bitLenLow = (len << 3) >>> 0;
  const bitLenHigh = Math.floor(len / 0x20000000) >>> 0;
  const lenPos = tailLen - 8;
  tail[lenPos] = bitLenLow & 0xff;
  tail[lenPos + 1] = (bitLenLow >>> 8) & 0xff;
  tail[lenPos + 2] = (bitLenLow >>> 16) & 0xff;
  tail[lenPos + 3] = (bitLenLow >>> 24) & 0xff;
  tail[lenPos + 4] = bitLenHigh & 0xff;
  tail[lenPos + 5] = (bitLenHigh >>> 8) & 0xff;
  tail[lenPos + 6] = (bitLenHigh >>> 16) & 0xff;
  tail[lenPos + 7] = (bitLenHigh >>> 24) & 0xff;

  processBlock(tail, 0);
  if (tailLen === 128) {
    processBlock(tail, 64);
  }

  return wordToHexLE(a0) + wordToHexLE(b0) + wordToHexLE(c0) + wordToHexLE(d0);
}

/**
 * Computes lowercase 32-char hexadecimal RFC 1321 MD5 digest of a UTF-8 string.
 */
export function md5String(text: string): string {
  return md5Bytes(utf8Encoder.encode(text));
}
