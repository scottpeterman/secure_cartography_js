/**
 * sc-js-electron — Topology Viewer Module
 *
 * Reusable Cytoscape.js viewer for network topology maps.
 * Adapted from SC2's topology_viewer.html — strips QWebChannel,
 * keeps the map.json parser, vendor detection, inline SVG icons,
 * and all layout algorithms.
 *
 * Usage:
 *   const viewer = new CytoscapeViewer('cy-container-id');
 *   viewer.loadTopology(mapJsonData);
 *   viewer.applyLayout('dagre');
 */

'use strict';

// Register layout extensions
if (typeof cytoscape !== 'undefined') {
  if (typeof cytoscapeDagre !== 'undefined') cytoscape.use(cytoscapeDagre);
  if (typeof cytoscapeFcose !== 'undefined') cytoscape.use(cytoscapeFcose);
  if (typeof cytoscapeCola !== 'undefined') cytoscape.use(cytoscapeCola);
}


class CytoscapeViewer {

  // ── Shared icon data-URI cache (survives across instances) ──
  static _iconDataUriCache = new Map();

  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.cy = null;
    this.dagreAvailable = typeof cytoscapeDagre !== 'undefined';
    this.fcoseAvailable = typeof cytoscapeFcose !== 'undefined';
    this.colaAvailable = typeof cytoscapeCola !== 'undefined';
    this.selectedNode = null;
    this.rawData = null;

    // Filter state (both hidden by default for infrastructure-only view)
    this.hideUndiscovered = true;
    this.hideLeafNodes = true;

