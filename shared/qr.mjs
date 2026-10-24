// QR encoding and a minimal PNG writer, with no dependencies.
//
// Workers cannot pull in a QR library at runtime and an outside QR-image
// service is not an option here: the ticket URL identifies a delegate, and
// handing that to a third party to render would leak exactly what this
// convention is careful about. So it is built here.
//
// Scope is deliberately narrow — byte mode, error-correction level M,
// versions 1 to 6 (up to 106 characters). A ticket URL is about forty
// characters, so it lands on version 3. Anything longer throws rather than
// silently producing a code no scanner can read.

// ---------------------------------------------------------------------------
// GF(256) arithmetic for Reed–Solomon, primitive polynomial 0x11D.
// ---------------------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      // Multiplying by (x + a): the x term keeps the coefficient's position,
      // the constant term pushes it one place down. Swapping these two lines
      // yields a generator that is not monic — every EC codeword then comes
      // out wrong while still looking self-consistent.
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecCodewords(data, count) {
  const gen = generatorPoly(count);
  const res = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < count; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Version tables, error-correction level M only.
//   capacity  — byte-mode characters
//   ec        — EC codewords per block
//   blocks    — [count, dataCodewordsPerBlock] groups
// ---------------------------------------------------------------------------
const VERSIONS = {
  1: { capacity: 14, total: 26, ec: 10, blocks: [[1, 16]] },
  2: { capacity: 26, total: 44, ec: 16, blocks: [[1, 28]] },
  3: { capacity: 42, total: 70, ec: 26, blocks: [[1, 44]] },
  4: { capacity: 62, total: 100, ec: 18, blocks: [[2, 32]] },
  5: { capacity: 84, total: 134, ec: 24, blocks: [[2, 43]] },
  6: { capacity: 106, total: 172, ec: 16, blocks: [[4, 27]] },
};

const pickVersion = (len) => {
  for (let v = 1; v <= 6; v++) if (len <= VERSIONS[v].capacity) return v;
  throw new Error("QR payload too long: " + len + " chars (max 106)");
};

// ---------------------------------------------------------------------------
// Bit stream -> codewords
// ---------------------------------------------------------------------------
function buildCodewords(bytes, version) {
  const spec = VERSIONS[version];
  const dataCount = spec.blocks.reduce((s, [n, k]) => s + n * k, 0);
  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // versions 1–9 use an 8-bit count in byte mode
  for (const b of bytes) push(b, 8);

  // Terminator, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < dataCount * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // The standard's alternating pad bytes.
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCount; i++) codewords.push(PAD[i % 2]);

  // Split into blocks, compute EC per block, then interleave both.
  const dataBlocks = [];
  const ecBlocks = [];
  let at = 0;
  for (const [count, k] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(at, at + k);
      at += k;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, spec.ec));
    }
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------
const FORMAT_MASK = 0b101010000010010;

function formatBits(mask) {
  // Level M is 0b00; BCH(15,5) over the 5 data bits.
  let data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0b10100110111);
  return ((data << 10) | rem) ^ FORMAT_MASK;
}

// Every module is either a function module (finders, timing, alignment, format
// area, the dark module) or a data module. The distinction matters twice: data
// is only written into the second kind, and the mask is only applied to the
// second kind. Masking a finder pattern produces a code nothing can read.
function blank(size) {
  return {
    size,
    px: Array.from({ length: size }, () => new Int8Array(size).fill(0)),
    fn: Array.from({ length: size }, () => new Uint8Array(size)),
    set(r, c, v) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      this.px[r][c] = v ? 1 : 0;
      this.fn[r][c] = 1;
    },
  };
}

function placeFunctionPatterns(m) {
  const size = m.size;
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m.set(r0 + r, c0 + c, ring);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }

  // Versions 2–6 carry exactly one alignment pattern, centred at 4v+10.
  const version = (size - 17) / 4;
  if (version >= 2) {
    const c = 4 * version + 10;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        m.set(c + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
  }

  m.set(size - 8, 8, 1); // always dark

  // Reserve the format area so data skips it; the bits land after masking.
  for (let i = 0; i <= 8; i++) {
    if (!m.fn[8][i]) m.set(8, i, 0);
    if (!m.fn[i][8]) m.set(i, 8, 0);
  }
  for (let i = size - 8; i < size; i++) {
    if (!m.fn[8][i]) m.set(8, i, 0);
    if (!m.fn[i][8]) m.set(i, 8, 0);
  }
}

