/**
 * sc-js-electron — Main Process
 *
 * Runs the discovery engine, forwards events to the renderer via IPC,
 * handles native dialogs and file system operations.
 *
 * The engine is I/O-bound (UDP sockets), not CPU-bound, so it runs
 * directly on the main process event loop — no worker thread needed.
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// Engine imports
const { DiscoveryEngine } = require('./src/engine');
const { DiscoveryEmitter } = require('./src/events');
const { buildCredsFromArgs } = require('./src/creds');
const { loadSttLookup } = require('./src/stt-gen');
const { EventType } = require('./src/events');

let mainWindow = null;
let splashWindow = null;
let activeEngine = null;
let activeEmitter = null;


// =========================================================================
// Logging
// =========================================================================

function log(tag, ...args) {
  const ts = new Date().toISOString().substr(11, 12);
  console.log(`[${ts}] [${tag}]`, ...args);
}

function logError(tag, ...args) {
  const ts = new Date().toISOString().substr(11, 12);
  console.error(`[${ts}] [${tag}]`, ...args);
}


// =========================================================================
// Application Menu
// =========================================================================

function buildAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // macOS app menu (required for Cmd+Q, Cmd+H, etc.)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),

    // Edit — preserves clipboard shortcuts on all platforms
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },

    // View — DevTools toggle + zoom
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Cmd+Option+I' : 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.toggleDevTools();
            }
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // Window
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  log('app', 'Application menu built');
}


// =========================================================================
// Splash Screen
// =========================================================================

function createSplashWindow() {
  log('app', 'Creating splash window');

  splashWindow = new BrowserWindow({
    width: 580,
    height: 380,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splashWindow.loadFile('splash.html');
}


// =========================================================================
// Window
// =========================================================================

function createWindow() {
  log('app', 'Creating window');

  buildAppMenu();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,  // Hidden until splash finishes
    title: 'Secure Cartography',
    backgroundColor: '#0a0e14',
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile('index.html');

  // When main window content is ready, swap from splash to main
  mainWindow.once('ready-to-show', () => {
    // Splash animation runs ~5.2s total. Ensure it completes
    // even if the main window loads faster.
    const SPLASH_DURATION_MS = 5200;
    const elapsed = Date.now() - splashStartedAt;
    const remaining = Math.max(0, SPLASH_DURATION_MS - elapsed);

    log('app', `Main window ready (splash elapsed: ${elapsed}ms, holding: ${remaining}ms)`);

    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      mainWindow.show();
      mainWindow.focus();
      log('app', 'Splash → main window swap complete');
    }, remaining);
  });

  // F12 DevTools toggle — works everywhere, even when menu is hidden
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    log('app', 'DevTools opened');
  }

  mainWindow.on('closed', () => {
    log('app', 'Window closed');
    mainWindow = null;
    stopDiscovery();
  });

  log('app', `CWD: ${process.cwd()}`);
  log('app', `__dirname: ${__dirname}`);
}

let splashStartedAt = 0;

app.whenReady().then(() => {
  splashStartedAt = Date.now();
  createSplashWindow();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    splashStartedAt = Date.now();
    createSplashWindow();
    createWindow();
  }
});


// =========================================================================
// Safe IPC Send
// =========================================================================

/**
 * Send an event to the renderer. JSON round-trips the data to strip
 * anything Electron's structured clone can't handle (Buffers, Maps,
 * circular refs from net-snmp walker, etc.).
 */
function sendEvent(type, data) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('ipc', `Window gone, dropping: ${type}`);
    return;
  }

  try {
    const safe = JSON.parse(JSON.stringify(data || {}));
    mainWindow.webContents.send('discovery:event', { type, data: safe });
  } catch (e) {
    logError('ipc', `Serialization failed for ${type}:`, e.message);
    // Send a stripped-down version so the renderer still gets the event type
    try {
      mainWindow.webContents.send('discovery:event', {
        type,
        data: { _error: `Serialization failed: ${e.message}` },
      });
    } catch (e2) {
      logError('ipc', `Fallback send also failed for ${type}:`, e2.message);
    }
  }
}


// =========================================================================
// Discovery Engine IPC
// =========================================================================