    // Callbacks
    this.onNodeSelect = options.onNodeSelect || null;
    this.onEdgeSelect = options.onEdgeSelect || null;
    this.onStatsUpdate = options.onStatsUpdate || null;
    this.onFilterUpdate = options.onFilterUpdate || null;
  }

  // ═══════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════

  init() {
    this.cy = cytoscape({
      container: document.getElementById(this.containerId),
      elements: [],
      style: this._getStyles(),
      layout: { name: 'preset' },
      minZoom: 0.1,
      maxZoom: 4,
      textureOnViewport: false,
      pixelRatio: 'auto',
    });

    this._setupEventHandlers();
    return this;
  }

  _getStyles() {
    return [
      {
        selector: 'node',
        style: {
          'shape': 'round-rectangle',
          'background-color': 'transparent',
          'background-image': 'data(icon)',
          'background-fit': 'contain',
          'background-clip': 'node',
          'background-width': '100%',
          'background-height': '100%',
          'width': 50,
          'height': 50,
          'label': 'data(label)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 5,
          'font-size': '10px',
          'font-weight': '500',
          'color': '#e0e6ed',
          'text-background-color': '#0f1419',
          'text-background-opacity': 0.9,
          'text-background-padding': '3px',
          'text-background-shape': 'roundrectangle',
          'border-width': 2,
          'border-color': 'data(vendorColor)',
          'border-opacity': 0.8,
        },
      },
      {
        selector: 'node[?discovered]',
        style: { 'border-style': 'solid' },
      },
      {
        selector: 'node[!discovered]',
        style: {
          'border-style': 'dashed',
          'border-color': '#ff6b6b',
          'border-width': 2,
          'border-opacity': 0.8,
          'opacity': 0.7,
        },
      },
      {
        selector: 'node:selected',
        style: {
          'border-width': 4,
          'border-opacity': 1,
        },
      },
      {
        selector: 'edge',
        style: {
          'width': 2,
          'line-color': '#4a9eff',
          'curve-style': 'bezier',
          'label': 'data(label)',
          'font-size': '8px',
          'color': '#e0e6ed',
          'text-background-color': '#0f1419',
          'text-background-opacity': 0.9,
          'text-background-padding': '2px',
          'text-background-shape': 'roundrectangle',
          'text-rotation': 'autorotate',
          'text-margin-y': -8,
        },
      },
      {
        selector: 'edge:selected',
        style: { 'width': 3, 'line-color': '#00d4ff' },
      },
    ];
  }

  _setupEventHandlers() {
    if (!this.cy) return;

    this.cy.on('tap', 'node', (evt) => {
      const data = evt.target.data();
      this.selectedNode = data.id;
      if (this.onNodeSelect) this.onNodeSelect(data);
    });

    this.cy.on('tap', 'edge', (evt) => {
      const data = evt.target.data();
      if (this.onEdgeSelect) this.onEdgeSelect(data);
    });

    this.cy.on('tap', (evt) => {
      if (evt.target === this.cy) {
        this.selectedNode = null;
        if (this.onNodeSelect) this.onNodeSelect(null);
      }
    });
  }


  // ═══════════════════════════════════════════════════════════════
  // SVG → High-Res PNG Inlining
  //
  // Cytoscape's canvas renderer rasterizes SVG background images
  // once at the node's CSS pixel size, then scales that bitmap
  // during zoom.  At high zoom the stretched bitmap looks terrible.
  //
  // Fix: pre-rasterize each SVG to a high-resolution PNG (4× the
  // node size) via an offscreen canvas, then hand that PNG data URI
  // to Cytoscape.  The oversampled bitmap stays crisp across the
  // full 0.1–4× zoom range.
  // ═══════════════════════════════════════════════════════════════

  /** Rasterize an SVG string to a PNG data URI at the given pixel size. */
  _rasterizeSvg(svgText, size = 200) {
    return new Promise((resolve, reject) => {
      const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText.trim());
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = (e) => {
        reject(new Error('SVG rasterize failed'));
      };
      img.src = dataUri;
    });
  }

  /**
   * Convert all file-based node icons to high-res PNG data URIs.
   * Returns a Promise that resolves when every icon is inlined.
   */
  async _inlineSvgIcons() {
    if (!this.cy) return;

    const cache = CytoscapeViewer._iconDataUriCache;
    const pending = [];
    let inlined = 0, fromCache = 0, failed = 0;

    this.cy.nodes().forEach(node => {
      const icon = node.data('icon');
      if (!icon || icon.startsWith('data:')) return;

      const cleanUrl = icon.split('?')[0]; // strip cache-buster

      if (cache.has(cleanUrl)) {
        node.data('icon', cache.get(cleanUrl));
        fromCache++;
        return;
      }

      const nodeId = node.id();
      const p = fetch(cleanUrl)
        .then(r => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return r.text();
        })
        .then(svg => this._rasterizeSvg(svg, 200))
        .then(pngUri => {
          cache.set(cleanUrl, pngUri);
          node.data('icon', pngUri);
          inlined++;
        })
        .catch(e => {
          console.error(`[icon] ✗ FAILED node="${nodeId}" url="${cleanUrl}" error="${e.message}"`);
          failed++;
        });

      pending.push(p);
    });

    if (pending.length) await Promise.all(pending);
    console.log(`[icon] inlineSvgIcons complete: ${inlined} rasterized, ${fromCache} cached, ${failed} failed, ${this.cy.nodes().length} total nodes`);
  }

  /**
   * Inline a single node's icon (used by addDevice during live crawl).
   */
  _inlineNodeIcon(node) {
    if (!node) return;
    const icon = node.data('icon');
    if (!icon || icon.startsWith('data:')) return;

    const cleanUrl = icon.split('?')[0];
    const nodeId = node.id();
    const cache = CytoscapeViewer._iconDataUriCache;

    if (cache.has(cleanUrl)) {
      node.data('icon', cache.get(cleanUrl));
      return;
    }

    fetch(cleanUrl)
      .then(r => r.ok ? r.text() : Promise.reject(`${r.status} ${r.statusText}`))
      .then(svg => this._rasterizeSvg(svg, 200))
      .then(pngUri => {
        cache.set(cleanUrl, pngUri);
        node.data('icon', pngUri);
      })
      .catch(e => console.error(`[icon] ✗ FAILED node="${nodeId}" url="${cleanUrl}" error="${e}"`));
  }


  // ═══════════════════════════════════════════════════════════════
  // Data Loading
  // ═══════════════════════════════════════════════════════════════

  /**
   * Load topology data. Auto-detects format:
   *  - SC2 map.json:   { "device_name": { node_details, peers } }
   *  - Cytoscape:      { nodes: [...], edges: [...] }
   *  - VelocityMaps:   { cytoscape: { nodes, edges } }
   */
