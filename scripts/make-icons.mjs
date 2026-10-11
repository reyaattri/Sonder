// Generates the PWA PNG icons with no dependencies (zlib + a tiny PNG writer).
// Design: black field, a yellow dot (the listener) with sound arcs reaching each ear.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function icon(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x supersampling for smooth edges
      let cover = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const dx = (x + (sx + 0.5) / 2 - cx) / size;
          const dy = (y + (sy + 0.5) / 2 - cy) / size;
          const r = Math.hypot(dx, dy);
          const ang = Math.atan2(dx, -dy); // 0 = straight up
          let on = r < 0.075;
          if (Math.abs(Math.abs(ang) - Math.PI / 2) < 0.6)
            for (const ring of [0.16, 0.25, 0.34]) if (Math.abs(r - ring) < 0.028) on = true;
          if (on) cover++;
        }
      const a = cover / 4;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      px[i] = Math.round(255 * a);
      px[i + 1] = Math.round(214 * a);
      px[i + 2] = Math.round(10 * a);
      px[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(px)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) writeFileSync(join(out, `icon-${size}.png`), icon(size));
console.log('icons written to', out);
