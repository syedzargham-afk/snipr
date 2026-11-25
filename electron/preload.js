const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grabit', {
  getInitialState: () => ipcRenderer.invoke('grabit:getInitialState'),
  runSetup: () => ipcRenderer.invoke('grabit:runSetup'),
  readClipboard: () => ipcRenderer.invoke('grabit:readClipboard'),
  copyText: (text) => ipcRenderer.invoke('grabit:copyText', text),
  fetchMetadata: (url) => ipcRenderer.invoke('grabit:fetchMetadata', url),
  startDownload: (payload) => ipcRenderer.invoke('grabit:startDownload', payload),
  pauseDownload: () => ipcRenderer.invoke('grabit:pauseDownload'),
  resumeDownload: () => ipcRenderer.invoke('grabit:resumeDownload'),
  cancelDownload: () => ipcRenderer.invoke('grabit:cancelDownload'),
  removeFromQueue: (id) => ipcRenderer.invoke('grabit:removeFromQueue', id),
  clearQueue: () => ipcRenderer.invoke('grabit:clearQueue'),
  probeFile: (filePath) => ipcRenderer.invoke('grabit:probeFile', filePath),
  createStreamUrl: (filePath) => ipcRenderer.invoke('grabit:createStreamUrl', filePath),
  getBridgeAuth: () => ipcRenderer.invoke('grabit:getBridgeAuth'),
  regenerateBridgeToken: () => ipcRenderer.invoke('grabit:regenerateBridgeToken'),
  setExtensionId: (extensionId) => ipcRenderer.invoke('grabit:setExtensionId', extensionId),
  convertToH264: (payload) => ipcRenderer.invoke('grabit:convertToH264', payload),
  openFile: (filePath) => ipcRenderer.invoke('grabit:openFile', filePath),
  openFolder: (targetPath) => ipcRenderer.invoke('grabit:openFolder', targetPath),
  openExtensionFolder: () => ipcRenderer.invoke('grabit:openExtensionFolder'),
  getSettings: () => ipcRenderer.invoke('grabit:getSettings'),
  updateSettings: (patch) => ipcRenderer.invoke('grabit:updateSettings', patch),
  pickFolder: () => ipcRenderer.invoke('grabit:pickFolder'),
  getHistory: () => ipcRenderer.invoke('grabit:getHistory'),
  deleteHistory: (id) => ipcRenderer.invoke('grabit:deleteHistory', id),
  clearHistory: () => ipcRenderer.invoke('grabit:clearHistory'),

  onDownloadProgress: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('grabit:downloadState', handler);
    return () => ipcRenderer.removeListener('grabit:downloadState', handler);
  },

  onQueueUpdated: (callback) => {
    const handler = (_event, queue) => callback(queue);
    ipcRenderer.on('grabit:queueUpdated', handler);
    return () => ipcRenderer.removeListener('grabit:queueUpdated', handler);
  },

  onHistoryUpdated: (callback) => {
    const handler = (_event, list) => callback(list);
    ipcRenderer.on('grabit:historyUpdated', handler);
    return () => ipcRenderer.removeListener('grabit:historyUpdated', handler);
  },

  onSetupProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('grabit:setupProgress', handler);
    return () => ipcRenderer.removeListener('grabit:setupProgress', handler);
  },

  onExtensionEvent: (callback) => {
    const handler = (_event, ev) => callback(ev);
    ipcRenderer.on('grabit:extensionEvent', handler);
    return () => ipcRenderer.removeListener('grabit:extensionEvent', handler);
  },
});
