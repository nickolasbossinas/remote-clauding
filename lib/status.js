import { getConfig } from './config.js';

export async function statusCommand() {
  const config = getConfig();

  console.log('Remote Clauding Status');
  console.log('----------------------');

  // Account
  if (config.email) {
    console.log(`Account:  ${config.email}`);
  } else {
    console.log('Account:  not logged in');
  }

  // Agent
  try {
    const res = await fetch('http://127.0.0.1:9680/health', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    console.log(`Agent:    running (port 9680)`);
  } catch {
    console.log('Agent:    not running');
  }

  // Relay
  try {
    const res = await fetch('https://claude.iptinno.com/health', { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    console.log(`Relay:    reachable (claude.iptinno.com)`);
  } catch {
    console.log('Relay:    unreachable');
  }
}
