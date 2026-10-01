const { contextBridge, ipcRenderer } = require('electron');

// The renderer can report pending local edits; it cannot invoke desktop tools.
contextBridge.exposeInMainWorld('opengeoDesktop', Object.freeze({
  setDraftProtectionPending(value) {
    if (typeof value === 'boolean') ipcRenderer.send('opengeo:draft-pending', value);
  },
  onQuitDeferred(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('opengeo:quit-deferred', listener);
    return () => ipcRenderer.removeListener('opengeo:quit-deferred', listener);
  },
}));
