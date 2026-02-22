import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public');

const BG = '#1a1a2e';
const FG = '#e0e0e0';

function createSvg(size) {
  const fontSize = Math.round(size * 0.32);
  const y = Math.round(size * 0.58);
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.15)}" fill="${BG}"/>
  <text x="50%" y="${y}" text-anchor="middle" font-family="monospace, Courier" font-weight="bold" font-size="${fontSize}" fill="${FG}">RC</text>
</svg>`;
}

for (const size of [192, 512]) {
  await sharp(Buffer.from(createSvg(size)))
    .png()
    .toFile(path.join(outDir, `icon-${size}.png`));
  console.log(`Generated icon-${size}.png`);
}
