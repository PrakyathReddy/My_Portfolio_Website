#!/usr/bin/env node
/**
 * Generate the app icons.
 *
 * Written as code rather than checked in as binaries so the mark can be
 * recoloured in one line and regenerated, instead of being an opaque blob
 * nobody can reproduce once the original design file is lost.
 *
 * The mark: two overlapping circles, one per person, in their avatar accents.
 * The overlap is the journal - it is the only part that belongs to both.
 *
 * PNG is written by hand (zlib is the only thing needed) to keep the project
 * dependency-free.
 *
 *   node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PAPER = [0xf7, 0xf3, 0xee];
const LEFT = [0x4a, 0x6f, 0xa5];  // Prakyath
const RIGHT = [0xc2, 0x84, 0x7a]; // Shivani
const SS = 4;                     // supersampling factor for anti-aliasing

// --- PNG encoding ------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** rgba: Buffer of width*height*4 bytes. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 (None) is plenty for
  // flat art like this and keeps the encoder trivial.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- The mark ----------------------------------------------------------------

/** Source-over composite of a straight-alpha colour onto an opaque base. */
function over(base, colour, alpha) {
  return [
    Math.round(colour[0] * alpha + base[0] * (1 - alpha)),
    Math.round(colour[1] * alpha + base[1] * (1 - alpha)),
    Math.round(colour[2] * alpha + base[2] * (1 - alpha)),
  ];
}

/**
 * @param size    output edge length in pixels
 * @param inset   fraction of the canvas to leave as padding. Maskable icons
 *                get a bigger inset so the mark survives Android cropping the
 *                corners into a circle.
 */
function drawIcon(size, inset) {
  const rgba = Buffer.alloc(size * size * 4);
  const n = size * SS;

  // Circle geometry, in supersampled units.
  const pad = n * inset;
  const usable = n - pad * 2;
  const radius = usable * 0.30;
  const cy = n / 2;
  const cxLeft = pad + usable * 0.36;
  const cxRight = pad + usable * 0.64;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Coverage of each circle over this output pixel, by supersampling.
      let hitsLeft = 0;
      let hitsRight = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;
          if ((px - cxLeft) ** 2 + (py - cy) ** 2 <= radius ** 2) hitsLeft++;
          if ((px - cxRight) ** 2 + (py - cy) ** 2 <= radius ** 2) hitsRight++;
        }
      }

      const samples = SS * SS;
      let colour = PAPER;
      // Left first, right over it at 85% so the overlap reads as a third,
      // blended tone rather than one circle simply winning.
      if (hitsLeft) colour = over(colour, LEFT, hitsLeft / samples);
      if (hitsRight) colour = over(colour, RIGHT, (hitsRight / samples) * 0.85);

      const i = (y * size + x) * 4;
      rgba[i] = colour[0];
      rgba[i + 1] = colour[1];
      rgba[i + 2] = colour[2];
      rgba[i + 3] = 255;
    }
  }

  return encodePng(size, size, rgba);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Mana Muchatlu">
  <rect width="512" height="512" fill="#f7f3ee"/>
  <circle cx="205" cy="256" r="123" fill="#4a6fa5"/>
  <circle cx="307" cy="256" r="123" fill="#c2847a" opacity="0.85"/>
</svg>
`;

// --- Write -------------------------------------------------------------------

const outDir = path.join(__dirname, '..', 'web', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  ['icon-192.png', 192, 0.10],
  ['icon-512.png', 512, 0.10],
  ['icon-maskable-512.png', 512, 0.20], // wider safe zone for Android masking
  ['apple-touch-icon.png', 180, 0.10],
];

for (const [name, size, inset] of targets) {
  const png = drawIcon(size, inset);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`  ${name.padEnd(26)} ${size}x${size}  ${png.length} bytes`);
}

fs.writeFileSync(path.join(outDir, 'icon.svg'), SVG);
console.log(`  ${'icon.svg'.padEnd(26)} vector    ${SVG.length} bytes`);
