// Smacker (SMK2/SMK4) decoder — video, palette and audio — in plain JavaScript.
// Works in browsers and Node; decodes straight from the original 1996 data file.

const SMK_NODE = 0x80000000;

const BLOCK_RUNS = new Uint16Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
  49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 128, 256, 512, 1024, 2048,
]);

// Little-endian, LSB-first bit reader.
class BitReader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.b = bytes;
    this.pos = start * 8;
    this.end = end * 8;
  }
  bit() {
    const p = this.pos++;
    if (p >= this.end) return 0;
    return (this.b[p >> 3] >> (p & 7)) & 1;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v >>> 0;
  }
}

// Byte-valued Huffman tree, stored as a flat array: nodes hold SMK_NODE | leftSize.
function readByteTree(br) {
  const tree = [];
  if (!br.bit()) return null;
  (function rec(depth) {
    if (depth > 32) throw new Error('Smacker: byte tree too deep');
    if (!br.bit()) {
      tree.push(br.bits(8));
      return 1;
    }
    const t = tree.length;
    tree.push(0);
    const left = rec(depth + 1);
    tree[t] = SMK_NODE | left;
    return 1 + left + rec(depth + 1);
  })(0);
  br.bit();
  return Int32Array.from(tree);
}

function decodeByteTree(br, tree) {
  if (!tree) return 0;
  let i = 0;
  while (tree[i] & SMK_NODE) {
    if (br.bit()) i += tree[i] & 0x7fffffff;
    i++;
  }
  return tree[i];
}

// 16-bit "big" tree with a three-entry recent-value cache (the escape codes).
class BigTree {
  constructor(br) {
    if (!br.bit()) {
      this.values = new Int32Array(4);
      this.last = [1, 2, 3];
      return;
    }
    const lo = readByteTree(br);
    const hi = readByteTree(br);
    const esc = [br.bits(16), br.bits(16), br.bits(16)];
    const last = [-1, -1, -1];
    const values = [];
    (function rec(depth) {
      if (depth > 64) throw new Error('Smacker: big tree too deep');
      if (!br.bit()) {
        let v = decodeByteTree(br, lo) | (decodeByteTree(br, hi) << 8);
        if (v === esc[0]) { last[0] = values.length; v = 0; }
        else if (v === esc[1]) { last[1] = values.length; v = 0; }
        else if (v === esc[2]) { last[2] = values.length; v = 0; }
        values.push(v);
        return 1;
      }
      const t = values.length;
      values.push(0);
      const left = rec(depth + 1);
      values[t] = SMK_NODE | left;
      return 1 + left + rec(depth + 1);
    })(0);
    br.bit();
    for (let i = 0; i < 3; i++) if (last[i] === -1) { last[i] = values.length; values.push(0); }
    this.values = Int32Array.from(values);
    this.last = last;
  }
  reset() {
    const { values, last } = this;
    values[last[0]] = values[last[1]] = values[last[2]] = 0;
  }
  get(br) {
    const t = this.values;
    let i = 0;
    while (t[i] & SMK_NODE) {
      if (br.bit()) i += t[i] & 0x7fffffff;
      i++;
    }
    const v = t[i];
    const l = this.last;
    if (v !== t[l[0]]) {
      t[l[2]] = t[l[1]];
      t[l[1]] = t[l[0]];
      t[l[0]] = v;
    }
    return v;
  }
}

