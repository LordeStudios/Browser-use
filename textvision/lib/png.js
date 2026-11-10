'use strict';
// Pure-Node image IO: PNG decode/encode, BMP decode. Output: {width,height,data:Uint8Array RGBA}
const zlib = require('zlib');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(img) {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('Not a PNG');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, plte = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace) throw new Error('Interlaced PNG not supported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch) throw new Error('Bad PNG color type');
  const bpp = Math.max(1, (ch * depth) >> 3);
  const stride = (w * ch * depth + 7) >> 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const cur = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[dst + x - bpp] : 0;
      const b = y > 0 ? cur[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? cur[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
      cur[dst + x] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  const maxv = (1 << depth) - 1;
  const sample = (y, i) => {
    if (depth === 8) return cur[y * stride + i];
    if (depth === 16) return cur[y * stride + i * 2];
    const bit = i * depth, byte = cur[y * stride + (bit >> 3)];
    return (byte >> (8 - depth - (bit & 7))) & maxv;
  };
  const scale = (v) => depth === 16 || depth === 8 ? v : Math.round(v * 255 / maxv);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    let r, g, b, a = 255;
    if (ctype === 0) { r = g = b = scale(sample(y, x)); }
    else if (ctype === 2) { r = sample(y, x * 3); g = sample(y, x * 3 + 1); b = sample(y, x * 3 + 2); }
    else if (ctype === 3) { const i = sample(y, x); r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2]; if (trns && i < trns.length) a = trns[i]; }
    else if (ctype === 4) { r = g = b = sample(y, x * 2); a = sample(y, x * 2 + 1); }
    else { r = sample(y, x * 4); g = sample(y, x * 4 + 1); b = sample(y, x * 4 + 2); a = sample(y, x * 4 + 3); }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return { width: w, height: h, data: out };
}

function decodeBmp(buf) {
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('Not a BMP');
  const off = buf.readUInt32LE(10), w = buf.readInt32LE(18);
  let h = buf.readInt32LE(22);
  const bits = buf.readUInt16LE(28), comp = buf.readUInt32LE(30);
  if (comp !== 0 && comp !== 3) throw new Error('Compressed BMP not supported');
  if (bits !== 24 && bits !== 32) throw new Error('Only 24/32-bit BMP supported');
  const flip = h > 0; h = Math.abs(h);
  const bytes = bits >> 3, stride = ((w * bits + 31) >> 5) << 2;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = flip ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = off + sy * stride + x * bytes, o = (y * w + x) * 4;
      out[o] = buf[s + 2]; out[o + 1] = buf[s + 1]; out[o + 2] = buf[s];
      out[o + 3] = bytes === 4 ? buf[s + 3] : 255;
    }
  }
  return { width: w, height: h, data: out };
}

function decodeImage(buf) {
  if (buf[0] === 0x89) return decodePng(buf);
  if (buf[0] === 0x42) return decodeBmp(buf);
  throw new Error('Unsupported image format (PNG and BMP only)');
}

module.exports = { decodePng, encodePng, decodeBmp, decodeImage };
