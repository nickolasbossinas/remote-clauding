import systrayModule from 'systray2';
const SysTray = systrayModule.default || systrayModule;
import { readFileSync, appendFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(process.env.APPDATA || process.env.HOME || '.', 'remote-clauding', 'agent.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] [Tray] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(logFile, line); } catch {}
}

export class TrayManager extends EventEmitter {
  constructor() {
    super();
    this.systray = null;
    this.sessionCount = 0;
    this.relayConnected = false;
    this.sessionItem = null;
    this.relayItem = null;
    this.exitItem = null;
  }

  start() {
    log(`start() called — PID=${process.pid}, PPID=${process.ppid}, CWD=${process.cwd()}`);

    const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
    log(`Icon path: ${iconPath}`);
    const iconBase64 = readFileSync(iconPath).toString('base64');
    log(`Icon loaded, base64 length=${iconBase64.length}`);

    this.sessionItem = {
      title: 'Sessions: 0',
      tooltip: 'Active Claude sessions',
      enabled: false,
      checked: false,
    };

    this.relayItem = {
      title: 'Relay: disconnected',
      tooltip: 'Relay server connection',
      enabled: false,
      checked: false,
    };

    this.launchCliItem = {
      title: 'Launch CLI',
      tooltip: 'Open the Remote Clauding terminal',
      enabled: true,
      checked: false,
    };

    this.exitItem = {
      title: 'Exit',
      tooltip: 'Shut down the agent',
      enabled: true,
      checked: false,
    };

    log('Creating SysTray instance');
    this.systray = new SysTray({
      menu: {
        icon: iconBase64,
        title: '',
        tooltip: 'Remote Clauding Agent',
        items: [
          this.sessionItem,
          this.relayItem,
          SysTray.separator,
          this.launchCliItem,
          this.exitItem,
        ],
      },
      debug: false,
      copyDir: false,
    });
    log('SysTray instance created');

    this.systray.onClick((action) => {
      if (action.item === this.launchCliItem) {
        this.emit('launch-cli');
      } else if (action.item === this.exitItem) {
        this.emit('exit');
      }
    });

    const readyTimeout = setTimeout(() => {
      log('WARNING: ready() has not resolved after 10s — tray binary may have failed');
      const proc = this.systray.process;
      if (proc) {
        log(`Tray binary: pid=${proc.pid}, killed=${proc.killed}, exitCode=${proc.exitCode}`);
      } else {
        log('Tray binary: process not yet spawned (null)');
      }
    }, 10000);

    return this.systray.ready().then(() => {
      clearTimeout(readyTimeout);
      const proc = this.systray.process;
      log(`ready() resolved — binPath=${this.systray.binPath}, tray PID=${proc?.pid}`);
      if (proc) {
        proc.on('exit', (code, signal) => {
          log(`Tray binary exited — code=${code}, signal=${signal}`);
        });
        proc.on('error', (err) => {
          log(`Tray binary error — ${err.message}`);
        });
        if (proc.stderr) {
          proc.stderr.on('data', (data) => {
            log(`Tray binary stderr: ${data.toString().trim()}`);
          });
        }
      }
    });
  }

  updateSessionCount(count) {
    if (!this.systray) return;
    this.sessionCount = count;
    this.sessionItem.title = `Sessions: ${count}`;
    this.systray.sendAction({
      type: 'update-item',
      item: this.sessionItem,
      seq_id: 0,
    });
  }

  updateRelayStatus(connected) {
    if (!this.systray) return;
    this.relayConnected = connected;
    this.relayItem.title = `Relay: ${connected ? 'connected' : 'disconnected'}`;
    this.systray.sendAction({
      type: 'update-item',
      item: this.relayItem,
      seq_id: 1,
    });
  }

  kill() {
    log(`kill() called — systray=${this.systray ? 'exists' : 'null'}`);
    if (this.systray) {
      const proc = this.systray.process;
      log(`Tray binary at kill: pid=${proc?.pid}, killed=${proc?.killed}`);
      this.systray.kill(false);
    }
  }
}
