/**
 * Device worker thread: owns all XPAD Mini HID I/O and both animation
 * engines, keeping their timing off the (busy) Electron main thread so LED
 * and LCD animations stay smooth.
 *
 * Spawned by DeviceHost with workerData { assetRoot }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ClaudeState, KeyRoles, StateStyle } from '../../shared/types';
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
    }
  | { type: 'shutdown' };

export interface WorkerOutMessage {
  type: 'status';
  connected: boolean;
  protocolReady: boolean;
}

const port = parentPort;
if (!port) throw new Error('device-worker must run in a worker thread');

const { assetRoot, externalDir, states, keyRoles, ledBrightness } = workerData as {
  assetRoot: string;
  externalDir: string;
  states: Record<ClaudeState, StateStyle>;
  keyRoles: KeyRoles;
  ledBrightness: number;
};

const device = new XpadDevice();
const protocol = new XpadProtocol(device);
const ledEngine = new LedEngine(protocol, states);
const lcdEngine = new LcdEngine(protocol, assetRoot, externalDir);

ledEngine.setKeyRoles(keyRoles);
ledEngine.setBrightness(ledBrightness);
// The LED engine mirrors what Clawd is doing: 'building' gets the orbit.
lcdEngine.setAnimationListener((name) => {
  ledEngine.setOverlay(name === 'building' ? 'orbit' : null);
});
lcdEngine.loadAssets();

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
    case 'applyConfig':
      ledEngine.setStyles(msg.states);
      ledEngine.setKeyRoles(msg.keyRoles);
      ledEngine.setBrightness(msg.ledBrightness);
      break;
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