export class SmackerFile {
  constructor(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sig = String.fromCharCode(...bytes.subarray(0, 4));
    if (sig !== 'SMK2' && sig !== 'SMK4') throw new Error('Not a Smacker file');
    this.bytes = bytes;
    this.version = sig === 'SMK4' ? 4 : 2;
    this.width = dv.getUint32(4, true);
    this.height = dv.getUint32(8, true);
    this.frameCount = dv.getUint32(12, true);
    const rate = dv.getInt32(16, true);
    this.fps = rate > 0 ? 1000 / rate : rate < 0 ? 100000 / -rate : 10;
    this.flags = dv.getUint32(20, true);
    const ring = this.flags & 1 ? 1 : 0;
    this.audio = [];
    for (let i = 0; i < 7; i++) {
      const r = dv.getUint32(72 + i * 4, true);
      if (r & 0x40000000) {
        this.audio.push({
          track: i,
          compressed: !!(r & 0x80000000),
          bits16: !!(r & 0x20000000),
          stereo: !!(r & 0x10000000),
          rate: r & 0xffffff,
        });
      }
    }
    const treesSize = dv.getUint32(52, true);
    const n = this.frameCount + ring;
    let off = 104;
    this.frameSizes = new Uint32Array(n);
    this.keyframes = new Uint8Array(n);
    for (let i = 0; i < n; i++, off += 4) {
      const s = dv.getUint32(off, true);
      this.frameSizes[i] = s & ~3;
      this.keyframes[i] = s & 1;
    }
    this.frameTypes = bytes.slice(off, off + n);
    off += n;
    const br = new BitReader(bytes, off, off + treesSize);
    this.mmap = new BigTree(br);
    this.mclr = new BigTree(br);
    this.full = new BigTree(br);
    this.type = new BigTree(br);
    off += treesSize;
    this.frameOffsets = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      this.frameOffsets[i] = off;
      off += this.frameSizes[i];
    }
  }

  // Frame-by-frame decoder state: 8-bit indexed image + 6-bit VGA palette.
  createDecoder() {
    return new SmackerDecoder(this);
  }

  // Decode every audio track to Float32 PCM in one pass (fast, ~ms per second of audio).
  decodeAudio() {
    const out = this.audio.map(a => ({ ...a, chunks: [], length: 0 }));
    for (let f = 0; f < this.frameCount; f++) {
      let p = this.frameOffsets[f];
      const ft = this.frameTypes[f];
      if (ft & 1) p += this.bytes[p] * 4;
      for (let t = 0; t < 7; t++) {
        if (!(ft & (2 << t))) continue;
        const len = this.bytes[p] | (this.bytes[p + 1] << 8) | (this.bytes[p + 2] << 16) | (this.bytes[p + 3] << 24);
        const track = out.find(a => a.track === t);
        if (track && len > 4) {
          const pcm = track.compressed
            ? decodeAudioChunk(this.bytes, p + 4, p + len, track)
            : rawAudioChunk(this.bytes, p + 4, p + len, track);
          if (pcm) { track.chunks.push(pcm); track.length += pcm[0].length; }
        }
        p += len;
      }
    }
    return out.map(t => {
      const channels = t.stereo ? 2 : 1;
      const data = [];
      for (let c = 0; c < channels; c++) {
        const buf = new Float32Array(t.length);
        let o = 0;
        for (const ch of t.chunks) { buf.set(ch[c], o); o += ch[c].length; }
        data.push(buf);
      }
      return { track: t.track, rate: t.rate, channels: data };
    });
  }
}

function rawAudioChunk(bytes, start, end, fmt) {
  const ch = fmt.stereo ? 2 : 1;
  const bps = fmt.bits16 ? 2 : 1;
  const n = Math.floor((end - start) / (bps * ch));
  const res = Array.from({ length: ch }, () => new Float32Array(n));
  let p = start;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      if (bps === 2) { res[c][i] = (((bytes[p] | (bytes[p + 1] << 8)) << 16) >> 16) / 32768; p += 2; }
      else res[c][i] = (bytes[p++] - 128) / 128;
    }
  }
  return res;
}

function decodeAudioChunk(bytes, start, end, fmt) {
  const unp = (bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16) | (bytes[start + 3] << 24)) >>> 0;
  const br = new BitReader(bytes, start + 4, end);
  if (!br.bit()) return null;
  const stereo = br.bit();
  const bits16 = br.bit();
  const trees = [];
  for (let i = 0; i < 1 << (bits16 + stereo); i++) trees.push(readByteTree(br));
  const ch = stereo + 1;
  const samples = Math.floor(unp / (ch * (bits16 + 1)));
  const res = Array.from({ length: ch }, () => new Float32Array(samples));
  const pred = [0, 0];
  if (bits16) {
    for (let i = stereo; i >= 0; i--) {
      const v = br.bits(16);
      pred[i] = (((v >> 8) | ((v & 0xff) << 8)) << 16) >> 16;
    }
    for (let c = 0; c < ch; c++) res[c][0] = pred[c] / 32768;
    for (let i = 1; i < samples; i++) {
      for (let c = 0; c < ch; c++) {
        const lo = decodeByteTree(br, trees[c * 2]);
        const hi = decodeByteTree(br, trees[c * 2 + 1]);
        pred[c] = (((pred[c] + (lo | (hi << 8))) << 16) >> 16);
        res[c][i] = pred[c] / 32768;
      }
    }
  } else {
    for (let i = stereo; i >= 0; i--) pred[i] = br.bits(8);
    for (let c = 0; c < ch; c++) res[c][0] = (pred[c] - 128) / 128;
    for (let i = 1; i < samples; i++) {
      for (let c = 0; c < ch; c++) {
        const d = (decodeByteTree(br, trees[c]) << 24) >> 24;
        pred[c] = (pred[c] + d) & 0xff;
        res[c][i] = (pred[c] - 128) / 128;
      }
    }
  }
  return res;
}

export class SmackerDecoder {
  constructor(smk) {
    this.smk = smk;
    this.pixels = new Uint8Array(smk.width * smk.height);
    this.palette = new Uint8Array(768); // 6-bit VGA components (0..63)
    this.frame = -1;
  }

  snapshot() {
    return { frame: this.frame, pixels: this.pixels.slice(), palette: this.palette.slice() };
  }

  restore(s) {
    this.frame = s.frame;
    this.pixels.set(s.pixels);
    this.palette.set(s.palette);
  }

