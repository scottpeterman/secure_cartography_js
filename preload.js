/**
 * sc-js-electron — Preload Script
 *
 * Exposes a safe IPC API to the renderer via contextBridge.
 * The renderer accesses everything through window.scjs.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scjs', {

  // ── Discovery ──

  startDiscovery: (config) => ipcRenderer.invoke('discovery:start', config),
  stopDiscovery: () => ipcRenderer.invoke('discovery:stop'),

  onDiscoveryEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('discovery:event', handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener('discovery:event', handler);
  },

  // ── Topology ──

  loadMapJson: (filePath) => ipcRenderer.invoke('topology:load-map', filePath),
  getOutputMap: (outputDir) => ipcRenderer.invoke('topology:get-output-map', outputDir),

  // ── Dialogs ──

  openFile: (options) => ipcRenderer.invoke('dialog:open-file', options || {}),
  selectDirectory: (options) => ipcRenderer.invoke('dialog:select-directory', options || {}),
  saveFile: (options) => ipcRenderer.invoke('dialog:save-file', options || {}),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),

});