loadTopology(data) {
    this.rawData = data;

    let elements = [];
    if (data.cytoscape) {
      elements = this._parseCytoscapeFormat(data.cytoscape);
    } else if (data.nodes && data.edges) {
      elements = this._parseCytoscapeFormat(data);
    } else if (typeof data === 'object' && !Array.isArray(data)) {
      elements = this._parseMapFormat(data);
    }

    // Destroy and recreate — eliminates all stale style/layout state
    if (this.cy) {
      this.cy.destroy();
      this.cy = null;
    }

    this.cy = cytoscape({
      container: document.getElementById(this.containerId),
      elements: elements,
      style: this._getStyles(),
      layout: { name: 'preset' },
      minZoom: 0.1,
      maxZoom: 4,
      textureOnViewport: false,
      pixelRatio: 'auto',
    });

    this._setupEventHandlers();

    // Apply default filters before layout so hidden nodes
    // don't distort the layout geometry
    this._applyFilters();

    // Layout visible elements only
    if (this.cy.nodes(':visible').length > 0) {
      const visibleEles = this.cy.elements(':visible');
      const layoutConfig = this.dagreAvailable
        ? { name: 'dagre', rankDir: 'TB', nodeSep: 60, rankSep: 80, edgeSep: 10, ranker: 'network-simplex', animate: false, fit: true, padding: 30 }
        : { name: 'breadthfirst', directed: true, spacingFactor: 1.5, animate: false, fit: true, padding: 30 };
      visibleEles.layout(layoutConfig).run();

      // Inline file-based SVG icons as data URIs so Cytoscape
      // can resolve their dimensions for background-fit: contain
      this._inlineSvgIcons().then(() => {
        if (this.cy) this.cy.fit(null, 30);
      });
    }

    this._emitStats();
  }
  /**
   * Incrementally add a device from a discovery event.
   * Used for live topology updates during crawl.
   */
  addDevice(deviceName, deviceData) {
    if (!this.cy) return;

    const existingNode = this.cy.getElementById(deviceName);
    if (existingNode.length > 0) {
      // Update existing placeholder → discovered
      const details = deviceData.node_details || {};
      existingNode.data({
        platform: details.platform || 'Unknown',
        ip: details.ip || '',
        discovered: true,
        icon: this._getIconForPlatform(details.platform, deviceName),
        vendorColor: this._getVendorColor(details.platform, deviceName),
        vendorFill: this._getVendorFill(details.platform, deviceName),
        label: deviceName,  // Remove ⚠ if present
      });
      this._inlineNodeIcon(existingNode);
    } else {
      // Add new node
      const details = deviceData.node_details || {};
      const added = this.cy.add({
        group: 'nodes',
        data: {
          id: deviceName,
          label: deviceName,
          ip: details.ip || '',
          platform: details.platform || 'Unknown',
          icon: this._getIconForPlatform(details.platform, deviceName),
          discovered: true,
          vendorColor: this._getVendorColor(details.platform, deviceName),
          vendorFill: this._getVendorFill(details.platform, deviceName),
        },
      });
      this._inlineNodeIcon(added);
    }

    // Add edges and peer placeholders
    const peers = deviceData.peers || {};
    for (const [peerName, peerData] of Object.entries(peers)) {
      // Create placeholder peer if missing
      if (this.cy.getElementById(peerName).length === 0) {
        this.cy.add({
          group: 'nodes',
          data: {
            id: peerName,
            label: peerName + ' ⚠',
            ip: '', platform: 'Undiscovered',
            icon: this._getUndiscoveredIcon(),
            discovered: false,
            vendorColor: '#ff6b6b',
            vendorFill: 'rgba(255,107,107,0.2)',
          },
        });
      }

      // Add edge if not exists
      const edgeId = [deviceName, peerName].sort().join('--');
      if (this.cy.getElementById(edgeId).length === 0) {
        let label = '';
        const connections = peerData.connections || [];
        if (connections.length > 0 && connections[0].length >= 2) {
          label = `${connections[0][0]} ↔ ${connections[0][1]}`;
        }
        this.cy.add({
          group: 'edges',
          data: { id: edgeId, source: deviceName, target: peerName, label },
        });
      }
    }

    this._emitStats();
  }


  // ═══════════════════════════════════════════════════════════════
  // Format Parsers
  // ═══════════════════════════════════════════════════════════════

  _parseMapFormat(data) {
    const elements = [];
    const addedEdges = new Set();
    const nodeIds = new Set();

    // First pass: discovered nodes
    for (const [deviceName, deviceData] of Object.entries(data)) {
      const details = deviceData.node_details || {};
      nodeIds.add(deviceName);

      elements.push({
        group: 'nodes',
        data: {
          id: deviceName,
          label: deviceName,
          ip: details.ip || '',
          platform: details.platform || 'Unknown',
          icon: details.icon || this._getIconForPlatform(details.platform, deviceName),
          discovered: true,
          vendorColor: this._getVendorColor(details.platform, deviceName),
          vendorFill: this._getVendorFill(details.platform, deviceName),
        },
      });
    }

    // Second pass: edges + placeholder peers
    for (const [deviceName, deviceData] of Object.entries(data)) {
      const peers = deviceData.peers || {};

      for (const [peerName, peerData] of Object.entries(peers)) {
        if (!nodeIds.has(peerName)) {
          nodeIds.add(peerName);
          elements.push({
            group: 'nodes',
            data: {
              id: peerName,
              label: peerName + ' ⚠',
              ip: '', platform: 'Undiscovered',
              icon: this._getUndiscoveredIcon(),
              discovered: false,
              vendorColor: '#ff6b6b',
              vendorFill: 'rgba(255,107,107,0.2)',
            },
          });
        }

        const edgeId = [deviceName, peerName].sort().join('--');
        if (!addedEdges.has(edgeId)) {
          addedEdges.add(edgeId);
          let label = '';
          const connections = peerData.connections || [];
          if (connections.length > 0 && connections[0].length >= 2) {
            label = `${connections[0][0]} ↔ ${connections[0][1]}`;
          }
          elements.push({
            group: 'edges',
            data: { id: edgeId, source: deviceName, target: peerName, label },
          });
        }
      }
    }

    return elements;
  }

  _parseCytoscapeFormat(data) {
    const elements = [];

    if (data.nodes) {
      data.nodes.forEach(n => {
        const d = n.data || n;
        elements.push({
          group: 'nodes',
          data: {
            id: d.id,
            label: d.label || d.id,
            ip: d.ip || '',
            platform: d.platform || 'Unknown',
            icon: d.icon || this._getIconForPlatform(d.platform, d.id),
            discovered: d.discovered !== false,
            vendorColor: this._getVendorColor(d.platform, d.id),
            vendorFill: this._getVendorFill(d.platform, d.id),
          },
          position: n.position || undefined,
        });
      });
    }

    if (data.edges) {
      data.edges.forEach(e => {
        const d = e.data || e;
        elements.push({
          group: 'edges',
          data: {
            id: d.id || `${d.source}-${d.target}`,
            source: d.source,
            target: d.target,
            label: d.label || '',
          },
        });
      });
    }

    return elements;
  }


  // ═══════════════════════════════════════════════════════════════
  // Layouts
  // ═══════════════════════════════════════════════════════════════

