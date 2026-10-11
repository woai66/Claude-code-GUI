const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (window.location.protocol === 'http:' && (
  window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
)) {
  contextBridge.exposeInMainWorld('cloudcliDesktopSession', {
    getSession: () => ipcRenderer.invoke('cloudcli-desktop:get-local-session'),
  });
  contextBridge.exposeInMainWorld('claudeGuiDirectories', {
    chooseDirectory: (defaultPath) => ipcRenderer.invoke('claude-gui:choose-directory', defaultPath),
    getDroppedDirectory: (files) => {
      if (!Array.isArray(files) || files.length !== 1) {
        return Promise.resolve({ error: 'single-folder' });
      }
      try {
        // Electron 32+ 不再提供 File.path，由隔离的 preload 解析真实磁盘路径。
        const directoryPath = webUtils.getPathForFile(files[0]);
        return ipcRenderer.invoke('claude-gui:resolve-directory', [directoryPath]);
      } catch {
        return Promise.resolve({ error: 'unavailable' });
      }
    },
  });
}
