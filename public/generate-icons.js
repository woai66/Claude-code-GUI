import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const publicDir = path.dirname(fileURLToPath(import.meta.url));
const svg = await fs.readFile(path.join(publicDir, 'logo.svg'), 'utf8');
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const desktopDir = path.resolve(publicDir, '../electron/assets');

async function renderPng(size) {
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
}

await fs.mkdir(path.join(publicDir, 'icons'), { recursive: true });
await fs.mkdir(desktopDir, { recursive: true });
await fs.writeFile(path.join(publicDir, 'favicon.svg'), svg);
await fs.writeFile(path.join(publicDir, 'favicon.png'), await renderPng(64));
await fs.writeFile(path.join(publicDir, 'icons/icon-template.svg'), svg);

for (const size of sizes) {
  const name = `icon-${size}x${size}`;
  const sizedSvg = svg.replace('width="128" height="128"', `width="${size}" height="${size}"`);
  await fs.writeFile(path.join(publicDir, 'icons', `${name}.svg`), sizedSvg);
  await fs.writeFile(path.join(publicDir, 'icons', `${name}.png`), await renderPng(size));
}

for (const size of [32, 64, 128, 256, 512]) {
  await fs.writeFile(path.join(publicDir, `logo-${size}.png`), await renderPng(size));
}

// PNG-backed ICO entries keep the same source artwork at every Windows shell size.
const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(iconSizes.map(renderPng));
const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
for (let index = 0; index < images.length; index++) {
  const entry = 6 + index * 16;
  const size = iconSizes[index];
  directory[entry] = size === 256 ? 0 : size;
  directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await fs.writeFile(path.join(desktopDir, 'logo-windows.ico'), Buffer.concat([directory, ...images]));
console.log('Generated web, PWA, and Windows icons from public/logo.svg');
