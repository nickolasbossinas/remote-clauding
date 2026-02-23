import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const dest = join(__dirname, '..', 'src-tauri', 'resources', 'npm-package');

// Clean and recreate
if (existsSync(dest)) {
  rmSync(dest, { recursive: true });
}
mkdirSync(dest, { recursive: true });

// Copy package files
const items = ['package.json', 'bin', 'lib', 'assets'];
for (const item of items) {
  const src = join(repoRoot, item);
  if (!existsSync(src)) {
    console.warn(`Warning: ${item} not found at ${src}, skipping`);
    continue;
  }
  const target = join(dest, item);
  cpSync(src, target, { recursive: true });
  console.log(`Copied ${item}`);
}

// Copy vsix if it exists
const vsixSrc = join(repoRoot, 'vsix');
if (existsSync(vsixSrc)) {
  cpSync(vsixSrc, join(dest, 'vsix'), { recursive: true });
  console.log('Copied vsix');
}

console.log('Bundle complete:', dest);
