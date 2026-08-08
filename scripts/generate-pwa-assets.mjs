import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, '..');
const publicDir = join(projectRoot, 'public');
const iconsDir = join(publicDir, 'assets', 'icons');
const screenshotsDir = join(publicDir, 'assets', 'screenshots');

mkdirSync(iconsDir, { recursive: true });
mkdirSync(screenshotsDir, { recursive: true });

const iconSizes = [72, 96, 128, 144, 152, 180, 192, 384, 512];
const faviconSizes = [16, 32, 48];
const maskableSizes = [192, 512];
const crcTable = createCrcTable();

function main() {
  for (const size of iconSizes) {
    writePng(join(iconsDir, `icon-${size}.png`), drawIcon(size, false));
  }

  for (const size of maskableSizes) {
    writePng(join(iconsDir, `icon-maskable-${size}.png`), drawIcon(size, true));
  }

  writePng(join(iconsDir, 'apple-touch-icon.png'), drawIcon(180, false));
  writePng(join(iconsDir, 'favicon-16.png'), drawIcon(16, false));
  writePng(join(iconsDir, 'favicon-32.png'), drawIcon(32, false));
  writePng(join(screenshotsDir, 'pixel-city-wide.png'), drawWideScreenshot());

  writeFileSync(
    join(publicDir, 'favicon.ico'),
    encodeIco(faviconSizes.map((size) => ({ size, png: encodePng(drawIcon(size, false)) }))),
  );

  console.log(`Generated ${iconSizes.length + maskableSizes.length + 4} PWA image assets.`);
}

function drawIcon(size, maskable) {
  const canvas = createImage(64, 64, '#0a0a0f');
  verticalGradient(canvas, '#07101d', '#111827');

  fillRect(canvas, 0, 26, 64, 12, '#171922');
  fillRect(canvas, 26, 0, 12, 64, '#171922');
  fillRect(canvas, 30, 0, 2, 7, '#ffcc33');
  fillRect(canvas, 30, 12, 2, 7, '#ffcc33');
  fillRect(canvas, 30, 24, 2, 7, '#ffcc33');
  fillRect(canvas, 30, 43, 2, 7, '#ffcc33');
  fillRect(canvas, 30, 55, 2, 7, '#ffcc33');
  fillRect(canvas, 3, 31, 8, 2, '#d8dee9');
  fillRect(canvas, 16, 31, 8, 2, '#d8dee9');
  fillRect(canvas, 40, 31, 8, 2, '#d8dee9');
  fillRect(canvas, 53, 31, 8, 2, '#d8dee9');

  drawBuilding(canvas, 5, 5, 16, 18, '#263850', '#75e6ff');
  drawBuilding(canvas, 42, 6, 15, 17, '#3a2a4d', '#ff72c8');
  drawBuilding(canvas, 6, 42, 16, 15, '#203829', '#79f28d');
  drawBuilding(canvas, 43, 43, 15, 14, '#4b3724', '#ffd166');

  fillRect(canvas, 27, 39, 10, 16, '#e24040');
  fillRect(canvas, 29, 42, 6, 8, '#ffdf74');
  fillRect(canvas, 27, 39, 2, 3, '#f4f4f8');
  fillRect(canvas, 35, 39, 2, 3, '#f4f4f8');
  fillRect(canvas, 24, 45, 2, 4, '#0a0a0f');
  fillRect(canvas, 38, 45, 2, 4, '#0a0a0f');

  fillRect(canvas, 46, 28, 3, 3, '#ffcc33');
  fillRect(canvas, 43, 31, 9, 3, '#ffcc33');
  fillRect(canvas, 45, 34, 5, 5, '#ffcc33');
  fillRect(canvas, 47, 26, 1, 11, '#fff3a3');

  if (!maskable) {
    fillRect(canvas, 0, 0, 64, 2, '#ffcc33');
    fillRect(canvas, 0, 62, 64, 2, '#ffcc33');
    fillRect(canvas, 0, 0, 2, 64, '#ffcc33');
    fillRect(canvas, 62, 0, 2, 64, '#ffcc33');
  }

  return scaleNearest(canvas, size, size);
}

