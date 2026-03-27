/**
 * sc-js-electron — Renderer Script
 *
 * Wires together:
 *  - Tab navigation between Discovery / Topology / Viewer
 *  - Discovery form → IPC → engine events → xterm terminal
 *  - Topology view with live cytoscape updates
 *  - Standalone map.json viewer with drag-and-drop
 */

'use strict';

// =========================================================================
// State
// =========================================================================

let isRunning = false;
let lastOutputDir = null;
let term = null;
let fitAddon = null;

// Cytoscape viewers (lazy-initialized)
let TopoViewer = null;
let ViewerCy = null;

// Expose to onclick handlers in HTML
window.TopoViewer = null;
window.ViewerCy = null;

// Track file paths for layout persistence
let _viewerFilePath = null;
let _topoFilePath = null;


// =========================================================================
// Layout Persistence (localStorage)
// =========================================================================

const LayoutStore = {
  _prefix: 'sc-layout:',
  _maxAge: 90 * 24 * 60 * 60 * 1000,  // 90 days

  _key(filePath) {
    return this._prefix + filePath;
  },

  save(filePath, viewer, layoutAlgorithm) {
    if (!filePath || !viewer || !viewer.cy) return false;
    try {
      const data = {
        positions: viewer.getPositions(),
        layout: layoutAlgorithm || 'dagre',
        hideUndiscovered: viewer.hideUndiscovered,
        hideLeafNodes: viewer.hideLeafNodes,
        zoom: viewer.cy.zoom(),
        pan: viewer.cy.pan(),
        nodeIds: viewer.cy.nodes().map(n => n.id()).sort(),
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(this._key(filePath), JSON.stringify(data));
      console.log(`[layout] Saved: ${filePath} (${data.nodeIds.length} nodes)`);
      return true;
    } catch (e) {
      console.warn('[layout] Save failed:', e.message);
      return false;
    }
  },

  load(filePath) {
    if (!filePath) return null;
    try {
      const raw = localStorage.getItem(this._key(filePath));
      if (!raw) return null;
      const data = JSON.parse(raw);

      // Age check
      const age = Date.now() - new Date(data.savedAt).getTime();
      if (age > this._maxAge) {
        this.clear(filePath);
        console.log(`[layout] Expired (${Math.round(age / 86400000)}d): ${filePath}`);
        return null;
      }

      console.log(`[layout] Loaded: ${filePath} (${(data.nodeIds || []).length} nodes, saved ${data.savedAt})`);
      return data;
    } catch (e) {
      console.warn('[layout] Load failed:', e.message);
      return null;
    }
  },

  has(filePath) {
    if (!filePath) return false;
    return localStorage.getItem(this._key(filePath)) !== null;
  },

  clear(filePath) {
    if (!filePath) return;
    localStorage.removeItem(this._key(filePath));
    console.log(`[layout] Cleared: ${filePath}`);
  },

  /** Remove all expired layouts (call on startup) */
  prune() {
    const now = Date.now();
    let pruned = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(this._prefix)) continue;
      try {
        const data = JSON.parse(localStorage.getItem(key));
        const age = now - new Date(data.savedAt).getTime();
        if (age > this._maxAge) {
          localStorage.removeItem(key);
          pruned++;
          i--;  // index shifts after removal
        }
      } catch { /* skip corrupt entries */ }
    }
    if (pruned > 0) console.log(`[layout] Pruned ${pruned} expired layouts`);
  },
};

/**
 * Apply a saved layout to a viewer instance.
 * Restores positions, filters, zoom/pan, and layout selector.
 * Returns true if a saved layout was applied.
 */
