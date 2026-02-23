import fs from 'fs';
import path from 'path';
import os from 'os';

function getConfigDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'remote-clauding');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'remote-clauding');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'remote-clauding');
  }
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

export function getConfig() {
  try {
    const data = fs.readFileSync(getConfigPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export function saveConfig(data) {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
  // Restrict permissions on Unix
  if (process.platform !== 'win32') {
    fs.chmodSync(configPath, 0o600);
  }
}

export function clearConfig() {
  try {
    fs.unlinkSync(getConfigPath());
  } catch {}
}

// --- PID file for background agent ---

function getPidPath() {
  return path.join(getConfigDir(), 'agent.pid');
}

export function savePid(pid) {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getPidPath(), String(pid));
}

export function readPid() {
  try {
    return parseInt(fs.readFileSync(getPidPath(), 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

export function clearPid() {
  try {
    fs.unlinkSync(getPidPath());
  } catch {}
}

export function isAgentRunning() {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch {
    clearPid();
    return false;
  }
}

export { getConfigDir };
