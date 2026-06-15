#!/usr/bin/env bash
# Regenerate the app icons from build/gen-app-icon.cjs.
# macOS only (uses sips + iconutil). Outputs build/icon.icns and build/icon.ico.
set -e
cd "$(dirname "$0")/.."

node build/gen-app-icon.cjs

# macOS .icns
rm -rf build/icon.iconset && mkdir build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z "$s" "$s"     build/icon.png --out "build/icon.iconset/icon_${s}x${s}.png"    >/dev/null
  sips -z $((s*2)) $((s*2)) build/icon.png --out "build/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset

# Windows .ico (pack PNG sub-images)
for s in 16 32 48 64 128 256; do sips -z "$s" "$s" build/icon.png --out "build/_ico_${s}.png" >/dev/null; done
node -e '
const fs=require("fs"), sizes=[16,32,48,64,128,256];
const imgs=sizes.map(s=>fs.readFileSync(`build/_ico_${s}.png`));
const head=Buffer.alloc(6); head.writeUInt16LE(1,2); head.writeUInt16LE(sizes.length,4);
const ent=Buffer.alloc(16*sizes.length); let off=6+ent.length;
imgs.forEach((img,i)=>{const e=i*16,s=sizes[i];ent[e]=s>=256?0:s;ent[e+1]=s>=256?0:s;ent.writeUInt16LE(1,e+4);ent.writeUInt16LE(32,e+6);ent.writeUInt32LE(img.length,e+8);ent.writeUInt32LE(off,e+12);off+=img.length;});
fs.writeFileSync("build/icon.ico",Buffer.concat([head,ent,...imgs]));
'
rm -f build/_ico_*.png
echo "Done: build/icon.icns, build/icon.ico"
