#!/usr/bin/env node
import { program } from 'commander';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

const MANAGEMENT_COMMANDS = new Set(['start', 'stop', 'login', 'register', 'logout', 'setup', 'status']);
const COMMANDER_FLAGS = new Set(['--help', '-h', '--version', '-V']);
const firstArg = process.argv[2];

if (!firstArg || (!MANAGEMENT_COMMANDS.has(firstArg) && !COMMANDER_FLAGS.has(firstArg))) {
  // No subcommand — launch interactive CLI or background agent
  const { getConfig } = await import('../lib/config.js');
  const config = getConfig();
  if (config.environments && config.environments.includes('cli')) {
    await import('../cli/remote-clauding.js');
    // CLI keeps the process alive via its own event loop — never fall through
  } else {
    if (!config.auth_token) {
      console.error('Not logged in. Run: remote-clauding login');
      process.exit(1);
    }
    const { startAgent } = await import('../lib/agent.js');
    await startAgent({ ...config });
    process.exit(0);
  }
} else {
  // Management subcommands via Commander
  program
    .name('remote-clauding')
    .description('Share Claude Code sessions to your phone')
    .version(pkg.version);

  program
    .command('start')
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
    .command('stop')
    .description('Stop the Remote Clauding agent')
    .action(async () => {
      const { readPid, clearPid } = await import('../lib/config.js');
      const pid = readPid();
      if (!pid) { console.log('Agent is not running.'); process.exit(0); }
      try {
        process.kill(pid, 'SIGTERM');
        clearPid();
        console.log('Agent stopped.');
      } catch {
        clearPid();
        console.log('Agent was not running.');
      }
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
}
