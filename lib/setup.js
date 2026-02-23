import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function setupCommand() {
  const vsixPath = path.join(__dirname, '..', 'vsix', 'remote-clauding.vsix');

  if (!fs.existsSync(vsixPath)) {
    console.error('VSCode extension file not found.');
    console.error(`Expected at: ${vsixPath}`);
    process.exit(1);
  }

  // Check if code CLI exists
  try {
    execSync('code --version', { stdio: 'ignore' });
  } catch {
    console.error('"code" command not found on PATH.');
    console.error('Open VSCode, press Ctrl+Shift+P, and run:');
    console.error('  Shell Command: Install \'code\' command in PATH');
    process.exit(1);
  }

  console.log('Installing Remote Clauding VSCode extension...');
  try {
    execSync(`code --install-extension "${vsixPath}" --force`, { stdio: 'inherit' });
    console.log('VSCode extension installed successfully.');
  } catch {
    console.error('Failed to install VSCode extension.');
    process.exit(1);
  }
}