function restoreLayout(filePath, viewer, prefix) {
  const saved = LayoutStore.load(filePath);
  if (!saved || !saved.positions) return false;

  // Restore filter state to UI + viewer before applying positions
  const hideUndiscEl = document.getElementById(`${prefix}HideUndiscovered`);
  const hideLeafEl = document.getElementById(`${prefix}HideLeaf`);
  if (hideUndiscEl && saved.hideUndiscovered !== undefined) {
    hideUndiscEl.checked = saved.hideUndiscovered;
    viewer.hideUndiscovered = saved.hideUndiscovered;
  }
  if (hideLeafEl && saved.hideLeafNodes !== undefined) {
    hideLeafEl.checked = saved.hideLeafNodes;
    viewer.hideLeafNodes = saved.hideLeafNodes;
  }
  viewer._applyFilters();

  // Restore layout selector
  const layoutSelect = document.getElementById(`${prefix}LayoutSelect`);
  if (layoutSelect && saved.layout) {
    layoutSelect.value = saved.layout;
  }

  // Apply positions
  const result = viewer.applyPositions(saved.positions);
  console.log(`[layout] Restored: ${result.applied} positioned, ${result.missing.length} new`);

  // If new nodes appeared (topology changed), run layout on just those
  if (result.missing.length > 0 && result.applied > 0) {
    console.log(`[layout] New nodes without saved positions: ${result.missing.join(', ')}`);
    // Leave them where they are — user can re-layout if needed
  }

  // Restore zoom/pan
  if (saved.zoom && saved.pan) {
    viewer.cy.viewport({ zoom: saved.zoom, pan: saved.pan });
  }

  updateLayoutStatus(prefix, true);
  return true;
}

function saveLayout(source) {
  const viewer = source === 'topo' ? TopoViewer : ViewerCy;
  const filePath = source === 'topo' ? _topoFilePath : _viewerFilePath;
  const prefix = source === 'topo' ? 'topo' : 'viewer';

  if (!viewer || !filePath) {
    console.warn('[layout] Nothing to save — no viewer or file path');
    return;
  }

  const layoutSelect = document.getElementById(`${prefix}LayoutSelect`);
  const algorithm = layoutSelect ? layoutSelect.value : 'dagre';

  if (LayoutStore.save(filePath, viewer, algorithm)) {
    updateLayoutStatus(prefix, true);
  }
}
window.saveLayout = saveLayout;

function clearLayout(source) {
  const filePath = source === 'topo' ? _topoFilePath : _viewerFilePath;
  const prefix = source === 'topo' ? 'topo' : 'viewer';

  if (filePath) {
    LayoutStore.clear(filePath);
    updateLayoutStatus(prefix, false);
  }
}
window.clearLayout = clearLayout;

function updateLayoutStatus(prefix, hasSaved) {
  const el = document.getElementById(`${prefix}LayoutStatus`);
  if (!el) return;
  if (hasSaved) {
    el.textContent = '✓ Layout saved';
    el.style.color = 'var(--accent-green)';
  } else {
    el.textContent = '';
  }
}


// =========================================================================
// Tab Navigation
// =========================================================================

// Platform map cache (loaded once, shared by both viewers)
let _platformMapData = null;

let _platformMapPromise = null;

function _loadPlatformMap(viewer) {
  if (_platformMapData) {
    viewer.loadPlatformMap(_platformMapData);
    if (typeof DrawIOExport !== 'undefined') DrawIOExport.loadPlatformMap(_platformMapData);
    return Promise.resolve();
  }
  if (!_platformMapPromise) {
    _platformMapPromise = fetch('assets/platform_map.json')
      .then(r => r.json())
      .then(data => {
        _platformMapData = data;
        if (typeof DrawIOExport !== 'undefined') DrawIOExport.loadPlatformMap(data);
      })
      .catch(e => console.warn('Platform map not found, using defaults:', e.message));
  }
  return _platformMapPromise.then(() => {
    if (_platformMapData) viewer.loadPlatformMap(_platformMapData);
  });
}

function switchView(viewName) {
  document.querySelectorAll('.view-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === `view-${viewName}`);
  });

  if (viewName === 'topology' && !TopoViewer) {
    initTopologyView();
  }
  if (viewName === 'viewer' && !ViewerCy) {
    initViewerView();
  }
}

window.switchView = switchView;

document.querySelectorAll('.view-tab').forEach(tab => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});


// =========================================================================
// Terminal (xterm.js)
// =========================================================================

