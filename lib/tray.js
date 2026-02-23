import systrayModule from 'systray2';
const SysTray = systrayModule.default || systrayModule;
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
    const iconBase64 = readFileSync(iconPath).toString('base64');

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

    this.exitItem = {
      title: 'Exit',
      tooltip: 'Shut down the agent',
      enabled: true,
      checked: false,
    };

    this.systray = new SysTray({
      menu: {
        icon: iconBase64,
        title: '',
        tooltip: 'Remote Clauding Agent',
        items: [
          this.sessionItem,
          this.relayItem,
          SysTray.separator,
          this.exitItem,
        ],
      },
      debug: false,
      copyDir: false,
    });

    this.systray.onClick((action) => {
      if (action.item === this.exitItem) {
        this.emit('exit');
      }
    });

    return this.systray.ready();
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
    if (this.systray) {
      this.systray.kill(false);
    }
  }
}
