// png-squeeze: a lossless PNG recompressor for 1280x720 RGBA screenshots.
//
// Strategy (all original code, written for this entry):
//  1. Decode the stored input PNG to RGBA.
//  2. Screen several lossless forms of the image (palette with three orderings,
//     grey / grey+alpha / RGB / RGBA, with a tRNS key when the image has a single
//     fully-transparent colour) under several per-row filter policies (fixed
//     filters, minimum-signed-sum, fewest-distinct-pairs, and a per-row brute
//     force that weighs each filter by a real deflate of the row against the
//     32 KiB written before it), scoring each by zlib level 6.
//  3. Re-encode the best few candidates with zlib level 9 (memLevel 8 and 9,
//     plus a Z_FILTERED variant of the best) and keep the smallest.
//  4. Write one PNG: IHDR, PLTE/tRNS when the form needs them, a single IDAT
//     holding one zlib stream, IEND. Bit depth 8, no interlace.
//
// Everything is deterministic: candidates are compared by measured byte count,
// ties keep the earlier candidate, and no clock, environment value or random
// source influences any choice. Paths come from MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR (defaulting to /input and /output, the harness mounts).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// CRC-32 (PNG's, ISO 3309) and chunk assembly.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const asciiBytes = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

/** Assemble a PNG from [type, data] chunks: signature, lengths, CRCs. */
function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(asciiBytes(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------------------
// PNG decoding to RGBA. The inputs are stored colour-type-6 PNGs, but the
// decoder is general (types 0/2/3/4/6, all five filters) so an unexpected
// input shape still decodes instead of failing the whole run.
// ---------------------------------------------------------------------------
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = {
        width: dv.getUint32(0),
        height: dv.getUint32(4),
        depth: data[8],
        colourType: data[9],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!header || header.depth !== 8) throw new Error('unreadable PNG header');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('IDAT inflates to the wrong length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredictor(a, b, c);
      }
    } else throw new Error('unknown filter type ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image analysis: opaque? grey? at most 256 distinct colours?
// ---------------------------------------------------------------------------
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  // Read each colour back from bytes, never from the word (endianness).
  const colours = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
      });
  return { opaque, grey, colours };
}

/**
 * The one fully-transparent colour the image may key by tRNS instead of an
 * alpha channel: every non-opaque pixel is exactly that colour at alpha 0,
 * and no opaque pixel uses the same colour. Null when there is none.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Palette forms: transparent entries first (so tRNS stays short), then the
// opaque entries in one of three orders. 'count' puts frequent colours
// first (good for unfiltered runs); 'luminance' sorts by brightness;
// 'greedy' walks a nearest-neighbour path through RGB space so colours
// that sit next to each other on screen tend to get nearby indices.
// ---------------------------------------------------------------------------
const luminanceOf = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];

function orderPalette(colours, order) {
  if (order === 'greedy') {
    const trans = colours.filter((c) => c.rgba[3] !== 255).sort((x, y) => x.rgba[3] - y.rgba[3] || x.word - y.word);
    const op = colours.filter((c) => c.rgba[3] === 255);
    const out = [...trans];
    if (op.length > 0) {
      const used = new Uint8Array(op.length);
      let cur = 0;
      let bestCount = -1;
      op.forEach((c, i) => {
        if (c.count > bestCount) {
          bestCount = c.count;
          cur = i;
        }
      });
      out.push(op[cur]);
      used[cur] = 1;
      for (let k = 1; k < op.length; k++) {
        const cc = op[cur].rgba;
        let bi = -1;
        let bd = Infinity;
        for (let i = 0; i < op.length; i++) {
          if (used[i]) continue;
          const o = op[i].rgba;
          const dr = cc[0] - o[0];
          const dg = cc[1] - o[1];
          const db = cc[2] - o[2];
          const dist = dr * dr * 3 + dg * dg * 4 + db * db * 2;
          if (dist < bd) {
            bd = dist;
            bi = i;
          }
        }
        out.push(op[bi]);
        used[bi] = 1;
        cur = bi;
      }
    }
    return out;
  }
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return luminanceOf(x) - luminanceOf(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word; // 'count'
  });
}

function paletteForm(rgba, colours, order) {
  const entries = orderPalette(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA. */
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG row filters and the policies that pick one per row.
// ---------------------------------------------------------------------------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredictor(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed (-128..127): the PNG spec's minimum-sum heuristic cost. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** How many distinct neighbouring byte pairs a filtered row holds. */
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

