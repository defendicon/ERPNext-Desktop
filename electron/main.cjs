const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const installer = require('./installer.cjs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#071914',
    titleBarStyle: 'hiddenInset',
    title: 'ERPNext Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL || (app.isPackaged ? null : 'http://127.0.0.1:5173');
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('system:preflight', () => installer.preflight());
  ipcMain.handle('requirements:install', (_event, id) => installer.installRequirement(id, (payload) => mainWindow?.webContents.send('install:event', payload)));
  ipcMain.handle('requirements:start-docker', () => installer.startDockerDesktop());
  ipcMain.handle('install:prepare', (_event, config) => installer.makePlan(config, path.join(app.getPath('userData'), 'instances', 'default')));
  ipcMain.handle('install:start', async (_event, config) => installer.install(config, app.getPath('userData'), (payload) => mainWindow?.webContents.send('install:event', payload)));
  ipcMain.handle('workspace:status', () => installer.workspaceStatus(app.getPath('userData')));
  ipcMain.handle('workspace:remove', (_event, options) => installer.removeWorkspace(app.getPath('userData'), options, (payload) => mainWindow?.webContents.send('install:event', payload)));
  ipcMain.handle('system:open-url', (_event, url) => shell.openExternal(url));
  ipcMain.handle('system:open-apps-settings', () => shell.openExternal('ms-settings:appsfeatures'));
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