  // Decode the next frame in sequence. Returns true if the palette changed.
  next() {
    const smk = this.smk;
    const f = ++this.frame;
    if (f >= smk.frameCount) throw new Error('Smacker: past end');
    const bytes = smk.bytes;
    let p = smk.frameOffsets[f];
    const end = p + smk.frameSizes[f];
    const ft = smk.frameTypes[f];
    let palChanged = false;
    if (ft & 1) {
      const size = bytes[p] * 4;
      this.decodePalette(p + 1, p + size);
      p += size;
      palChanged = true;
    }
    for (let t = 0; t < 7; t++) {
      if (ft & (2 << t)) p += (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
    }
    this.decodeVideo(p, end);
    return palChanged;
  }

  decodePalette(p, end) {
    const bytes = this.smk.bytes;
    const old = this.palette.slice();
    const pal = this.palette;
    let sz = 0;
    while (sz < 256 && p < end) {
      const t = bytes[p++];
      if (t & 0x80) {
        sz += (t & 0x7f) + 1; // keep entries unchanged
      } else if (t & 0x40) {
        let off = bytes[p++];
        let j = (t & 0x3f) + 1;
        while (j-- && sz < 256 && off < 256) {
          pal[sz * 3] = old[off * 3];
          pal[sz * 3 + 1] = old[off * 3 + 1];
          pal[sz * 3 + 2] = old[off * 3 + 2];
          sz++; off++;
        }
      } else {
        pal[sz * 3] = t & 0x3f;
        pal[sz * 3 + 1] = bytes[p++] & 0x3f;
        pal[sz * 3 + 2] = bytes[p++] & 0x3f;
        sz++;
      }
    }
  }

  decodeVideo(start, end) {
    const smk = this.smk;
    const { mmap, mclr, full, type } = smk;
    mmap.reset(); mclr.reset(); full.reset(); type.reset();
    const br = new BitReader(smk.bytes, start, end);
    const w = smk.width;
    const bw = w >> 2;
    const blocks = bw * (smk.height >> 2);
    const px = this.pixels;
    const stride = w;
    let blk = 0;
    while (blk < blocks) {
      const t = type.get(br);
      let run = BLOCK_RUNS[(t >> 2) & 0x3f];
      switch (t & 3) {
        case 0: // mono: two colours + 16-bit mask
          while (run-- && blk < blocks) {
            const clr = mclr.get(br);
            let map = mmap.get(br);
            const hi = clr >> 8, lo = clr & 0xff;
            let o = ((blk / bw) | 0) * 4 * stride + (blk % bw) * 4;
            for (let i = 0; i < 4; i++, o += stride) {
              px[o] = map & 1 ? hi : lo;
              px[o + 1] = map & 2 ? hi : lo;
              px[o + 2] = map & 4 ? hi : lo;
              px[o + 3] = map & 8 ? hi : lo;
              map >>= 4;
            }
            blk++;
          }
          break;
        case 1: { // full: 16 explicit pixels
          let mode = 0;
          if (smk.version === 4) {
            if (br.bit()) mode = 1;
            else if (br.bit()) mode = 2;
          }
          while (run-- && blk < blocks) {
            let o = ((blk / bw) | 0) * 4 * stride + (blk % bw) * 4;
            if (mode === 0) {
              for (let i = 0; i < 4; i++, o += stride) {
                let c = full.get(br);
                px[o + 2] = c & 0xff; px[o + 3] = c >> 8;
                c = full.get(br);
                px[o] = c & 0xff; px[o + 1] = c >> 8;
              }
            } else if (mode === 1) { // SMK4 double-size pixels
              for (let i = 0; i < 2; i++) {
                let c = full.get(br);
                px[o] = px[o + 1] = px[o + stride] = px[o + stride + 1] = c & 0xff;
                px[o + 2] = px[o + 3] = px[o + stride + 2] = px[o + stride + 3] = c >> 8;
                o += stride * 2;
              }
            } else { // SMK4 line-doubled
              for (let i = 0; i < 2; i++) {
                let c = full.get(br);
                px[o + 2] = px[o + stride + 2] = c & 0xff; px[o + 3] = px[o + stride + 3] = c >> 8;
                c = full.get(br);
                px[o] = px[o + stride] = c & 0xff; px[o + 1] = px[o + stride + 1] = c >> 8;
                o += stride * 2;
              }
            }
            blk++;
          }
          break;
        }
        case 2: // skip: keep previous pixels
          blk += Math.min(run, blocks - blk);
          break;
        case 3: { // solid fill
          const c = t >> 8;
          while (run-- && blk < blocks) {
            let o = ((blk / bw) | 0) * 4 * stride + (blk % bw) * 4;
            for (let i = 0; i < 4; i++, o += stride) px[o] = px[o + 1] = px[o + 2] = px[o + 3] = c;
            blk++;
          }
          break;
        }
      }
    }
  }
}

// 6-bit VGA DAC value -> 8-bit, matching the classic Smacker table.
export const VGA_TO_8 = Uint8Array.from({ length: 64 }, (_, i) => Math.round((i * 255) / 63));