function initTerminal() {
  term = new window.Terminal({
    theme: {
      background: '#0a0e14', foreground: '#e0e6ed',
      cursor: '#00d4ff', cursorAccent: '#0a0e14',
      selectionBackground: 'rgba(0,212,255,0.2)', selectionForeground: '#e0e6ed',
      black: '#0a0e14', red: '#ff4466', green: '#00e88f', yellow: '#ffaa33',
      blue: '#00d4ff', magenta: '#b48eff', cyan: '#00e5c7', white: '#e0e6ed',
      brightBlack: '#556677', brightRed: '#ff6b88', brightGreen: '#33f0a8',
      brightYellow: '#ffcc66', brightBlue: '#33ddff', brightMagenta: '#cc99ff',
      brightCyan: '#33edd4', brightWhite: '#ffffff',
    },
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12, lineHeight: 1.3,
    cursorBlink: false, cursorStyle: 'bar',
    scrollback: 10000, convertEol: true,
  });

  fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();
  writeBanner();

  window.addEventListener('resize', () => fitAddon.fit());
}

function writeBanner() {
  const c = '\x1b[38;2;0;212;255m';
  const m = '\x1b[38;2;85;102;119m';
  const r = '\x1b[0m';
  term.writeln(`${c}┌──────────────────────────────────────────┐${r}`);
  term.writeln(`${c}│${r}  \x1b[1;38;2;0;212;255msc-js${r}${m}.app${r}                               ${c}│${r}`);
  term.writeln(`${c}│${r}  ${m}Network discovery crawler${r}               ${c}│${r}`);
  term.writeln(`${c}└──────────────────────────────────────────┘${r}`);
  term.writeln('');
  term.writeln(`${m}  Configure parameters and click Run Discovery.${r}`);
  term.writeln('');
}

function clearTerminal() {
  term.clear();
  writeBanner();
  document.getElementById('btnViewTopo').style.display = 'none';
}
window.clearTerminal = clearTerminal;


// =========================================================================
// ANSI Formatting for Discovery Events
// =========================================================================

