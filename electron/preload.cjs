// Exposes a tiny, safe native bridge to the web UI: just a folder picker.
// Available only inside the Electron app (window.tdNative); in a plain browser
// it's undefined, and the UI falls back to a text input.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tdNative', {
  pickFolder: () => ipcRenderer.invoke('td-pick-folder'),
  showItem: (p) => ipcRenderer.invoke('td-show-item', p),   // reveal a file/folder in Finder/Explorer
  openPath: (p) => ipcRenderer.invoke('td-open-path', p)     // open a folder
});