ipcMain.handle('discovery:start', async (event, config) => {
  log('discovery', '--- START REQUESTED ---');
  log('discovery', `Mode: ${config.mode}`);
  log('discovery', `Seeds: ${config.seeds.join(', ')}`);
  log('discovery', `Communities: ${(config.communities || []).join(', ') || '(none)'}`);
  log('discovery', `v3User: ${config.v3User || '(none)'}`);
  log('discovery', `MaxDepth: ${config.maxDepth}, Timeout: ${config.timeout}`);
  log('discovery', `OutputDir: ${config.outputDir || '(none)'}`);
  log('discovery', `STT: ${config.sttFile || '(none)'}`);

  if (activeEngine) {
    logError('discovery', 'Engine already running — rejecting');
    return { error: 'Discovery already running' };
  }

  try {
    // ── Credentials ──
    const credOpts = {
      community: config.communities || [],
      v3User: config.v3User || null,
      v3AuthPass: config.v3AuthPass || '',
      v3PrivPass: config.v3PrivPass || '',
      v3AuthProto: config.v3AuthProto || 'sha',
      v3PrivProto: config.v3PrivProto || 'aes',
    };
    const credProvider = buildCredsFromArgs(credOpts);
    const snmpCreds = credProvider.getSnmpCredentials();
    log('discovery', `Credentials built: ${snmpCreds.length} SNMP (${snmpCreds.map(c => c.name).join(', ')})`);

    // ── STT ──
    let sttLookup = null;
    if (config.sttFile) {
      try {
        sttLookup = loadSttLookup(config.sttFile);
        log('discovery', `STT loaded: ${sttLookup.size} mappings`);
        sendEvent('log_message', {
          message: `Loaded ${sttLookup.size} STT proxy mappings`,
          level: 'info',
        });
      } catch (e) {
        logError('discovery', `STT load failed: ${e.message}`);
        sendEvent('log_message', { message: `STT load error: ${e.message}`, level: 'error' });
        return { error: `STT file error: ${e.message}` };
      }
    }

    // ── Emitter ──
    activeEmitter = new DiscoveryEmitter();
    let eventCount = 0;

    for (const type of Object.values(EventType)) {
      activeEmitter.on(type, (data) => {
        eventCount++;
        // Log topology_updated and crawl_complete specially (they're big)
        if (type === 'crawl_complete') {
          log('event', `#${eventCount} crawl_complete — discovered:${data.discovered} failed:${data.failed} duration:${data.durationSeconds}s`);
        } else if (type === 'topology_updated') {
          log('event', `#${eventCount} topology_updated — ${data.deviceCount || '?'} devices`);
        } else if (type === 'device_complete') {
          log('event', `#${eventCount} device_complete — ${data.hostname}`);
        } else if (type === 'device_failed') {
          log('event', `#${eventCount} device_failed — ${data.target}: ${data.error}`);
        }
        // Forward to renderer (sendEvent handles serialization safely)
        sendEvent(type, data);
      });
    }
    log('discovery', `Emitter wired for ${Object.keys(EventType).length} event types`);

    // ── Engine ──
    activeEngine = new DiscoveryEngine({
      credentialProvider: credProvider,
      timeout: config.timeout || 5,
      verbose: config.verbose || false,
      noDns: config.noDns || false,
      maxConcurrent: parseInt(config.maxConcurrent, 10) || 20,
      events: activeEmitter,
      sttLookup,
      peerExclude: config.peerExclude || [],
    });
    log('discovery', 'Engine created');

    // ── Resolve output dir ──
    const outputDir = config.outputDir ? path.resolve(config.outputDir) : null;
    if (outputDir) {
      log('discovery', `Output dir resolved: ${outputDir}`);
    }

    // ── Run ──
    const crawlPromise = (config.mode === 'discover')
      ? runDiscover({ ...config, outputDir })
      : runCrawl({ ...config, outputDir });

    log('discovery', `${config.mode} started async`);

    crawlPromise
      .then((result) => {
        log('discovery', `--- CRAWL RESOLVED ---`);
        log('discovery', `Result: ${JSON.stringify(result)}`);

        const payload = {
          success: true,
          deviceCount: result.deviceCount || 0,
          outputDir: outputDir,
        };
        log('discovery', `Sending discovery:done: ${JSON.stringify(payload)}`);
        sendEvent('discovery:done', payload);
        log('discovery', 'discovery:done sent successfully');
      })
      .catch((err) => {
        logError('discovery', `--- CRAWL REJECTED ---`);
        logError('discovery', `Error: ${err.message}`);
        logError('discovery', `Stack: ${err.stack}`);

        sendEvent('discovery:done', {
          success: false,
          error: err.message,
        });
        log('discovery', 'discovery:done (failure) sent');
      })
      .finally(() => {
        log('discovery', `--- CLEANUP --- (${eventCount} events emitted total)`);
        activeEngine = null;
        activeEmitter = null;
      });

    return { started: true };

  } catch (e) {
    logError('discovery', `Setup exception: ${e.message}`);
    logError('discovery', `Stack: ${e.stack}`);
    activeEngine = null;
    activeEmitter = null;
    return { error: e.message };
  }
});


// =========================================================================
// Engine Runners
// =========================================================================

