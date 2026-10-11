const { contextBridge, ipcRenderer } = require('electron');

if (window.location.protocol === 'http:' && (
  window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
)) {
  contextBridge.exposeInMainWorld('cloudcliDesktopSession', {
    getSession: () => ipcRenderer.invoke('cloudcli-desktop:get-local-session'),
  });
}
