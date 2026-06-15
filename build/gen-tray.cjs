// Generates tray icons (a download-arrow glyph) without any image libraries.
// Outputs into electron/assets so they get bundled with the app.
const fs = require('fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) { raw[y * (1 + size * 4)] = 0; rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
// Download-arrow alpha mask, drawn on a `size` grid (designed at 32, scaled).
function alphaAt(x, y, size) {
  const s = size / 32; x /= s; y /= s; // map to 32-grid
  // stem
  if (x >= 13.5 && x <= 18.5 && y >= 5 && y <= 18) return 1;
  // arrow head (triangle pointing down)
  if (y >= 17 && y <= 24) { const hw = (24 - y) / 7 * 8; if (Math.abs(x - 16) <= hw) return 1; }
  // base line
  if (y >= 26 && y <= 29.5 && x >= 8 && x <= 24) return 1;
  return 0;
}
function build(size, rgb) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4; const a = alphaAt(x + 0.5, y + 0.5, size) ? 255 : 0;
    rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = a;
  }
  return png(size, rgba);
}
const out = path.join(__dirname, '..', 'electron', 'assets');
fs.mkdirSync(out, { recursive: true });
// macOS template: black glyph, system recolors it for light/dark menu bar.
fs.writeFileSync(path.join(out, 'trayTemplate.png'), build(16, [0, 0, 0]));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), build(32, [0, 0, 0]));
// Windows / fallback: brand green glyph.
fs.writeFileSync(path.join(out, 'tray.png'), build(32, [22, 156, 121]));
console.log('tray icons written to', out);
