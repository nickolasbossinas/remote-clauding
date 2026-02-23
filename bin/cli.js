#!/usr/bin/env node
import { program } from 'commander';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

program
  .name('remote-clauding')
  .description('Share Claude Code sessions to your phone')
  .version(pkg.version);

program
  .command('start', { isDefault: true })
  .description('Start the Remote Clauding agent')
  .option('-p, --port <port>', 'HTTP port', '9680')
  .action(async (opts) => {
    const { getConfig } = await import('../lib/config.js');
    const config = getConfig();
    if (!config.auth_token) {
      console.error('Not logged in. Run: remote-clauding login');
      process.exit(1);
    }
    const { startAgent } = await import('../lib/agent.js');
    await startAgent({ ...config, port: parseInt(opts.port, 10) });
  });

program
  .command('login')
  .description('Log in with email and password')
  .action(async () => {
    const { loginCommand } = await import('../lib/auth.js');
    await loginCommand();
  });

program
  .command('register')
  .description('Create a new account')
  .action(async () => {
    const { registerCommand } = await import('../lib/auth.js');
    await registerCommand();
  });

program
  .command('logout')
  .description('Log out and stop the agent')
  .action(async () => {
    const { logoutCommand } = await import('../lib/auth.js');
    logoutCommand();
  });

program
  .command('setup')
  .description('Install the VSCode extension')
  .action(async () => {
    const { setupCommand } = await import('../lib/setup.js');
    setupCommand();
  });

program
  .command('status')
  .description('Show agent and relay connection status')
  .action(async () => {
    const { statusCommand } = await import('../lib/status.js');
    await statusCommand();
  });

program.parse();
