const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('erpDesktop', {
  platform: process.platform,
  preflight: () => ipcRenderer.invoke('system:preflight'),
  installRequirement: (id) => ipcRenderer.invoke('requirements:install', id),
  startDocker: () => ipcRenderer.invoke('requirements:start-docker'),
  preparePlan: (config) => ipcRenderer.invoke('install:prepare', config),
  startInstall: (config) => ipcRenderer.invoke('install:start', config),
  workspaceStatus: () => ipcRenderer.invoke('workspace:status'),
  removeWorkspace: (options) => ipcRenderer.invoke('workspace:remove', options),
  openAppsSettings: () => ipcRenderer.invoke('system:open-apps-settings'),
  openUrl: (url) => ipcRenderer.invoke('system:open-url', url),
  onInstallEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('install:event', listener);
    return () => ipcRenderer.removeListener('install:event', listener);
  }
});