applyLayout(algorithm = 'dagre') {
    if (!this.cy || this.cy.nodes().length === 0) return;

    const shared = { animate: true, animationDuration: 500, fit: true, padding: 30 };
    const fast   = { animate: true, animationDuration: 300, fit: true, padding: 30 };

    const configs = {
      // ── Hierarchical ──
      dagre: this.dagreAvailable
        ? { name: 'dagre', rankDir: 'TB', nodeSep: 60, rankSep: 80, edgeSep: 10, ranker: 'network-simplex', ...shared }
        : { name: 'breadthfirst', directed: true, spacingFactor: 1.5, ...shared },

      'dagre-lr': this.dagreAvailable
        ? { name: 'dagre', rankDir: 'LR', nodeSep: 50, rankSep: 120, edgeSep: 10, ranker: 'network-simplex', ...shared }
        : { name: 'breadthfirst', directed: true, spacingFactor: 1.5, ...shared },

      breadthfirst: { name: 'breadthfirst', directed: true, spacingFactor: 1.5, ...fast },

      // ── Force-Directed ──
      fcose: this.fcoseAvailable
        ? { name: 'fcose',
            quality: 'default',
            randomize: true,
            nodeRepulsion: () => 6000,
            idealEdgeLength: () => 80,
            edgeElasticity: () => 0.45,
            nestingFactor: 0.1,
            gravity: 0.25,
            gravityRange: 3.8,
            numIter: 2500,
            tile: true,
            tilingPaddingVertical: 10,
            tilingPaddingHorizontal: 10,
            ...shared }
        : { name: 'cose', nodeRepulsion: 8000, idealEdgeLength: 100, gravity: 0.25, ...shared },

      cose: { name: 'cose', nodeRepulsion: 8000, idealEdgeLength: 100, edgeElasticity: 100, gravity: 0.25, numIter: 1000, ...shared },

      cola: this.colaAvailable
        ? { name: 'cola',
            maxSimulationTime: 4000,
            nodeSpacing: 30,
            edgeLength: 120,
            convergenceThreshold: 0.01,
            avoidOverlap: true,
            handleDisconnected: true,
            flow: { axis: 'y', minSeparation: 60 },
            ...shared }
        : { name: 'cose', nodeRepulsion: 8000, idealEdgeLength: 100, gravity: 0.25, ...shared },

      // ── Radial ──
      concentric: { name: 'concentric', concentric: (n) => n.degree(), levelWidth: (nodes) => Math.max(1, Math.floor(nodes.length / 4)), minNodeSpacing: 50, ...shared },
      circle: { name: 'circle', avoidOverlap: true, ...fast },

      // ── Other ──
      grid: { name: 'grid', avoidOverlap: true, condense: true, ...fast },
    };

    const config = configs[algorithm] || configs.dagre;
    
    // Stop any running layout
    if (this._activeLayout) {
      this._activeLayout.stop();
    }

    // Layout only visible elements (respects current filters)
    const visibleEles = this.cy.elements(':visible');
    if (visibleEles.nodes().length === 0) return;

    const layout = visibleEles.layout(config);
    this._activeLayout = layout;

    layout.on('layoutstop', () => {
      this._activeLayout = null;
    });

    layout.run();
  }

  // ═══════════════════════════════════════════════════════════════
  // Controls
  // ═══════════════════════════════════════════════════════════════

  fitView() { if (this.cy) this.cy.fit(this.cy.elements(':visible'), 30); }
  zoomIn() { if (this.cy) this.cy.zoom(this.cy.zoom() * 1.2); }
  zoomOut() { if (this.cy) this.cy.zoom(this.cy.zoom() * 0.8); }


  // ═══════════════════════════════════════════════════════════════
  // Filtering
  // ═══════════════════════════════════════════════════════════════

  /**
   * Toggle visibility of undiscovered (placeholder) nodes.
   */
  toggleUndiscovered(hide) {
    this.hideUndiscovered = hide;
    this._applyFilters();
  }

  /**
   * Toggle visibility of leaf nodes (degree ≤ 1 in the full graph).
   * Degree is checked against ALL elements (not just visible ones)
   * so toggling undiscovered doesn't change which nodes are "leaf".
   */
  toggleLeafNodes(hide) {
    this.hideLeafNodes = hide;
    this._applyFilters();
  }

  /**
   * Apply current filter state to the graph.
   * Uses cytoscape show/hide so elements remain in the graph
   * and can be toggled back without re-parsing.
   */
  _applyFilters() {
    if (!this.cy) return;

    const nodes = this.cy.nodes();

    // First pass: show everything
    nodes.show();
    this.cy.edges().show();

    // Collect nodes to hide
    const toHide = this.cy.collection();

    nodes.forEach(node => {
      // Undiscovered filter
      if (this.hideUndiscovered && !node.data('discovered')) {
        toHide.merge(node);
        return;
      }
      // Leaf filter: degree ≤ 1 in the full (unfiltered) graph
      if (this.hideLeafNodes && node.degree(false) <= 1) {
        toHide.merge(node);
        return;
      }
    });

    // Hide matched nodes and their connected edges
    if (toHide.length > 0) {
      toHide.hide();
      toHide.connectedEdges().hide();
    }

    // Also hide any edges where both endpoints are hidden
    this.cy.edges().forEach(edge => {
      if (!edge.source().visible() || !edge.target().visible()) {
        edge.hide();
      }
    });

    this._emitStats();
    if (this.onFilterUpdate) {
      const total = this.cy.nodes().length;
      const visible = this.cy.nodes(':visible').length;
      const hidden = total - visible;
      this.onFilterUpdate({ total, visible, hidden });
    }
  }

  exportPNG() {
    if (!this.cy) return;
    const png = this.cy.png({ output: 'blob', bg: '#0a0e14', full: true, scale: 2 });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(png);
    a.download = 'topology.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  exportJSON() {
    if (!this.rawData) return;
    const blob = new Blob([JSON.stringify(this.rawData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'map.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * Export topology as DrawIO XML.
   * Uses DrawIOExport module (drawio-export.js) with current layout positions.
   * Returns the XML string (caller handles save dialog).
   *
   * @param {string} [title]       Diagram title
   * @param {Object} [options]     Additional options passed to DrawIOExport.generate
   * @param {string} [options.shapeMode]  'icons' (default) or 'shapes'
   */
  exportDrawIO(title, options = {}) {
    if (!this.rawData || typeof DrawIOExport === 'undefined') return null;
    const positions = DrawIOExport.getPositionsFromViewer(this);
    return DrawIOExport.generate(this.rawData, {
      positions,
      title: title || 'Network Topology',
      includeUndiscovered: !this.hideUndiscovered,
      ...options,
    });
  }

  getStats() {
    if (!this.cy) return { nodes: 0, edges: 0, vendors: 0, undiscovered: 0, total: 0, hidden: 0 };
    const allNodes = this.cy.nodes();
    const visibleNodes = this.cy.nodes(':visible');
    const visibleEdges = this.cy.edges(':visible');
    const vendors = new Set();
    let undiscovered = 0;
    visibleNodes.forEach(n => {
      const p = n.data('platform') || '';
      const v = this._detectVendor(p, n.id());
      if (v !== 'default') vendors.add(v);
      if (!n.data('discovered')) undiscovered++;
    });
    return {
      nodes: visibleNodes.length,
      edges: visibleEdges.length,
      vendors: vendors.size,
      undiscovered,
      total: allNodes.length,
      hidden: allNodes.length - visibleNodes.length,
    };
  }

  getDeviceList() {
    if (!this.cy) return [];
    return this.cy.nodes(':visible').map(n => ({
      id: n.id(),
      label: n.data('label'),
      ip: n.data('ip'),
      platform: n.data('platform'),
      vendor: this._detectVendor(n.data('platform'), n.id()),
      discovered: n.data('discovered'),
    })).sort((a, b) => a.label.localeCompare(b.label));
  }

  selectNode(nodeId) {
    if (!this.cy) return;
    this.cy.nodes().unselect();
    const node = this.cy.getElementById(nodeId);
    if (node.length) {
      node.select();
      this.cy.animate({ center: { eles: node }, duration: 300 });
      this.selectedNode = nodeId;
      if (this.onNodeSelect) this.onNodeSelect(node.data());
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Layout Persistence
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get current positions of all nodes.
   * @returns {Object} { nodeId: { x, y } }
   */
  getPositions() {
    if (!this.cy) return {};
    const positions = {};
    this.cy.nodes().forEach(node => {
      const pos = node.position();
      positions[node.id()] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    });
    return positions;
  }

  /**
   * Apply saved positions to nodes.
   * Nodes in savedPositions get placed at their saved coords.
   * Nodes NOT in savedPositions are left where they are (caller
   * can run layout on them afterward).
   *
   * @param {Object} savedPositions  { nodeId: { x, y } }
   * @returns {{ applied: number, missing: string[] }}
   *   applied: how many nodes got positioned
   *   missing: node IDs in the graph that had no saved position
   */
  applyPositions(savedPositions) {
    if (!this.cy || !savedPositions) return { applied: 0, missing: [] };

    let applied = 0;
    const missing = [];

    this.cy.nodes().forEach(node => {
      const id = node.id();
      const pos = savedPositions[id];
      if (pos) {
        node.position(pos);
        applied++;
      } else {
        missing.push(id);
      }
    });

    if (applied > 0) this.cy.fit(null, 30);
    return { applied, missing };
  }

  _emitStats() {
    if (this.onStatsUpdate) this.onStatsUpdate(this.getStats());
  }


  // ═══════════════════════════════════════════════════════════════
  // Vendor Detection & Colors
  // ═══════════════════════════════════════════════════════════════

  _vendorColors = {
    cisco: '#049fd9', juniper: '#F58536', arista: '#2D8659',
    paloalto: '#FA582D', fortinet: '#EE3124', default: '#4a9eff',
  };

  _vendorFills = {
    cisco: 'rgba(4,159,217,0.25)', juniper: 'rgba(245,133,54,0.25)',
    arista: 'rgba(45,134,89,0.25)', paloalto: 'rgba(250,88,45,0.25)',
    fortinet: 'rgba(238,49,36,0.25)', default: 'rgba(74,158,255,0.2)',
  };

  _detectVendor(platform, nodeId) {
    const p = (platform || '').toLowerCase();
    const n = (nodeId || '').toLowerCase();

    const checks = [
      [['junos', 'juniper', 'mx', 'qfx', 'ex2', 'ex3', 'ex4', 'srx', 'ptx', 'acx'], 'juniper'],
      [['arista', 'eos', 'veos', 'dcs-', 'ccs-'], 'arista'],
      [['palo', 'pan-', 'pa-'], 'paloalto'],
      [['forti', 'fortigate', 'fortios'], 'fortinet'],
      [['cisco', 'ios', 'nx-os', 'nexus', 'catalyst', 'c9', 'ws-c', 'isr', 'asr', 'asa'], 'cisco'],
    ];

    for (const [patterns, vendor] of checks) {
      for (const pat of patterns) {
        if (p.includes(pat) || n.includes(pat)) return vendor;
      }
    }
    return 'default';
  }

  /**
   * Detect the functional role of a device.
   * Returns: 'firewall', 'router', 'l2-switch', 'l3-switch'
   *
   * Checks platform string and hostname for role indicators.
   * Firewall checked first (most specific), then router, then
   * L2 switch, with L3 switch as the default.
   */
  _detectDeviceRole(platform, nodeId) {
    const p = (platform || '').toLowerCase();
    const n = (nodeId || '').toLowerCase();

    // ── Firewall ──
    // Platform indicators
    const fwPlatform = ['asa', 'firepower', 'ftd', 'fxos',
                        'pan-os', 'pa-', 'panos',
                        'fortigate', 'fortios',
                        'srx', 'screenos',
                        'checkpoint', 'gaia'];
    // Hostname indicators
    const fwName = ['fw', 'firewall', 'palo', 'forti', 'asa'];
    if (fwPlatform.some(pat => p.includes(pat)) ||
        fwName.some(pat => n.includes(pat))) return 'firewall';

    // ── Router ──
    // Platform: Cisco ISR/ASR/NCS/CRS, Juniper MX/PTX/ACX, Arista 7500R
    const rtrPlatform = ['isr', 'asr', 'ncs', 'crs', 'c8000', '7600', '7200', '7500',
                         'mx-', 'mx9', 'mx4', 'mx2', 'mx1', 'mx8', 'mx10',
                         'vmx', 'ptx', 'acx',
                         '7500r', '7280r'];
    // Hostname: rtr, -rt-, gw, gateway, wan, border, br-, pe-, ce-
    const rtrName = ['rtr', '-rt-', '-rt.', 'router',
                     'gw-', 'gw.', 'gateway',
                     'wan-', 'wan.',
                     'border', 'br-', 'br.',
                     'pe-', 'pe.', '-pe-',
                     'ce-', 'ce.',
                     'mx-', 'mx.'];
    if (rtrPlatform.some(pat => p.includes(pat)) ||
        rtrName.some(pat => n.includes(pat))) return 'router';

    // ── L2 Switch (access-layer) ──
    // Platform: 2960, 3560, 3750, C1000, CBS, EX2200, EX2300
    const l2Platform = ['2960', '3560', '3750', 'c1000', 'cbs',
                        'ex2200', 'ex2300', 'ex3300',
                        'ws-c29', 'ws-c35', 'ws-c37',
                        'ie-', 'ie2000', 'ie3000', 'ie4000',
                        'sf', 'sg', 'c1200', 'c1300'];
    // Hostname: access, acc-, closet, idf, edge-sw, tor-, leaf (in some designs)
    const l2Name = ['access', 'acc-', 'acc.',
                    'closet', 'idf', 'mdf',
                    'edge-sw', 'tor-', 'tor.',
                    'leaf-', 'leaf.'];
    if (l2Platform.some(pat => p.includes(pat)) ||
        l2Name.some(pat => n.includes(pat))) return 'l2-switch';

    // ── Default: L3 Switch ──
    return 'l3-switch';
  }

  _getVendorColor(platform, nodeId) {
    return this._vendorColors[this._detectVendor(platform, nodeId)] || this._vendorColors.default;
  }

  _getVendorFill(platform, nodeId) {
    return this._vendorFills[this._detectVendor(platform, nodeId)] || this._vendorFills.default;
  }


  // ═══════════════════════════════════════════════════════════════
  // Platform Icon Resolution
  //
  // Three-tier lookup using platform_icon_drawio.json mapping:
  //   1. Exact platform_patterns match (e.g. "C9300" → layer_3_switch)
  //   2. Fallback patterns on platform + hostname (e.g. "-rtr" → router)
  //   3. Default by vendor (cisco → layer_3_switch, etc.)
  //
  // DrawIO shape names map to SVG filenames in assets/icons/:
  //   mxgraph.cisco.switches.layer_3_switch  → layer-3-switch.svg
  //   mxgraph.cisco.routers.router           → router.svg
  //   mxgraph.cisco.security.firewall        → firewall.svg
  // ═══════════════════════════════════════════════════════════════

  // Icon base path — relative to index.html
  _iconPath = 'assets/icons';

  // Platform map loaded from platform_map.json (set via loadPlatformMap)
  _platformMap = null;

  /**
   * Load the platform mapping JSON.
   * Call once at startup: viewer.loadPlatformMap(jsonData)
   */
  loadPlatformMap(data) {
    this._platformMap = typeof data === 'string' ? JSON.parse(data) : data;
    const m = this._platformMap;
    const t1Count = m && m.platform_patterns ? Object.keys(m.platform_patterns).filter(k => !k.startsWith('_comment')).length : 0;
    const t2Count = m && m.fallback_patterns ? Object.keys(m.fallback_patterns).length : 0;
    console.log(`[icon] platformMap loaded: ${t1Count} platform_patterns, ${t2Count} fallback_patterns`);
  }

  /**
   * DrawIO shape name → local SVG filename.
   * "shape=mxgraph.cisco.switches.layer_3_switch" → "layer-3-switch.svg"
   */
  _shapeToFile(shapeStr) {
    if (!shapeStr) return null;
    // Extract the last segment: "mxgraph.cisco.switches.layer_3_switch" → "layer_3_switch"
    const full = shapeStr.replace('shape=', '');
    const parts = full.split('.');
    const name = parts[parts.length - 1];  // "layer_3_switch"
    // Convert underscores to hyphens: "layer_3_switch" → "layer-3-switch"
    const fileName = name.replace(/_/g, '-') + '.svg';
    return `${this._iconPath}/${fileName}`;
  }

  /**
   * Resolve icon for a device by platform string and hostname.
   * Returns a data URI (if cached) or a path to a local SVG file.
   */
  _getIconForPlatform(platform, nodeId) {
    if (!platform || platform === 'Undiscovered') return this._getUndiscoveredIcon();

    const map = this._platformMap;
    let filePath = null;
    let matchTier = null;
    let matchDetail = null;

    if (!map) {
      console.warn(`[icon] ⚠ NO PLATFORM MAP LOADED — node="${nodeId}" platform="${platform}"`);
    }

    // ── Tier 1: Exact platform_patterns match ──
    if (map && map.platform_patterns) {
      // Check longest patterns first for specificity (C9407R before C9)
      const patterns = Object.entries(map.platform_patterns)
        .filter(([k]) => !k.startsWith('_comment'))
        .sort((a, b) => b[0].length - a[0].length);

      for (const [pattern, shape] of patterns) {
        if (platform.includes(pattern)) {
          filePath = this._shapeToFile(shape);
          if (filePath) {
            matchTier = 'T1:platform_patterns';
            matchDetail = `pattern="${pattern}" shape="${shape}"`;
            break;
          }
        }
      }
    }

    // ── Tier 2: Fallback patterns (platform string + hostname) ──
    if (!filePath && map && map.fallback_patterns) {
      const pLower = platform.toLowerCase();
      const nLower = (nodeId || '').toLowerCase();

      for (const [ruleName, config] of Object.entries(map.fallback_patterns)) {
        const platMatch = (config.platform_patterns || []).some(p => pLower.includes(p));
        const nameMatch = (config.name_patterns || []).some(p => nLower.includes(p));

        if (platMatch || nameMatch) {
          filePath = this._shapeToFile(config.shape);
          if (filePath) {
            matchTier = 'T2:fallback_patterns';
            matchDetail = `rule="${ruleName}" platMatch=${platMatch} nameMatch=${nameMatch} shape="${config.shape}"`;
            break;
          }
        }
      }
    }

    // ── Tier 3: Default by device role + vendor ──
    if (!filePath) {
      const role = this._detectDeviceRole(platform, nodeId);

      // Role → SVG filename (DrawIO naming convention)
      const roleShapes = {
        'firewall':  'firewall',
        'router':    'router',
        'l2-switch': 'workgroup-switch',
        'l3-switch': 'layer-3-switch',
      };
      const shapeName = roleShapes[role] || 'layer-3-switch';
      filePath = `${this._iconPath}/${shapeName}.svg`;
      matchTier = 'T3:role_default';
      matchDetail = `vendor="${this._detectVendor(platform, nodeId)}" role="${role}" shape="${shapeName}"`;
    }

    // Log the full resolution chain
    const cache = CytoscapeViewer._iconDataUriCache;
    const cached = cache.has(filePath);
    console.log(`[icon] ${nodeId} | platform="${platform}" | ${matchTier}: ${matchDetail} | file=${filePath} | cached=${cached}`);

    return cached ? cache.get(filePath) : filePath;
  }

  _getUndiscoveredIcon() {
    // Inline SVG for undiscovered — no file needed, visually distinct
    return 'data:image/svg+xml,' + encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
        <rect x="4" y="14" width="40" height="20" rx="3" fill="#4a4a4a" stroke="#ff6b6b" stroke-width="2" stroke-dasharray="4,2"/>
        <text x="24" y="28" text-anchor="middle" fill="#ff6b6b" font-size="16" font-weight="bold">?</text>
      </svg>
    `);
  }
}

// Export for global use
window.CytoscapeViewer = CytoscapeViewer;