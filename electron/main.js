import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalServerController } from './localServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'Claude GUI';
const APP_USER_MODEL_ID = 'ai.cloudcli.desktop';

// 保留旧桌面配置路径，使改名安装后仍能使用原有的本地设置。
app.setPath('userData', path.join(app.getPath('appData'), 'CloudCLI'));
app.setName(APP_NAME);

let mainWindow = null;
let localServer = null;
let localOrigin = null;
let isQuitting = false;

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

function isLocalNavigation(url) {
  try {
    return new URL(url).origin === localOrigin;
  } catch {
    return false;
  }
}

function openExternalUrl(url) {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
}

async function createWindow() {
  const appRoot = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#fafafa',
    icon: path.join(appRoot, process.platform === 'darwin'
      ? 'electron/assets/logo-macos.png'
      : 'electron/assets/logo-windows.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const window = mainWindow;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isLocalNavigation(url)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isLocalNavigation(url)) event.preventDefault();
  });

  const url = await localServer.ensureLocalServer();
  localOrigin = new URL(url).origin;
  await window.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('activate', () => {
    if (!mainWindow && localServer && !isQuitting) {
      void createWindow().catch(showStartupError);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (isQuitting || !localServer?.hasOwnedServer()) return;
    event.preventDefault();
    isQuitting = true;
    void localServer.shutdownOwnedServer().finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]) : null);

    localServer = new LocalServerController({
      appRoot: app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..'),
      settingsPath: path.join(app.getPath('userData'), 'desktop-settings.json'),
      isPackaged: app.isPackaged,
      appVersion: app.getVersion(),
      localSession: true,
    });

    ipcMain.handle('cloudcli-desktop:get-local-session', (event) => {
      // Only the top-level page of this window may obtain the local credential.
      if (event.sender !== mainWindow?.webContents
        || event.senderFrame !== event.sender.mainFrame
        || !isLocalNavigation(event.senderFrame.url)) {
        throw new Error('Local desktop session is unavailable to this page.');
      }
      return localServer.getDesktopSession();
    });

    await createWindow();
  }).catch(showStartupError);
}

async function showStartupError(error) {
  console.error('Local desktop startup failed:', error);
  await dialog.showMessageBox({
    type: 'error',
    title: APP_NAME,
    message: '无法启动本地页面',
    detail: error instanceof Error ? error.message : String(error),
  });
  app.quit();
}