function drawWideScreenshot() {
  const canvas = createImage(1280, 720, '#070912');
  verticalGradient(canvas, '#09111f', '#111827');

  fillRect(canvas, 0, 0, 1280, 72, '#070912');
  fillRect(canvas, 0, 648, 1280, 72, '#070912');
  fillTrapezoid(canvas, 0, 720, 522, 758, 382, 898, '#171922');
  fillRect(canvas, 0, 310, 1280, 96, '#171922');
  fillRect(canvas, 616, 0, 48, 720, '#ffcc33');
  fillRect(canvas, 0, 352, 1280, 12, '#ffcc33');

  for (let x = 70; x < 1180; x += 170) {
    fillRect(canvas, x, 352, 78, 12, '#d8dee9');
  }

  for (let y = 28; y < 700; y += 92) {
    fillRect(canvas, 616, y, 48, 36, '#111827');
  }

  const buildings = [
    [76, 104, 190, 154, '#263850', '#75e6ff'],
    [318, 96, 146, 164, '#3a2a4d', '#ff72c8'],
    [830, 92, 180, 168, '#203829', '#79f28d'],
    [1044, 118, 142, 142, '#4b3724', '#ffd166'],
    [90, 454, 170, 128, '#24324f', '#9fb7ff'],
    [306, 456, 160, 132, '#3f243c', '#ff72c8'],
    [806, 452, 190, 132, '#23382e', '#79f28d'],
    [1040, 450, 150, 136, '#4b3724', '#ffd166'],
  ];

  for (const [x, y, width, height, color, light] of buildings) {
    drawLargeBuilding(canvas, x, y, width, height, color, light);
  }

  drawCar(canvas, 590, 492, '#e24040');
  drawCar(canvas, 704, 252, '#4aa3ff');
  drawCar(canvas, 1020, 328, '#ffd166');
  drawCar(canvas, 210, 370, '#79f28d');

  fillRect(canvas, 34, 30, 310, 80, '#0a0a0f', 220);
  strokeRect(canvas, 34, 30, 310, 80, '#ffcc33', 4);
  drawPixelText(canvas, 58, 50, 'PIXEL CITY', 5, '#ffcc33');
  drawPixelText(canvas, 60, 88, 'OFFLINE READY', 2, '#f4f4f8');

  fillRect(canvas, 930, 34, 310, 82, '#0a0a0f', 220);
  strokeRect(canvas, 930, 34, 310, 82, '#2e3446', 4);
  drawPixelText(canvas, 958, 56, 'WANTED', 3, '#f4f4f8');
  for (let i = 0; i < 5; i += 1) {
    drawStar(canvas, 1092 + i * 26, 58, 18, '#ffcc33');
  }

  return canvas;
}

function drawBuilding(canvas, x, y, width, height, color, light) {
  fillRect(canvas, x, y, width, height, color);
  fillRect(canvas, x + 2, y + 2, width - 4, 2, lighten(color));
  for (let row = y + 5; row < y + height - 3; row += 5) {
    for (let col = x + 4; col < x + width - 3; col += 6) {
      fillRect(canvas, col, row, 2, 2, light);
    }
  }
}

function drawLargeBuilding(canvas, x, y, width, height, color, light) {
  fillRect(canvas, x, y, width, height, color);
  fillRect(canvas, x, y, width, 8, lighten(color));
  strokeRect(canvas, x, y, width, height, '#06070d', 4);
  for (let row = y + 22; row < y + height - 18; row += 26) {
    for (let col = x + 18; col < x + width - 18; col += 34) {
      fillRect(canvas, col, row, 14, 12, light, 210);
    }
  }
}

function drawCar(canvas, x, y, color) {
  fillRect(canvas, x, y, 38, 72, color);
  fillRect(canvas, x + 8, y + 14, 22, 30, '#ffdf74');
  fillRect(canvas, x + 4, y, 8, 10, '#f4f4f8');
  fillRect(canvas, x + 26, y, 8, 10, '#f4f4f8');
  fillRect(canvas, x - 8, y + 20, 8, 16, '#05070d');
  fillRect(canvas, x + 38, y + 20, 8, 16, '#05070d');
  fillRect(canvas, x - 8, y + 48, 8, 16, '#05070d');
  fillRect(canvas, x + 38, y + 48, 8, 16, '#05070d');
}

function drawStar(canvas, x, y, size, color) {
  const center = Math.floor(size / 2);
  fillRect(canvas, x + center - 2, y, 4, size, color);
  fillRect(canvas, x, y + center - 2, size, 4, color);
  fillRect(canvas, x + 4, y + 4, size - 8, size - 8, color);
}

const font = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
};

