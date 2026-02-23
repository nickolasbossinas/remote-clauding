import { createInterface } from 'readline/promises';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig, saveConfig, clearConfig, isAgentRunning, readPid, clearPid } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY_API = 'https://claude.iptinno.com';

function startAgentBackground() {
  if (isAgentRunning()) {
    console.log('Agent is already running.');
    return;
  }

  const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');
  const child = spawn(process.execPath, [cliPath, 'start'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log('Agent started in background.');
}

function stopAgent() {
  const pid = readPid();
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
    console.log('Agent stopped.');
  } catch {
    // Process already gone
  }
  clearPid();
}

function readPassword(prompt) {
  // If not a TTY (piped input), fall back to plain readline
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return rl.question(prompt).then((answer) => { rl.close(); return answer; });
  }

  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const chars = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(chars.join(''));
      } else if (ch === '\u0003') {
        // Ctrl+C
        process.stdin.setRawMode(false);
        process.exit(0);
      } else if (ch === '\u007f' || ch === '\b') {
        // Backspace
        if (chars.length > 0) {
          chars.pop();
          process.stdout.write('\b \b');
        }
      } else {
        chars.push(ch);
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

export async function loginCommand() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const email = await rl.question('Email: ');
    rl.close();
    const password = await readPassword('Password: ');

    if (!email || !password) {
      console.error('Email and password are required.');
      process.exit(1);
    }

    const res = await fetch(`${RELAY_API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`Login failed: ${data.error}`);
      process.exit(1);
    }

    saveConfig({ auth_token: data.auth_token, email });
    console.log(`Logged in as ${email}.`);
    startAgentBackground();
  } catch (err) {
    rl.close();
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

export async function registerCommand() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const email = await rl.question('Email: ');
    rl.close();
    const password = await readPassword('Password: ');
    const confirm = await readPassword('Confirm password: ');

    if (password !== confirm) {
      console.error('Passwords do not match.');
      process.exit(1);
    }

    if (!email || !password) {
      console.error('Email and password are required.');
      process.exit(1);
    }

    // Register
    const regRes = await fetch(`${RELAY_API}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const regData = await regRes.json();

    if (!regRes.ok) {
      console.error(`Registration failed: ${regData.error}`);
      process.exit(1);
    }

    console.log(regData.message);

    // If we got a token directly (no verification/moderation), save and done
    if (regData.auth_token) {
      saveConfig({ auth_token: regData.auth_token, email });
      console.log(`Logged in as ${email}.`);
      startAgentBackground();
      return;
    }

    // Check if email verification is needed
    if (regData.message && regData.message.includes('verify')) {
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      const code = await rl2.question('Verification code (check your email): ');
      rl2.close();

      const verifyRes = await fetch(`${RELAY_API}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: code.trim() }),
      });

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok) {
        console.error(`Verification failed: ${verifyData.error}`);
        process.exit(1);
      }

      console.log(verifyData.message);

      if (verifyData.auth_token) {
        saveConfig({ auth_token: verifyData.auth_token, email });
        console.log(`Logged in as ${email}.`);
        startAgentBackground();
      }
    }
  } catch (err) {
    console.error('Registration failed:', err.message);
    process.exit(1);
  }
}

export function logoutCommand() {
  stopAgent();
  clearConfig();
  console.log('Logged out.');
}