async function runCrawl(config) {
  log('crawl', `Starting — seeds:${config.seeds.join(',')} depth:${config.maxDepth} output:${config.outputDir}`);

  const result = await activeEngine.crawl({
    seeds: config.seeds,
    maxDepth: parseInt(config.maxDepth, 10) || 3,
    domains: config.domains || [],
    excludePatterns: config.excludePatterns || [],
    outputDir: config.outputDir || null,
  });

  const summary = {
    deviceCount: result.devices.length,
    successful: result.devices.filter(d => d.discoverySuccess).length,
    failed: result.devices.filter(d => !d.discoverySuccess).length,
    durationSeconds: result.durationSeconds,
  };

  log('crawl', `Complete — ${summary.deviceCount} devices (${summary.successful} ok, ${summary.failed} failed) in ${summary.durationSeconds}s`);
  return summary;
}

async function runDiscover(config) {
  log('discover', `Starting — target:${config.seeds[0]}`);

  const device = await activeEngine.discoverDevice(config.seeds[0], {
    domains: config.domains || [],
    collectArp: true,
  });

  if (config.outputDir) {
    await fs.mkdir(config.outputDir, { recursive: true });
    await activeEngine._saveDeviceFiles(device, config.outputDir);
    log('discover', `Files saved to ${config.outputDir}`);
  }

  const success = device.discoverySuccess;
  log('discover', `Complete — ${success ? 'OK' : 'FAILED'}: ${device.hostname || device.ipAddress}`);

  return {
    deviceCount: success ? 1 : 0,
  };
}


// =========================================================================
// Stop / Cancel
// =========================================================================

ipcMain.handle('discovery:stop', async () => {
  log('discovery', 'Stop requested');
  stopDiscovery();
  return { stopped: true };
});

function stopDiscovery() {
  if (activeEmitter) {
    activeEmitter.crawlCancelled();
    log('discovery', 'Cancelled emitter');
  }
  activeEngine = null;
  activeEmitter = null;
}


// =========================================================================
// Topology Data IPC
// =========================================================================

ipcMain.handle('topology:load-map', async (event, filePath) => {
  log('topology', `load-map: ${filePath}`);
  try {
    const resolved = path.resolve(filePath);
    log('topology', `Resolved: ${resolved}`);
    const content = await fs.readFile(resolved, 'utf-8');
    const data = JSON.parse(content);
    log('topology', `Loaded: ${Object.keys(data).length} top-level keys`);
    return { data };
  } catch (e) {
    logError('topology', `load-map failed: ${e.message}`);
    return { error: e.message };
  }
});

ipcMain.handle('topology:get-output-map', async (event, outputDir) => {
  log('topology', `get-output-map: ${outputDir}`);
  try {
    const resolved = path.resolve(outputDir);
    const mapPath = path.join(resolved, 'map.json');
    log('topology', `Reading: ${mapPath}`);
    const content = await fs.readFile(mapPath, 'utf-8');
    const data = JSON.parse(content);
    log('topology', `Loaded: ${Object.keys(data).length} devices from map.json`);
    return { data };
  } catch (e) {
    logError('topology', `get-output-map failed: ${e.message}`);
    return { error: e.message };
  }
});


// =========================================================================
// Native Dialogs
// =========================================================================

ipcMain.handle('dialog:open-file', async (event, options) => {
  log('dialog', `open-file: type=${options.type || 'any'}`);
  const filters = {
    json: [{ name: 'JSON Files', extensions: ['json'] }],
    yaml: [{ name: 'YAML Files', extensions: ['yaml', 'yml'] }],
    any: [{ name: 'All Files', extensions: ['*'] }],
  };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Open File',
    filters: filters[options.type] || filters.any,
    properties: ['openFile'],
  });

  if (result.canceled) {
    log('dialog', 'Cancelled');
    return { canceled: true };
  }
  log('dialog', `Selected: ${result.filePaths[0]}`);
  return { path: result.filePaths[0] };
});

ipcMain.handle('dialog:select-directory', async (event, options) => {
  log('dialog', 'select-directory');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Select Directory',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled) {
    log('dialog', 'Cancelled');
    return { canceled: true };
  }
  log('dialog', `Selected: ${result.filePaths[0]}`);
  return { path: result.filePaths[0] };
});

ipcMain.handle('dialog:save-file', async (event, options) => {
  log('dialog', `save-file: default=${options.defaultPath || '(none)'}`);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath || '',
    filters: [
      { name: 'PNG Image', extensions: ['png'] },
      { name: 'SVG Image', extensions: ['svg'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'DrawIO', extensions: ['drawio'] },
    ],
  });

  if (result.canceled) {
    log('dialog', 'Cancelled');
    return { canceled: true };
  }
  log('dialog', `Save to: ${result.filePath}`);
  return { path: result.filePath };
});

ipcMain.handle('fs:write-file', async (event, filePath, content) => {
  log('fs', `write-file: ${filePath} (${content.length} chars)`);
  try {
    await fs.writeFile(filePath, content, 'utf-8');
    log('fs', 'Write OK');
    return { success: true };
  } catch (e) {
    logError('fs', `Write failed: ${e.message}`);
    return { error: e.message };
  }
});