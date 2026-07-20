/**
 * Device worker thread: owns all XPAD Mini HID I/O and both animation
 * engines, keeping their timing off the (busy) Electron main thread so LED
 * and LCD animations stay smooth.
 *
 * Spawned by DeviceHost with workerData { assetRoot }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ClaudeState, HidTarget, KeyRoles, StateStyle } from '../../shared/types';
import { XpadDevice } from './hid';
import {
  BACKLIGHT_COUNT,
  KEY_LED_COUNT,
  LCD_HEIGHT,
  LCD_WIDTH,
  XpadProtocol,
} from './protocol';
import { LedEngine } from './led-engine';
import { ClawdRole, LcdEngine } from './lcd-engine';

export type WorkerInMessage =
  | { type: 'setState'; state: ClaudeState }
  | { type: 'oneShot'; role: Extract<ClawdRole, 'approve' | 'reject' | 'dictation'> }
  | {
      type: 'applyConfig';
      states: Record<ClaudeState, StateStyle>;
      keyRoles: KeyRoles;
      ledBrightness: number;
      padAutoRemap: boolean;
      padKeyTargets: (HidTarget | null)[];
    }
  | { type: 'shutdown' };

export interface WorkerOutMessage {
  type: 'status';
  connected: boolean;
  protocolReady: boolean;
}

const port = parentPort;
if (!port) throw new Error('device-worker must run in a worker thread');

const {
  assetRoot,
  externalDir,
  states,
  keyRoles,
  ledBrightness,
  padAutoRemap,
  padKeyTargets,
} = workerData as {
  assetRoot: string;
  externalDir: string;
  states: Record<ClaudeState, StateStyle>;
  keyRoles: KeyRoles;
  ledBrightness: number;
  padAutoRemap: boolean;
  padKeyTargets: (HidTarget | null)[];
};

const device = new XpadDevice();
const protocol = new XpadProtocol(device);
const ledEngine = new LedEngine(protocol, states);
const lcdEngine = new LcdEngine(protocol, assetRoot, externalDir);

ledEngine.setKeyRoles(keyRoles);
ledEngine.setBrightness(ledBrightness);
lcdEngine.loadAssets();

let autoRemap = padAutoRemap;
let keyTargets = padKeyTargets;
// Map the pad keys to their configured emissions on every (re)connect,
// RAM-only. Engines pause during the reads: concurrent LED/LCD streaming
// garbles responses.
protocol.onReady = () => {
  if (!autoRemap) return;
  ledEngine.stop();
  lcdEngine.stop();
  void protocol
    .remapPadKeys(keyTargets)
    .catch((err) => console.error('[worker] pad remap failed', err))
    .finally(() => {
      ledEngine.start();
      lcdEngine.start();
    });
};

let lastStatus = '';
function reportStatus(): void {
  const msg: WorkerOutMessage = {
    type: 'status',
    connected: device.connected,
    protocolReady: protocol.ready,
  };
  const key = JSON.stringify(msg);
  if (key === lastStatus) return;
  lastStatus = key;
  port!.postMessage(msg);
}

device.on('connect', reportStatus);
device.on('disconnect', reportStatus);
// protocol.ready flips asynchronously after ScreenInfo; poll cheaply.
const statusTimer = setInterval(reportStatus, 500);

port.on('message', (msg: WorkerInMessage) => {
  switch (msg.type) {
    case 'setState':
      ledEngine.setState(msg.state);
      lcdEngine.setState(msg.state);
      break;
    case 'oneShot':
      lcdEngine.playOneShot(msg.role);
      break;
    case 'applyConfig': {
      ledEngine.setStyles(msg.states);
      ledEngine.setKeyRoles(msg.keyRoles);
      ledEngine.setBrightness(msg.ledBrightness);
      const turnedOn = !autoRemap && msg.padAutoRemap;
      const targetsChanged =
        JSON.stringify(keyTargets) !== JSON.stringify(msg.padKeyTargets);
      autoRemap = msg.padAutoRemap;
      keyTargets = msg.padKeyTargets;
      if ((turnedOn || targetsChanged) && autoRemap && protocol.ready) {
        protocol.onReady?.();
      }
      break;
    }
    case 'shutdown':
      void shutdown();
  }
});

/**
 * Leave the pad dark instead of frozen on our last frame. The firmware's own
 * screen/effects stay suppressed until replug (see docs/PROTOCOL.md), so dark
 * is the cleanest hand-off we can do without flash writes.
 */
async function shutdown(): Promise<void> {
  clearInterval(statusTimer);
  ledEngine.stop();
  lcdEngine.stop();
  try {
    const black = { r: 0, g: 0, b: 0 };
    protocol.setLeds(Array(BACKLIGHT_COUNT + KEY_LED_COUNT).fill(black));
    await protocol.drawLcdFrame(Buffer.alloc(LCD_WIDTH * LCD_HEIGHT * 2));
  } catch {
    // Device may already be gone; dark hand-off is best-effort.
  }
  device.stop();
  process.exit(0);
}

device.start();
ledEngine.start();
lcdEngine.start();
reportStatus();
