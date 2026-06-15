// Generates the app icon as build/icon.png (1024x1024) with no image libraries:
// a rounded green tile with a white horseshoe magnet (gold poles), matching the
// in-app logo. Convert to .icns/.ico with build/make-icons.sh.
const fs = require('fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function pngEncode(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) { raw[y * (1 + size * 4)] = 0; rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const S = 1024, CR = 230, cx = 512;
const Ro = 215, Ri = 120, cyTop = 455, legBottom = 770, poleTop = 700;
const GREEN = [22, 156, 121], WHITE = [255, 255, 255], GOLD = [245, 196, 81];

function inRoundedRect(x, y) {           // rounded-square tile
  const ix = Math.min(Math.max(x, CR), S - CR);
  const iy = Math.min(Math.max(y, CR), S - CR);
  return Math.hypot(x - ix, y - iy) <= CR;
}
function magnet(x, y) {                   // 0 none, 1 body(white), 2 pole(gold)
  const dx = x - cx;
  if (y <= cyTop) { const d = Math.hypot(dx, y - cyTop); return (d >= Ri && d <= Ro) ? 1 : 0; }
  const onLeg = (x >= cx - Ro && x <= cx - Ri) || (x >= cx + Ri && x <= cx + Ro);
  if (onLeg && y <= legBottom) return y >= poleTop ? 2 : 1;
  return 0;
}

const N = 3;                              // 3x3 supersampling for smooth edges
const rgba = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let bg = 0, nb = 0, np = 0;
    for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
      const px = x + (sx + 0.5) / N, py = y + (sy + 0.5) / N;
      if (inRoundedRect(px, py)) bg++;
      const m = magnet(px, py); if (m === 1) nb++; else if (m === 2) np++;
    }
    const tot = N * N, bgCov = bg / tot, mb = nb / tot, mp = np / tot, mCov = mb + mp;
    const mr = mCov ? (mb * WHITE[0] + mp * GOLD[0]) / mCov : 0;
    const mg = mCov ? (mb * WHITE[1] + mp * GOLD[1]) / mCov : 0;
    const mbl = mCov ? (mb * WHITE[2] + mp * GOLD[2]) / mCov : 0;
    const i = (y * S + x) * 4;
    rgba[i] = Math.round(GREEN[0] * (1 - mCov) + mr * mCov);
    rgba[i + 1] = Math.round(GREEN[1] * (1 - mCov) + mg * mCov);
    rgba[i + 2] = Math.round(GREEN[2] * (1 - mCov) + mbl * mCov);
    rgba[i + 3] = Math.round(bgCov * 255);
  }
}
const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, pngEncode(S, rgba));
console.log('wrote', out, '(1024x1024)');