/**
 * Filter every row of `samples` by `choice`: a fixed filter (0-4), or a
 * per-row policy: 'minsum' (least signed sum), 'pairs' (fewest distinct byte
 * pairs), or 'brute' (each filter weighed by a real level-4 deflate of the
 * row against the 32 KiB written before it). The lower filter wins a tie.
 */
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else {
        const rowWithFilter = Buffer.concat([Buffer.from([t]), Buffer.from(trial[t])]);
        cost = deflateSync(
          rowWithFilter,
          before.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Forms: every lossless way the image may be written, and the filter
// policies each form is screened with.
// ---------------------------------------------------------------------------
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'greedy']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        name: 'pal-' + order,
        colourType: 3,
        bpp: 1,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        // Filtering rarely helps a palette (indices, not colours); the
        // count order is screened unfiltered only, the luminance order
        // unfiltered and by brute force. (The greedy order's brute force
        // and the minimum-sum policy never won on the practice set, so
        // they are left out to save wall budget.)
        filters: order === 'count' ? [0] : order === 'luminance' ? [0, 'brute'] : [0],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    name: 'ct' + ct + (trns ? '+trns' : ''),
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    // Sub (1) and Average (3) never won on the practice set; Up (2) and
    // Paeth (4) cover the useful cases, alongside the per-row policies.
    filters: [0, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

/** The bytes a form's PLTE and tRNS chunks add to its file. */
const chunkBytes = (form) => (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);

/** Bytes of PNG framing around one IDAT chunk (signature + IHDR + IEND). */
const FRAME_BYTES = 8 + 25 + 12 + 12;

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
// Final encodes: zlib level 9 at memLevel 5, 6 and 7. (On the practice set
// the smaller hash tables of memLevel 5-7 consistently beat 8 and 9 by
// ~1% on these screenshots: zlib's match search is heuristic, and the
// smaller tables happen to pick better matches for this repetitive data.)
const FINAL_OPTS = [
  { level: 9, memLevel: 5 },
  { level: 9, memLevel: 6 },
  { level: 9, memLevel: 7 },
];

/** The PNG of a form whose IDAT holds `idat`. */
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/**
 * Compress one image: screen every form/filter at zlib level 6, keep the
 * three smallest, re-encode them at level 9 (memLevel 8 and 9), then try a
 * Z_FILTERED level-9 stream of the best, and return the smallest PNG.
 */
function compressImage(rgba, width, height) {
  const forms = formsOf(rgba);
  const ranked = [];
  for (const form of forms) {
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunkBytes(form) + FRAME_BYTES;
      ranked.push({ form, choice, data, bytes });
    }
  }
  ranked.sort((a, b) => a.bytes - b.bytes);
  const finalists = ranked.slice(0, 3);
  let best = null;
  for (const cand of finalists) {
    for (const opts of FINAL_OPTS) {
      const zlib = deflateSync(cand.data, opts);
      const bytes = zlib.length + chunkBytes(cand.form) + FRAME_BYTES;
      if (best === null || bytes < best.bytes) best = { form: cand.form, data: cand.data, zlib, bytes };
    }
  }
  // A filtered-strategy stream sometimes wins on photographic rows.
  for (const opts of [
    { level: 9, memLevel: 7, strategy: constants.Z_FILTERED },
    { level: 9, memLevel: 6, strategy: constants.Z_FILTERED },
  ]) {
    const zlib = deflateSync(best.data, opts);
    const bytes = zlib.length + chunkBytes(best.form) + FRAME_BYTES;
    if (bytes < best.bytes) best = { form: best.form, data: best.data, zlib, bytes };
  }
  return pngOfForm(width, height, best.form, best.zlib);
}

// ---------------------------------------------------------------------------
// Main: one run over the whole set, /input/<id>/image.png in, /output/<id>/image.png out.
// ---------------------------------------------------------------------------
for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const png = compressImage(image.rgba, image.width, image.height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
