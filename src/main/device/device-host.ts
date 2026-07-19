import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ClaudeState, KeyRoles, StateStyle } from '../../shared/types';
import type { WorkerInMessage, WorkerOutMessage } from './device-worker';
import type { ClawdRole } from './lcd-engine';

/**
 * Main-thread proxy for the device worker. All XPAD I/O and animation timing
 * happens in the worker; this class just forwards commands and re-emits
 * status ('status' event) for the tray/UI.
 */
export class DeviceHost extends EventEmitter {
  private worker: Worker | null = null;
  connected = false;
  protocolReady = false;

  start(
    assetRoot: string,
    externalDir: string,
    states: Record<ClaudeState, StateStyle>,
    keyRoles: KeyRoles,
    ledBrightness: number
  ): void {
    this.worker = new Worker(path.join(__dirname, 'device-worker.js'), {
      workerData: { assetRoot, externalDir, states, keyRoles, ledBrightness },
    });
    this.worker.on('message', (msg: WorkerOutMessage) => {
      if (msg.type === 'status') {
        this.connected = msg.connected;
        this.protocolReady = msg.protocolReady;
        this.emit('status');
      }
    });
    this.worker.on('error', (err) => {
      console.error('[device-host] worker error', err);
    });
    this.worker.on('exit', (code) => {
      if (code !== 0) console.error(`[device-host] worker exited with ${code}`);
      this.connected = false;
      this.protocolReady = false;
      this.emit('status');
    });
  }

  setState(state: ClaudeState): void {
    this.send({ type: 'setState', state });
  }

  oneShot(role: Extract<ClawdRole, 'approve' | 'reject' | 'dictation'>): void {
    this.send({ type: 'oneShot', role });
  }

  applyConfig(
    states: Record<ClaudeState, StateStyle>,
    keyRoles: KeyRoles,
    ledBrightness: number
  ): void {
    this.send({ type: 'applyConfig', states, keyRoles, ledBrightness });
  }

  /**
   * Asks the worker to blank the pad and exit; resolves once it has. The
   * caller should bound this with a timeout in case the worker is wedged.
   */
  shutdown(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return Promise.resolve();
    return new Promise((resolve) => {
      worker.once('exit', () => resolve());
      try {
        worker.postMessage({ type: 'shutdown' } satisfies WorkerInMessage);
      } catch {
        resolve();
      }
    });
  }

  private send(msg: WorkerInMessage): void {
    try {
      this.worker?.postMessage(msg);
    } catch (err) {
      console.error('[device-host] postMessage failed', err);
    }
  }
}