function drawPixelText(canvas, x, y, text, scale, color) {
  let cursor = x;
  for (const character of text) {
    const glyph = font[character] ?? font[' '];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === '1') {
          fillRect(canvas, cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += (glyph[0].length + 1) * scale;
  }
}

function createImage(width, height, color) {
  const image = { width, height, data: Buffer.alloc(width * height * 4) };
  fillRect(image, 0, 0, width, height, color);
  return image;
}

function verticalGradient(canvas, topColor, bottomColor) {
  const top = parseColor(topColor);
  const bottom = parseColor(bottomColor);
  for (let y = 0; y < canvas.height; y += 1) {
    const ratio = y / Math.max(1, canvas.height - 1);
    const color = [
      Math.round(top[0] + (bottom[0] - top[0]) * ratio),
      Math.round(top[1] + (bottom[1] - top[1]) * ratio),
      Math.round(top[2] + (bottom[2] - top[2]) * ratio),
      255,
    ];
    fillRectRgba(canvas, 0, y, canvas.width, 1, color);
  }
}

function fillTrapezoid(canvas, topY, bottomY, topLeft, topRight, bottomLeft, bottomRight, color) {
  const y0 = Math.max(0, Math.floor(topY));
  const y1 = Math.min(canvas.height, Math.ceil(bottomY));
  for (let y = y0; y < y1; y += 1) {
    const ratio = (y - topY) / Math.max(1, bottomY - topY);
    const left = Math.round(topLeft + (bottomLeft - topLeft) * ratio);
    const right = Math.round(topRight + (bottomRight - topRight) * ratio);
    fillRect(canvas, left, y, right - left, 1, color);
  }
}

function fillRect(canvas, x, y, width, height, color, alpha = 255) {
  fillRectRgba(canvas, x, y, width, height, [...parseColor(color), alpha]);
}

function fillRectRgba(canvas, x, y, width, height, rgba) {
  const startX = Math.max(0, Math.floor(x));
  const startY = Math.max(0, Math.floor(y));
  const endX = Math.min(canvas.width, Math.ceil(x + width));
  const endY = Math.min(canvas.height, Math.ceil(y + height));

  for (let row = startY; row < endY; row += 1) {
    for (let col = startX; col < endX; col += 1) {
      const offset = (row * canvas.width + col) * 4;
      const alpha = rgba[3] / 255;
      canvas.data[offset] = Math.round(rgba[0] * alpha + canvas.data[offset] * (1 - alpha));
      canvas.data[offset + 1] = Math.round(rgba[1] * alpha + canvas.data[offset + 1] * (1 - alpha));
      canvas.data[offset + 2] = Math.round(rgba[2] * alpha + canvas.data[offset + 2] * (1 - alpha));
      canvas.data[offset + 3] = 255;
    }
  }
}

function strokeRect(canvas, x, y, width, height, color, thickness) {
  fillRect(canvas, x, y, width, thickness, color);
  fillRect(canvas, x, y + height - thickness, width, thickness, color);
  fillRect(canvas, x, y, thickness, height, color);
  fillRect(canvas, x + width - thickness, y, thickness, height, color);
}

function scaleNearest(source, width, height) {
  const target = createImage(width, height, '#000000');
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y / height) * source.height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x / width) * source.width));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      target.data[targetOffset] = source.data[sourceOffset];
      target.data[targetOffset + 1] = source.data[sourceOffset + 1];
      target.data[targetOffset + 2] = source.data[sourceOffset + 2];
      target.data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }
  return target;
}

function lighten(color) {
  const [red, green, blue] = parseColor(color);
  return rgbToHex(Math.min(255, red + 24), Math.min(255, green + 24), Math.min(255, blue + 24));
}

function parseColor(color) {
  const hex = color.startsWith('#') ? color.slice(1) : color;
  const full = hex.length === 3 ? [...hex].map((part) => part + part).join('') : hex;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function writePng(path, image) {
  writeFileSync(path, encodePng(image));
}

function encodePng(image) {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);

  for (let y = 0; y < image.height; y += 1) {
    const rawOffset = y * (stride + 1);
    raw[rawOffset] = 0;
    image.data.copy(raw, rawOffset + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = 6 + directory.length;

  images.forEach((image, index) => {
    const entryOffset = index * 16;
    directory[entryOffset] = image.size >= 256 ? 0 : image.size;
    directory[entryOffset + 1] = image.size >= 256 ? 0 : image.size;
    directory[entryOffset + 2] = 0;
    directory[entryOffset + 3] = 0;
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.png.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

main();