const ANSI = {
  blue: '\x1b[38;2;0;212;255m',
  green: '\x1b[38;2;0;232;143m',
  red: '\x1b[38;2;255;68;102m',
  yellow: '\x1b[38;2;255;170;51m',
  cyan: '\x1b[38;2;0;229;199m',
  muted: '\x1b[38;2;85;102;119m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};


// =========================================================================
// IPC Event Handling
// =========================================================================

function setupIpcListeners() {
  if (!window.scjs) {
    console.warn('scjs preload API not available — running outside Electron?');
    return;
  }

  window.scjs.onDiscoveryEvent(({ type, data }) => {
    handleDiscoveryEvent(type, data);
  });
}

function handleDiscoveryEvent(type, data) {
  switch (type) {
    case 'crawl_started':
      term.writeln('');
      term.writeln(`${ANSI.blue}${ANSI.bold}${'═'.repeat(56)}${ANSI.reset}`);
      term.writeln(`${ANSI.blue}${ANSI.bold}  NETWORK DISCOVERY STARTED${ANSI.reset}`);
      term.writeln(`${ANSI.blue}${ANSI.bold}${'═'.repeat(56)}${ANSI.reset}`);
      term.writeln(`  Seeds: ${data.seeds.join(', ')}`);
      term.writeln(`  Max Depth: ${data.maxDepth}`);
      if (data.domains && data.domains.length) {
        term.writeln(`  Domains: ${data.domains.join(', ')}`);
      }
      term.writeln('');
      break;

    case 'depth_started':
      term.writeln('');
      term.writeln(`${ANSI.blue}${'─'.repeat(56)}${ANSI.reset}`);
      term.writeln(`${ANSI.blue}${ANSI.bold}  DEPTH ${data.depth}/${data.maxDepth}: Processing ${data.deviceCount} devices${ANSI.reset}`);
      term.writeln(`${ANSI.blue}${'─'.repeat(56)}${ANSI.reset}`);
      break;

    case 'device_started':
      term.writeln(`  ${ANSI.muted}Discovering: ${data.target}${ANSI.reset}`);
      break;

    case 'device_complete':
      term.writeln(`  ${ANSI.green}${ANSI.bold}OK${ANSI.reset}: ${data.hostname} via ${data.method} (${data.neighborCount} neighbors, ${data.durationMs.toFixed(0)}ms)`);
      break;

    case 'device_failed':
      const errMsg = (data.error || 'Unknown').length > 55
        ? data.error.slice(0, 52) + '...'
        : data.error;
      term.writeln(`  ${ANSI.red}${ANSI.bold}FAILED${ANSI.reset}: ${data.target} — ${errMsg}`);
      break;

    case 'device_excluded':
      term.writeln(`  ${ANSI.yellow}EXCLUDED${ANSI.reset}: ${data.hostname} (matches: ${data.pattern})`);
      break;

    case 'neighbor_queued':
      const ipStr = data.ip && data.ip !== data.target ? ` (${data.ip})` : '';
      term.writeln(`  ${ANSI.cyan}QUEUED${ANSI.reset}: ${data.target}${ipStr}`);
      break;

    case 'crawl_complete':
      term.writeln('');
      term.writeln(`${ANSI.green}${ANSI.bold}${'#'.repeat(56)}${ANSI.reset}`);
      term.writeln(`${ANSI.green}${ANSI.bold}  DISCOVERY COMPLETE${ANSI.reset}`);
      term.writeln(`${ANSI.green}${ANSI.bold}${'#'.repeat(56)}${ANSI.reset}`);
      term.writeln(`  Successful: ${ANSI.green}${data.discovered}${ANSI.reset}`);
      term.writeln(`  Failed: ${ANSI.red}${data.failed}${ANSI.reset}`);
      if (data.excluded > 0) term.writeln(`  Excluded: ${data.excluded}`);
      term.writeln(`  Duration: ${data.durationSeconds.toFixed(1)}s`);
      term.writeln('');
      break;

    case 'crawl_cancelled':
      term.writeln(`${ANSI.yellow}  ⚠ Discovery cancelled${ANSI.reset}`);
      break;

    case 'topology_updated':
      // Live topology update → push to cytoscape
      if (data.topology && TopoViewer) {
        TopoViewer.loadTopology(data.topology);
      }
      break;

case 'discovery:done':
      console.log('[renderer] discovery:done received:', JSON.stringify(data));
      setRunning(false);
      if (data.success && data.outputDir) {
        lastOutputDir = data.outputDir;
        document.getElementById('btnViewTopo').style.display = '';
        term.writeln(`${ANSI.muted}  Output saved to: ${data.outputDir}${ANSI.reset}`);
        term.writeln(`${ANSI.muted}  Click "View Topology" to see the map.${ANSI.reset}`);
        // DON'T load here — container is hidden, cytoscape gets 0x0 dimensions
        // loadTopologyFromOutput is called from viewTopologyResult() instead
      } else if (!data.success) {
        term.writeln(`${ANSI.red}  Discovery error: ${data.error || 'Unknown'}${ANSI.reset}`);
      }
      break;
    case 'log_message':
      const colorMap = {
        debug: ANSI.muted, info: '', warning: ANSI.yellow,
        error: ANSI.red, success: ANSI.green,
      };
      const color = colorMap[data.level] || '';
      term.writeln(`  ${color}${data.message}${ANSI.reset}`);
      break;

    case 'stats_updated':
      // Update header status
      if (data.currentDevice) {
        document.getElementById('statusText').textContent = data.currentDevice;
      }
      break;
  }
}


// =========================================================================
// Discovery Control
// =========================================================================

async function startDiscovery() {
  if (!window.scjs) {
    term.writeln(`${ANSI.red}  ✗ Not running in Electron — IPC unavailable.${ANSI.reset}`);
    return;
  }

  const seedsRaw = document.getElementById('seedIps').value.trim();
  if (!seedsRaw) {
    term.writeln(`${ANSI.red}  ✗ Seed IP(s) required.${ANSI.reset}`);
    return;
  }
  const outputDir = document.getElementById('outputDir').value.trim();
  if (!outputDir) {
    term.writeln(`${ANSI.red}  ✗ Output Directory required.${ANSI.reset}`);
    return;
  }
  const seeds = seedsRaw.split(/[,\s]+/).filter(Boolean);
  const commRaw = document.getElementById('community').value.trim();
  const communities = commRaw ? commRaw.split(/[,\s]+/).filter(Boolean) : [];
  const domainsRaw = document.getElementById('domains').value.trim();
  const domains = domainsRaw ? domainsRaw.split(/[,\s]+/).filter(Boolean) : [];
  const excludeRaw = document.getElementById('excludes').value.trim();
  const excludePatterns = excludeRaw ? excludeRaw.split(/[,\s]+/).filter(Boolean) : [];

  const config = {
    mode: seeds.length === 1 && parseInt(document.getElementById('maxDepth').value) === 0 ? 'discover' : 'crawl',
    seeds,
    communities,
    v3User: document.getElementById('v3User').value.trim() || null,
    v3AuthPass: document.getElementById('v3AuthPass').value || '',
    v3PrivPass: document.getElementById('v3PrivPass').value || '',
    v3AuthProto: document.getElementById('v3AuthProto').value,
    v3PrivProto: document.getElementById('v3PrivProto').value,
    maxDepth: parseInt(document.getElementById('maxDepth').value) || 3,
    maxConcurrent: parseInt(document.getElementById('maxConcurrent').value) || 20,
    timeout: parseFloat(document.getElementById('timeout').value) || 5,
    noDns: document.getElementById('noDns').checked,
    verbose: document.getElementById('verbose').checked,
    domains,
    excludePatterns,
    outputDir: document.getElementById('outputDir').value.trim() || null,
    sttFile: document.getElementById('sttFile').value.trim() || null,
  };

  setRunning(true);
  document.getElementById('btnViewTopo').style.display = 'none';

  term.writeln('');
  term.writeln(`${ANSI.blue}  ▸ Starting discovery: ${seeds.join(', ')}${ANSI.reset}`);

  const result = await window.scjs.startDiscovery(config);
  if (result.error) {
    term.writeln(`${ANSI.red}  ✗ ${result.error}${ANSI.reset}`);
    setRunning(false);
  }
}
window.startDiscovery = startDiscovery;

async function stopDiscovery() {
  if (!window.scjs) return;
  await window.scjs.stopDiscovery();
  term.writeln(`${ANSI.yellow}  ⚠ Discovery cancelled${ANSI.reset}`);
  setRunning(false);
}
window.stopDiscovery = stopDiscovery;

function setRunning(running) {
  isRunning = running;
  const dot = document.getElementById('statusDot');
  dot.className = running ? 'status-dot running' : 'status-dot';
  document.getElementById('statusText').textContent = running ? 'Discovering...' : 'Ready';
  document.getElementById('btnRun').style.display = running ? 'none' : '';
  document.getElementById('btnStop').style.display = running ? '' : 'none';

  // Disable form inputs while running
  document.querySelectorAll('#discovery-sidebar input, #discovery-sidebar select').forEach(el => {
    el.disabled = running;
  });
}


// =========================================================================
// File Dialogs
// =========================================================================

async function pickOutputDir() {
  if (!window.scjs) return;
  const result = await window.scjs.selectDirectory({ title: 'Select Output Directory' });
  if (!result.canceled) {
    document.getElementById('outputDir').value = result.path;
  }
}
window.pickOutputDir = pickOutputDir;

async function pickSttFile() {
  if (!window.scjs) return;
  const result = await window.scjs.openFile({ title: 'Select STT Proxy File', type: 'yaml' });
  if (!result.canceled) {
    document.getElementById('sttFile').value = result.path;
  }
}
window.pickSttFile = pickSttFile;

async function openMapFile() {
  if (!window.scjs) return;
  const result = await window.scjs.openFile({ title: 'Open map.json', type: 'json' });
  if (!result.canceled) {
    _viewerFilePath = result.path;
    const mapResult = await window.scjs.loadMapJson(result.path);
    if (mapResult.data) {
      if (!ViewerCy) await initViewerView();
      showViewerGraph(mapResult.data, result.path);
    }
  }
}
window.openMapFile = openMapFile;


// =========================================================================
// Topology View
// =========================================================================

async function initTopologyView() {
  TopoViewer = new CytoscapeViewer('cy-topology', {
    onNodeSelect: (data) => updateTopoNodeDetail(data),
    onStatsUpdate: (stats) => updateTopoStats(stats),
  });
  TopoViewer.init();
  await _loadPlatformMap(TopoViewer);
  window.TopoViewer = TopoViewer;
}

function updateTopoStats(stats) {
  document.getElementById('topoNodeCount').textContent = stats.nodes;
  document.getElementById('topoEdgeCount').textContent = stats.edges;
  document.getElementById('topoVendorCount').textContent = stats.vendors;
  document.getElementById('topoUndiscovered').textContent = stats.undiscovered;
  const info = document.getElementById('topoFilterInfo');
  if (info && stats.hidden > 0) {
    info.textContent = `Showing ${stats.nodes} of ${stats.total} (${stats.hidden} hidden)`;
  } else if (info) {
    info.textContent = '';
  }
  updateDeviceList('topo');
}

function topoToggleFilter() {
  if (!TopoViewer) return;
  TopoViewer.hideUndiscovered = document.getElementById('topoHideUndiscovered').checked;
  TopoViewer.hideLeafNodes = document.getElementById('topoHideLeaf').checked;
  TopoViewer._applyFilters();
  TopoViewer.applyLayout(document.getElementById('topoLayoutSelect').value || 'dagre');
}
window.topoToggleFilter = topoToggleFilter;

function updateTopoNodeDetail(data) {
  const panel = document.getElementById('topoNodeDetail');
  if (!data) { panel.classList.remove('active'); return; }

  panel.classList.add('active');
  const statusBadge = data.discovered
    ? '<span class="detail-badge badge-ok">Discovered</span>'
    : '<span class="detail-badge badge-fail">Undiscovered</span>';
  const vendorBadge = data.platform !== 'Undiscovered'
    ? `<span class="detail-badge badge-vendor">${data.platform}</span>`
    : '';

  document.getElementById('topoNodeDetailContent').innerHTML = `
    <div class="detail-header">
      <div class="detail-hostname">${data.label || data.id}</div>
      ${statusBadge} ${vendorBadge}
    </div>
    <div class="detail-row"><span class="detail-key">IP</span><span class="detail-val">${data.ip || '—'}</span></div>
    <div class="detail-row"><span class="detail-key">Platform</span><span class="detail-val">${data.platform || '—'}</span></div>
  `;
}

async function loadTopologyFromOutput(outputDir) {
  if (!window.scjs) return;
  console.log('[topo] Loading from:', outputDir);
  const result = await window.scjs.getOutputMap(outputDir);
  console.log('[topo] Result:', result.data ? `${Object.keys(result.data).length} devices` : result.error);
  if (result.data) {
    if (!TopoViewer) await initTopologyView();
    TopoViewer.loadTopology(result.data);
    updateDeviceList('topo');
  }
}

function updateDeviceList(prefix) {
  const viewer = prefix === 'topo' ? TopoViewer : ViewerCy;
  const listEl = document.getElementById(`${prefix === 'topo' ? 'topo' : 'viewer'}DeviceList`);
  if (!viewer || !listEl) return;

  const devices = viewer.getDeviceList();
  listEl.innerHTML = devices.map(d => `
    <div class="device-item" onclick="${prefix === 'topo' ? 'TopoViewer' : 'ViewerCy'}.selectNode('${d.id}')">
      <div class="device-status ${d.discovered ? 'ok' : 'fail'}"></div>
      <div class="device-name">${d.label}</div>
      <div class="device-vendor">${d.vendor !== 'default' ? d.vendor : ''}</div>
    </div>
  `).join('');
}


// =========================================================================
// Viewer View
// =========================================================================

async function initViewerView() {
  ViewerCy = new CytoscapeViewer('cy-viewer', {
    onNodeSelect: (data) => updateViewerNodeDetail(data),
    onStatsUpdate: (stats) => updateViewerStats(stats),
  });
  ViewerCy.init();
  await _loadPlatformMap(ViewerCy);
  window.ViewerCy = ViewerCy;
  setupViewerDragDrop();
}

function updateViewerStats(stats) {
  document.getElementById('viewerNodeCount').textContent = stats.nodes;
  document.getElementById('viewerEdgeCount').textContent = stats.edges;
  document.getElementById('viewerVendorCount').textContent = stats.vendors;
  document.getElementById('viewerUndiscovered').textContent = stats.undiscovered;
  const info = document.getElementById('viewerFilterInfo');
  if (info && stats.hidden > 0) {
    info.textContent = `Showing ${stats.nodes} of ${stats.total} (${stats.hidden} hidden)`;
  } else if (info) {
    info.textContent = '';
  }
  updateDeviceList('viewer');
}

function viewerToggleFilter() {
  if (!ViewerCy) return;
  ViewerCy.hideUndiscovered = document.getElementById('viewerHideUndiscovered').checked;
  ViewerCy.hideLeafNodes = document.getElementById('viewerHideLeaf').checked;
  ViewerCy._applyFilters();
  ViewerCy.applyLayout(document.getElementById('viewerLayoutSelect').value || 'dagre');
}
window.viewerToggleFilter = viewerToggleFilter;

function updateViewerNodeDetail(data) {
  const panel = document.getElementById('viewerNodeDetail');
  if (!data) { panel.classList.remove('active'); return; }

  panel.classList.add('active');
  const statusBadge = data.discovered
    ? '<span class="detail-badge badge-ok">Discovered</span>'
    : '<span class="detail-badge badge-fail">Undiscovered</span>';

  document.getElementById('viewerNodeDetailContent').innerHTML = `
    <div class="detail-header">
      <div class="detail-hostname">${data.label || data.id}</div>
      ${statusBadge}
    </div>
    <div class="detail-row"><span class="detail-key">IP</span><span class="detail-val">${data.ip || '—'}</span></div>
    <div class="detail-row"><span class="detail-key">Platform</span><span class="detail-val">${data.platform || '—'}</span></div>
  `;
}

function showViewerGraph(data, filePath) {
  document.getElementById('viewerDropZone').classList.add('hidden');
  document.getElementById('viewerMain').style.display = 'flex';

  if (filePath) _viewerFilePath = filePath;

  // Check for saved layout BEFORE loadTopology runs its default layout
  const saved = _viewerFilePath ? LayoutStore.load(_viewerFilePath) : null;

  ViewerCy.loadTopology(data);

  // If we have a saved layout, restore it after icons are inlined
  if (saved) {
    ViewerCy._inlineSvgIcons().then(() => {
      restoreLayout(_viewerFilePath, ViewerCy, 'viewer');
    });
  }

  updateDeviceList('viewer');
  updateLayoutStatus('viewer', !!saved);
}

function setupViewerDragDrop() {
  const dz = document.getElementById('viewerDropZone');

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (document.getElementById('view-viewer').classList.contains('active')) {
      dz.classList.add('drag-over');
    }
  });

  document.addEventListener('dragleave', () => dz.classList.remove('drag-over'));

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    if (!document.getElementById('view-viewer').classList.contains('active')) return;

    const file = e.dataTransfer.files[0];
    if (file) {
      const droppedPath = file.path || null;  // Electron exposes full path
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!ViewerCy) await initViewerView();
          showViewerGraph(data, droppedPath);
        } catch (err) {
          console.error('Invalid JSON:', err);
        }
      };
      reader.readAsText(file);
    }
  });
}