function placeData(m, codewords) {
  const size = m.size;
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  let bit = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is not a data column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const col of [right, right - 1]) {
        if (m.fn[row][col]) continue;
        m.px[row][col] = bit < bits.length ? bits[bit] : 0;
        bit++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Format bits are written twice, in the two L-shapes around the finders. The
// coordinate order here is (row, column); getting it transposed produces a code
// that looks perfectly plausible and decodes in nothing.
function writeFormat(px, size, bits) {
  const bit = (i) => (bits >> i) & 1;
  for (let i = 0; i <= 5; i++) px[i][8] = bit(i);
  px[7][8] = bit(6);
  px[8][8] = bit(7);
  px[8][7] = bit(8);
  for (let i = 9; i < 15; i++) px[8][14 - i] = bit(i);

  for (let i = 0; i < 8; i++) px[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) px[size - 15 + i][8] = bit(i);

  px[size - 8][8] = 1;
}

// The four penalty rules from the standard. Choosing the lowest-scoring mask is
// what keeps a code readable under a gate scanner in poor light.
function penalty(px, size) {
  let score = 0;

  const runScore = (line) => {
    let run = 1, s = 0;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  for (let r = 0; r < size; r++) score += runScore(px[r]);
  for (let c = 0; c < size; c++) score += runScore(px.map((row) => row[c]));

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = px[r][c];
      if (v === px[r][c + 1] && v === px[r + 1][c] && v === px[r + 1][c + 1]) score += 3;
    }
  }

  const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const hasAt = (line, i) => PATTERN.every((v, k) => line[i + k] === v);
  for (let r = 0; r < size; r++) {
    const row = px[r];
    const col = px.map((x) => x[r]);
    for (let i = 0; i + 11 <= size; i++) {
      if (hasAt(row, i)) score += 40;
      if (hasAt(col, i)) score += 40;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += px[r][c];
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;

  return score;
}

/** Encode text as a QR matrix. Returns { size, modules: boolean[][] }. */
export function qrMatrix(text, forceMask) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  const size = 17 + 4 * version;

  const m = blank(size);
  placeFunctionPatterns(m);
  placeData(m, buildCodewords(bytes, version));

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask != null && mask !== forceMask) continue;
    const px = m.px.map((row) => Array.from(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!m.fn[r][c] && MASKS[mask](r, c)) px[r][c] ^= 1;
      }
    }
    writeFormat(px, size, formatBits(mask));
    const score = penalty(px, size);
    if (!best || score < best.score) best = { score, px };
  }

  return { size, modules: best.px.map((row) => row.map((v) => v === 1)) };
}

// ---------------------------------------------------------------------------
// PNG, 1-bit greyscale. Email clients will not render SVG, so the emailed
// ticket needs a raster. Deflate "stored" blocks keep this dependency-free —
// a QR is small enough that not compressing costs a few kilobytes.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const forCrc = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(forCrc));
  return out;
}

/**
 * Render a QR matrix as a PNG.
 * @param scale pixels per module
 * @param quiet quiet-zone width in modules (4 is the standard minimum)
 */
export function qrPng(text, scale = 8, quiet = 4) {
  const { size, modules } = qrMatrix(text);
  const dim = (size + quiet * 2) * scale;
  const rowBytes = Math.ceil(dim / 8);

  // 1 = white, 0 = black. Each row is prefixed with filter type 0.
  const raw = new Uint8Array((rowBytes + 1) * dim);
  for (let y = 0; y < dim; y++) {
    const base = y * (rowBytes + 1);
    raw[base] = 0;
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const dark =
        my >= 0 && my < size && mx >= 0 && mx < size && modules[my][mx];
      if (!dark) raw[base + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  // zlib stream with stored (uncompressed) deflate blocks.
  const MAX = 65535;
  const parts = [new Uint8Array([0x78, 0x01])];
  for (let off = 0; off < raw.length; off += MAX) {
    const slice = raw.subarray(off, Math.min(off + MAX, raw.length));
    const last = off + MAX >= raw.length ? 1 : 0;
    const head = new Uint8Array(5);
    head[0] = last;
    head[1] = slice.length & 0xff;
    head[2] = (slice.length >> 8) & 0xff;
    head[3] = ~slice.length & 0xff;
    head[4] = (~slice.length >> 8) & 0xff;
    parts.push(head, slice);
  }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, adler32(raw));
  parts.push(adler);

  const zlen = parts.reduce((s, p) => s + p.length, 0);
  const zlib = new Uint8Array(zlen);
  let at = 0;
  for (const p of parts) { zlib.set(p, at); at += p.length; }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, dim);
  dv.setUint32(4, dim);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [sig, chunk("IHDR", ihdr), chunk("IDAT", zlib), chunk("IEND", new Uint8Array(0))];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { png.set(c, p); p += c.length; }
  return png;
}

/** Same matrix as a scalable SVG, for the web ticket where it stays crisp. */
export function qrSvg(text, scale = 8, quiet = 4) {
  const { size, modules } = qrMatrix(text);
  const dim = (size + quiet * 2) * scale;
  let path = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="Ticket QR code">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}

// Test-only surface, so the encoder can be checked against a reference.
export const __internals = { buildCodewords, blank, placeFunctionPatterns, MASKS };
