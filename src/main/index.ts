import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import {
  AppConfig,
  ClaudeState,
  deriveKeyRoles,
  StatusSnapshot,
} from '../shared/types';
import { loadConfig, saveConfig } from './config';
import { HookServer } from './claude/hook-server';
import {
  areHooksInstalled,
  installHooks,
  uninstallHooks,
} from './claude/hook-installer';
import { ClaudeStateMachine } from './claude/state-machine';
import { DeviceHost } from './device/device-host';
import { HotkeyManager } from './input/hotkeys';

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;

let config: AppConfig;
let stateMachine: ClaudeStateMachine;
let hookServer: HookServer;
let deviceHost: DeviceHost;
let hotkeys: HotkeyManager;

function assetPath(...parts: string[]): string {
  const root = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../..');
  return path.join(root, 'assets', ...parts);
}

function trayIconFor(state: ClaudeState) {
  return nativeImage.createFromPath(assetPath('tray', `${state}.png`));
}

function currentStatus(): StatusSnapshot {
  return {
    aggregateState: stateMachine.aggregateState,
    sessions: stateMachine.snapshots,
    deviceConnected: deviceHost.connected,
    protocolReady: deviceHost.protocolReady,
    hookServerPort: hookServer.port,
    hooksInstalled: areHooksInstalled(config.port),
  };
}

function broadcastStatus(): void {
  const status = currentStatus();
  updateTray(status);
  settingsWindow?.webContents.send('status-changed', status);
}

function updateTray(status: StatusSnapshot): void {
  if (!tray) return;
  tray.setImage(trayIconFor(status.aggregateState));
  const bits = [
    `Claude: ${status.aggregateState}`,
    status.deviceConnected ? 'XPAD connected' : 'XPAD not found',
  ];
  tray.setToolTip(`XPAD Mini × Claude Code — ${bits.join(', ')}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: bits[0], enabled: false },
      { label: bits[1], enabled: false },
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettingsWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function openSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'XPAD Mini × Claude Code',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.on('closed', () => (settingsWindow = null));
  if (process.env.ELECTRON_RENDERER_URL) {
    void settingsWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void settingsWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function applyConfig(next: AppConfig): void {
  const prevPort = config?.port;
  config = next;
  stateMachine.setDoneDecaySeconds(next.doneDecaySeconds);
  deviceHost.applyConfig(next.states, deriveKeyRoles(next.keys), next.ledBrightness);
  hotkeys.apply(next);
  app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
  if (prevPort !== undefined && prevPort !== next.port) {
    void hookServer.start(next.port).catch((err) => {
      console.error('[hook-server] restart failed', err);
    });
  }
  broadcastStatus();
}

function registerIpc(): void {
  ipcMain.handle('get-status', () => currentStatus());
  ipcMain.handle('get-config', () => config);
  ipcMain.handle('set-config', (_e, next: AppConfig) => {
    applyConfig(saveConfig(next));
    return config;
  });
  ipcMain.handle('simulate-state', (_e, state: ClaudeState) => {
    stateMachine.simulate(state);
  });
  ipcMain.handle('install-hooks', () => {
    const result = installHooks(config.port);
    broadcastStatus();
    return result;
  });
  ipcMain.handle('uninstall-hooks', () => {
    uninstallHooks();
    broadcastStatus();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());

  app.whenReady().then(async () => {
    config = loadConfig();

    stateMachine = new ClaudeStateMachine(config.doneDecaySeconds);
    hookServer = new HookServer(stateMachine);
    deviceHost = new DeviceHost();
    hotkeys = new HotkeyManager();
    hotkeys.onKeyPress((keyId, executed) => {
      if (!executed) return;
      const type = config.keys[keyId].type;
      if (type === 'approve') deviceHost.oneShot('approve');
      else if (type === 'reject') deviceHost.oneShot('reject');
      else if (type === 'hotkey') deviceHost.oneShot('dictation');
    });

    stateMachine.on('change', (state: ClaudeState) => {
      deviceHost.setState(state);
      broadcastStatus();
    });
    deviceHost.on('status', broadcastStatus);

    registerIpc();

    tray = new Tray(trayIconFor('idle'));
    tray.on('double-click', () => openSettingsWindow());

    // Shared per-user art dir (fixed name on purpose: dev and packaged apps
    // have different userData names, but must read the same imported art).
    const externalArtDir = path.join(
      app.getPath('appData'),
      'xpad-mini-claude-code',
      'clawd-external'
    );
    deviceHost.start(
      assetPath(),
      externalArtDir,
      config.states,
      deriveKeyRoles(config.keys),
      config.ledBrightness
    );
    hotkeys.apply(config);
    try {
      await hookServer.start(config.port);
      console.log(`[hook-server] listening on 127.0.0.1:${config.port}`);
    } catch (err) {
      console.error('[hook-server] failed to start', err);
    }

    broadcastStatus();
    // Tray app: keep running with no windows. Show settings on first launch
    // so there's something visible.
    openSettingsWindow();
  });

  // Tray app: don't quit when the settings window closes.
  app.on('window-all-closed', () => {});

  // Hold quit until the worker has blanked the pad (bounded so a wedged
  // worker can't hang exit).
  let shuttingDown = false;
  app.on('will-quit', (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    hotkeys?.unregisterAll();
    void hookServer?.stop();
    const finish = () => app.exit(0);
    setTimeout(finish, 1500);
    deviceHost?.shutdown().then(finish, finish);
  });
}