// =========================================================================
// Advanced Toggle
// =========================================================================

function toggleAdvanced(section) {
  const el = document.getElementById(`${section}Section`);
  const arrow = document.getElementById(`${section}Arrow`);
  el.classList.toggle('open');
  arrow.classList.toggle('open');
}
window.toggleAdvanced = toggleAdvanced;


// =========================================================================
// Keyboard Shortcuts
// =========================================================================

document.addEventListener('keydown', (e) => {
  // Ctrl+Enter → Run Discovery
  if (e.key === 'Enter' && e.ctrlKey && !isRunning) {
    startDiscovery();
  }
  // Ctrl+1/2/3 → Switch tabs
  if (e.ctrlKey && e.key === '1') switchView('discovery');
  if (e.ctrlKey && e.key === '2') switchView('topology');
  if (e.ctrlKey && e.key === '3') switchView('viewer');
});


// =========================================================================
// DrawIO Export
// =========================================================================

async function saveDrawIO(source) {
  const viewer = source === 'topo' ? TopoViewer : ViewerCy;
  if (!viewer || !viewer.rawData) {
    console.warn('[drawio] No topology data to export');
    return;
  }

  // Read shape mode from the corresponding select (falls back to 'icons')
  const selectId = source === 'topo' ? 'topoDrawioMode' : 'viewerDrawioMode';
  const selectEl = document.getElementById(selectId);
  const shapeMode = selectEl ? selectEl.value : 'icons';

  const xml = viewer.exportDrawIO('Network Topology', { shapeMode });
  if (!xml) {
    console.warn('[drawio] Export returned null — DrawIOExport module loaded?');
    return;
  }

  // Electron path: use IPC save dialog
  if (window.scjs && window.scjs.saveFile) {
    const result = await window.scjs.saveFile({
      title: 'Export DrawIO Diagram',
      defaultPath: 'topology.drawio',
      filters: [
        { name: 'DrawIO Files', extensions: ['drawio'] },
        { name: 'XML Files', extensions: ['xml'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (!result.canceled && result.path) {
      await window.scjs.writeFile(result.path, xml);
      console.log('[drawio] Saved:', result.path);
    }
    return;
  }

  // Fallback: browser blob download
  const blob = new Blob([xml], { type: 'application/xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'topology.drawio';
  a.click();
  URL.revokeObjectURL(a.href);
}
window.saveDrawIO = saveDrawIO;


async function viewTopologyResult() {
  // Switch tabs manually — skip lazy init
  document.querySelectorAll('.view-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === 'topology');
  });
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === 'view-topology');
  });

  await new Promise(r => setTimeout(r, 300));

  if (!lastOutputDir) return;
  const result = await window.scjs.getOutputMap(lastOutputDir);
  if (!result.data) return;

  // Track file path for layout persistence
  _topoFilePath = lastOutputDir + '/map.json';

  // Check for saved layout
  const saved = LayoutStore.load(_topoFilePath);

  // Kill everything
  if (TopoViewer && TopoViewer.cy) {
    TopoViewer.cy.destroy();
  }
  TopoViewer = null;
  window.TopoViewer = null;

  // Clear the container DOM so cytoscape has a clean canvas
  document.getElementById('cy-topology').innerHTML = '';

  // One fresh instance
  TopoViewer = new CytoscapeViewer('cy-topology', {
    onNodeSelect: (data) => updateTopoNodeDetail(data),
    onStatsUpdate: (stats) => updateTopoStats(stats),
  });
  TopoViewer.init();
  await _loadPlatformMap(TopoViewer);
  window.TopoViewer = TopoViewer;

  // Parse and add elements (platform map is now loaded)
  const elements = TopoViewer._parseMapFormat(result.data);

  TopoViewer.rawData = result.data;
  TopoViewer.cy.add(elements);

  if (saved) {
    // Restore saved layout (filters, positions, zoom/pan)
    restoreLayout(_topoFilePath, TopoViewer, 'topo');
  } else {
    // No saved layout — use default filters and dagre
    const hideUndiscEl = document.getElementById('topoHideUndiscovered');
    const hideLeafEl = document.getElementById('topoHideLeaf');
    if (hideUndiscEl) TopoViewer.hideUndiscovered = hideUndiscEl.checked;
    if (hideLeafEl) TopoViewer.hideLeafNodes = hideLeafEl.checked;
    TopoViewer._applyFilters();

    TopoViewer.cy.elements(':visible').layout({
      name: 'dagre', rankDir: 'TB', nodeSep: 60, rankSep: 80,
      animate: false, fit: true, padding: 30
    }).run();
  }

  // Inline file-based SVG icons as data URIs so background-fit:contain works
  await TopoViewer._inlineSvgIcons();
  if (!saved && TopoViewer && TopoViewer.cy) TopoViewer.cy.fit(null, 30);

  updateDeviceList('topo');
  TopoViewer._emitStats();
  updateLayoutStatus('topo', !!saved);

  console.log('[topo] fresh build, nodes:', TopoViewer.cy.nodes().length, 'saved layout:', !!saved);
}
window.viewTopologyResult = viewTopologyResult;

// =========================================================================
// Init
// =========================================================================

document.addEventListener('DOMContentLoaded', () => {
  initTerminal();
  setupIpcListeners();
  LayoutStore.prune();
});