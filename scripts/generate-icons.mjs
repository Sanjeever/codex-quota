import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build', 'assets');
const tauriIconDir = join(root, 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });
mkdirSync(tauriIconDir, { recursive: true });

const sourceSvg = readFileSync(join(root, 'build', 'icon-source', 'codex-quota.svg'), 'utf8');
writeFileSync(join(outDir, 'codex-quota.svg'), sourceSvg);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function png(width, height, draw) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = draw(x / (width - 1), y / (height - 1), x, y, width, height);
      const index = rowStart + 1 + x * 4;
      raw[index] = r;
      raw[index + 1] = g;
      raw[index + 2] = b;
      raw[index + 3] = a;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function roundedRectMask(x, y, radius) {
  const dx = Math.max(Math.abs(x - 0.5) - 0.5 + radius, 0);
  const dy = Math.max(Math.abs(y - 0.5) - 0.5 + radius, 0);
  return dx * dx + dy * dy <= radius * radius;
}

function iconDraw(error = false) {
  return (nx, ny) => {
    if (!roundedRectMask(nx, ny, 0.18)) return [0, 0, 0, 0];
    const bg = ny < 0.52 ? [20, 25, 22] : [13, 16, 14];
    const frame = nx > 0.17 && nx < 0.83 && ny > 0.29 && ny < 0.71;
    const inner = nx > 0.22 && nx < 0.78 && ny > 0.36 && ny < 0.64;
    const midLine = Math.abs(ny - 0.5) < 0.032 && nx > 0.18 && nx < 0.82;
    const bar1 = nx > 0.33 && nx < 0.4 && ny > 0.34 && ny < 0.66;
    const bar2 = nx > 0.48 && nx < 0.55 && ny > 0.34 && ny < 0.66;
    const bar3 = nx > 0.64 && nx < 0.71 && ny > 0.34 && ny < 0.66;
    const dot = (nx - 0.78) ** 2 + (ny - 0.3) ** 2 < 0.006;

    if ((frame && !inner) || midLine) return [219, 231, 210, 255];
    if (bar1 || bar2) return [95, 210, 138, 255];
    if (bar3 || (error && dot)) return [255, 111, 97, 255];
    if (dot) return [95, 210, 138, 255];
    return [bg[0], bg[1], bg[2], 255];
  };
}

function trayDraw(error = false) {
  return (nx, ny) => {
    const cx = nx - 0.5;
    const cy = ny - 0.5;
    if (cx * cx + cy * cy > 0.22) return [0, 0, 0, 0];
    if (Math.abs(cx) < 0.07 && Math.abs(cy) < 0.27) return error ? [255, 111, 97, 255] : [255, 255, 255, 255];
    if (Math.abs(cx - 0.17) < 0.06 && Math.abs(cy) < 0.23) return [255, 255, 255, 255];
    if (Math.abs(cy) < 0.04 && Math.abs(cx) < 0.31) return [255, 255, 255, 255];
    return [0, 0, 0, 0];
  };
}

function icoFromPngs(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.width >= 256 ? 0 : image.width;
    entry[1] = image.height >= 256 ? 0 : image.height;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

function icnsBlock(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

function icnsFromPng(pngData) {
  const body = Buffer.concat([icnsBlock('ic10', pngData)]);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

const appPng256 = png(256, 256, iconDraw(false));
const appPng512 = png(512, 512, iconDraw(false));
const appPng1024 = png(1024, 1024, iconDraw(false));
const trayNormal = png(32, 32, trayDraw(false));
const trayError = png(32, 32, trayDraw(true));

writeFileSync(join(outDir, 'app.png'), appPng512);
writeFileSync(join(outDir, 'app.ico'), icoFromPngs([{ width: 256, height: 256, data: appPng256 }]));
writeFileSync(join(outDir, 'app.icns'), icnsFromPng(appPng1024));
writeFileSync(join(outDir, 'tray-normal.png'), trayNormal);
writeFileSync(join(outDir, 'tray-error.png'), trayError);

writeFileSync(join(tauriIconDir, '32x32.png'), png(32, 32, iconDraw(false)));
writeFileSync(join(tauriIconDir, '128x128.png'), png(128, 128, iconDraw(false)));
writeFileSync(join(tauriIconDir, '128x128@2x.png'), appPng256);
writeFileSync(join(tauriIconDir, 'icon.png'), appPng512);
writeFileSync(join(tauriIconDir, 'icon.ico'), icoFromPngs([{ width: 256, height: 256, data: appPng256 }]));
writeFileSync(join(tauriIconDir, 'icon.icns'), icnsFromPng(appPng1024));
