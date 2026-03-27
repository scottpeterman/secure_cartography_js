/**
 * drawio-export.js — DrawIO XML export for secure-cartography-js
 *
 * Generates valid .drawio (mxGraphModel) XML from SC2 map.json topology data.
 * Uses Cytoscape node positions when available, falls back to simple grid layout.
 *
 * Loaded as a <script> in the Electron app alongside topology.js.
 * Also usable standalone in Node.js via require().
 *
 * Usage (browser):
 *   DrawIOExport.loadPlatformMap(platformMapJson);  // same JSON the viewer uses
 *   const xml = DrawIOExport.generate(viewer.rawData, {
 *     positions: DrawIOExport.getPositionsFromViewer(viewer),
 *     title: 'IAD1 Fabric',
 *     shapeMode: 'icons',  // 'icons' (Cisco stencils) or 'shapes' (geometric)
 *   });
 *
 * Usage (Node.js):
 *   const { DrawIOExport } = require('./drawio-export');
 *   const platformMap = JSON.parse(fs.readFileSync('platform_map.json', 'utf-8'));
 *   DrawIOExport.loadPlatformMap(platformMap);
 *   const xml = DrawIOExport.generate(mapJsonData, { shapeMode: 'shapes' });
 *   fs.writeFileSync('topology.drawio', xml);
 */

'use strict';

const DrawIOExport = {

  // ═══════════════════════════════════════════════════════════════
  // Vendor Detection — mirrors topology.js _detectVendor exactly
  // ═══════════════════════════════════════════════════════════════

  _vendorChecks: [
    [['junos', 'juniper', 'mx', 'qfx', 'ex2', 'ex3', 'ex4', 'srx', 'ptx', 'acx'], 'juniper'],
    [['arista', 'eos', 'veos', 'dcs-', 'ccs-'], 'arista'],
    [['palo', 'pan-', 'pa-'], 'paloalto'],
    [['forti', 'fortigate', 'fortios'], 'fortinet'],
    [['cisco', 'ios', 'nx-os', 'nexus', 'catalyst', 'c9', 'ws-c', 'isr', 'asr', 'asa'], 'cisco'],
  ],

  detectVendor(platform, nodeId) {
    const p = (platform || '').toLowerCase();
    const n = (nodeId || '').toLowerCase();
    for (const [patterns, vendor] of this._vendorChecks) {
      for (const pat of patterns) {
        if (p.includes(pat) || n.includes(pat)) return vendor;
      }
    }
    return 'default';
  },

  // ═══════════════════════════════════════════════════════════════
  // Device Role Detection — mirrors topology.js _detectDeviceRole
  // ═══════════════════════════════════════════════════════════════

  detectDeviceRole(platform, nodeId) {
    const p = (platform || '').toLowerCase();
    const n = (nodeId || '').toLowerCase();

    // Firewall
    const fwPlat = ['asa', 'firepower', 'ftd', 'fxos', 'pan-os', 'pa-', 'panos',
                    'fortigate', 'fortios', 'srx', 'screenos', 'checkpoint', 'gaia'];
    const fwName = ['fw', 'firewall', 'palo', 'forti', 'asa'];
    if (fwPlat.some(x => p.includes(x)) || fwName.some(x => n.includes(x))) return 'firewall';

    // Router
    const rtrPlat = ['isr', 'asr', 'ncs', 'crs', 'c8000', '7600', '7200', '7500',
                     'mx-', 'mx9', 'mx4', 'mx2', 'mx1', 'mx8', 'mx10',
                     'vmx', 'ptx', 'acx', '7500r', '7280r'];
    const rtrName = ['rtr', '-rt-', '-rt.', 'router', 'gw-', 'gw.', 'gateway',
                     'wan-', 'wan.', 'border', 'br-', 'br.', 'pe-', 'pe.', '-pe-',
                     'ce-', 'ce.', 'mx-', 'mx.'];
    if (rtrPlat.some(x => p.includes(x)) || rtrName.some(x => n.includes(x))) return 'router';

    // L2 Switch
    const l2Plat = ['2960', '3560', '3750', 'c1000', 'cbs', 'ex2200', 'ex2300', 'ex3300',
                    'ws-c29', 'ws-c35', 'ws-c37', 'ie-', 'ie2000', 'ie3000', 'ie4000',
                    'sf', 'sg', 'c1200', 'c1300'];
    const l2Name = ['access', 'acc-', 'acc.', 'closet', 'idf', 'mdf',
                    'edge-sw', 'tor-', 'tor.', 'leaf-', 'leaf.'];
    if (l2Plat.some(x => p.includes(x)) || l2Name.some(x => n.includes(x))) return 'l2-switch';

    return 'l3-switch';
  },


  // ═══════════════════════════════════════════════════════════════
  // Platform Map — mirrors topology.js 3-tier icon resolution
  //
  // Load via DrawIOExport.loadPlatformMap(jsonData) before calling
  // generate(). Uses the same platform_map.json as the viewer.
  // ═══════════════════════════════════════════════════════════════

  _platformMap: null,

  /**
   * Load the platform mapping JSON (same file the viewer uses).
   * Call once at startup: DrawIOExport.loadPlatformMap(jsonData)
   */
  loadPlatformMap(data) {
    this._platformMap = typeof data === 'string' ? JSON.parse(data) : data;
    const m = this._platformMap;
    const t1 = m && m.platform_patterns ? Object.keys(m.platform_patterns).filter(k => !k.startsWith('_comment')).length : 0;
    const t2 = m && m.fallback_patterns ? Object.keys(m.fallback_patterns).length : 0;
    console.log(`[drawio-export] platformMap loaded: ${t1} platform_patterns, ${t2} fallback_patterns`);
  },

  /**
   * 3-tier shape resolution — mirrors topology.js _getIconForPlatform
   * but returns DrawIO shape strings instead of SVG file paths.
   *
   * Tier 1: Exact platform_patterns match (longest first)
   * Tier 2: Fallback patterns on platform + hostname
   * Tier 3: Default by device role
   */
  _resolveShape(platform, nodeId) {
    const map = this._platformMap;

    // ── Tier 1: Exact platform_patterns match ──
    if (map && map.platform_patterns) {
      const patterns = Object.entries(map.platform_patterns)
        .filter(([k]) => !k.startsWith('_comment'))
        .sort((a, b) => b[0].length - a[0].length);

      for (const [pattern, shape] of patterns) {
        if ((platform || '').includes(pattern)) {
          return shape.endsWith(';') ? shape : shape + ';';
        }
      }
    }

    // ── Tier 2: Fallback patterns (platform + hostname) ──
    if (map && map.fallback_patterns) {
      const pLower = (platform || '').toLowerCase();
      const nLower = (nodeId || '').toLowerCase();

      for (const [, config] of Object.entries(map.fallback_patterns)) {
        const platMatch = (config.platform_patterns || []).some(p => pLower.includes(p));
        const nameMatch = (config.name_patterns || []).some(p => nLower.includes(p));

        if (platMatch || nameMatch) {
          const shape = config.shape;
          if (shape) return shape.endsWith(';') ? shape : shape + ';';
        }
      }
    }

    // ── Tier 3: Default by device role (existing behavior) ──
    const role = this.detectDeviceRole(platform, nodeId);
    return this._roleShapes[role] || this._roleShapes['l3-switch'];
  },


  // ═══════════════════════════════════════════════════════════════
  // DrawIO Shape & Color Mapping
  // ═══════════════════════════════════════════════════════════════

  // Role → DrawIO Cisco stencil shape (Tier 3 fallback)
  _roleShapes: {
    'firewall':  'shape=mxgraph.cisco.security.firewall_2;',
    'router':    'shape=mxgraph.cisco.routers.router;',
    'l2-switch': 'shape=mxgraph.cisco.switches.workgroup_switch;',
    'l3-switch': 'shape=mxgraph.cisco.switches.layer_3_switch;',
  },

  // Vendor → DrawIO fill/stroke/font colors (mid-tone for visibility on white)
  _vendorStyle: {
    cisco:    { fill: '#7ECDE8', stroke: '#036897', font: '#003B5C' },
    arista:   { fill: '#7BC8A0', stroke: '#1A6B40', font: '#0E3D24' },
    juniper:  { fill: '#F5B87A', stroke: '#C96A1F', font: '#5C3010' },
    paloalto: { fill: '#F5A08E', stroke: '#D04425', font: '#6B2010' },
    fortinet: { fill: '#F09088', stroke: '#C41E14', font: '#6B100A' },
    default:  { fill: '#8BB8F0', stroke: '#3070CC', font: '#1A3060' },
  },

  _undiscoveredStyle: { fill: '#FFE0E0', stroke: '#FF6B6B', font: '#993333' },

  // Node dimensions in DrawIO units
  NODE_WIDTH: 60,
  NODE_HEIGHT: 60,

  // Shape-mode dimensions (wider for label text)
  SHAPE_NODE_WIDTH: 140,
  SHAPE_NODE_HEIGHT: 60,

  // Role → human-readable label (for shape mode)
  _roleLabels: {
    'firewall':  'Firewall',
    'router':    'Router',
    'l2-switch': 'Switch',
    'l3-switch': 'L3 Switch',
  },

  // Role → geometric DrawIO shape (no stencils needed)
  _roleGeometry: {
    'firewall':  'shape=mxgraph.basic.octagon2;',
    'router':    'shape=hexagon;perimeter=hexagonPerimeter2;size=0.15;',
    'l2-switch': 'rounded=0;',
    'l3-switch': 'rounded=1;arcSize=12;',
  },

  // Grid layout fallback
  GRID_COL_SPACING: 160,
  GRID_ROW_SPACING: 140,
  GRID_COLS: 5,
  GRID_OFFSET_X: 80,
  GRID_OFFSET_Y: 80,


  // ═══════════════════════════════════════════════════════════════
  // XML Helpers
  // ═══════════════════════════════════════════════════════════════

  _escapeXml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  },

  _nextId: 2,  // 0 and 1 reserved for DrawIO root cells

  _resetIds() { this._nextId = 2; },
  _getId() { return this._nextId++; },


  // ═══════════════════════════════════════════════════════════════
  // Style Builders
  // ═══════════════════════════════════════════════════════════════

  _buildNodeStyle(platform, nodeId, discovered, shapeMode) {
    if (!discovered) {
      const s = this._undiscoveredStyle;
      return shapeMode
        ? `rounded=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=8 4;fillColor=${s.fill};strokeColor=${s.stroke};fontColor=${s.font};fontSize=10;fontStyle=1;verticalAlign=middle;strokeWidth=2;`
        : `rounded=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=8 4;fillColor=${s.fill};strokeColor=${s.stroke};fontColor=${s.font};fontSize=10;fontStyle=1;verticalAlign=middle;`;
    }

    const vendor = this.detectVendor(platform, nodeId);
    const colors = this._vendorStyle[vendor] || this._vendorStyle.default;

    if (shapeMode) {
      return this._buildShapeStyle(platform, nodeId, colors);
    }

    const shape = this._resolveShape(platform, nodeId);
    return `${shape}fillColor=${colors.fill};strokeColor=${colors.stroke};fontColor=${colors.font};fontSize=10;fontStyle=1;verticalLabelPosition=bottom;verticalAlign=top;html=1;`;
  },

  /**
   * Build geometric shape style — no stencils, universally supported.
   * Role determines shape, vendor determines color.
   */
  _buildShapeStyle(platform, nodeId, colors) {
    const role = this.detectDeviceRole(platform, nodeId);
    const geometry = this._roleGeometry[role] || this._roleGeometry['l3-switch'];
    return `${geometry}whiteSpace=wrap;html=1;fillColor=${colors.fill};strokeColor=${colors.stroke};fontColor=${colors.font};fontSize=9;fontStyle=1;strokeWidth=2;verticalAlign=middle;`;
  },

  _buildEdgeStyle() {
    return 'rounded=1;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#4A9EFF;strokeWidth=1;fontSize=8;fontColor=#333333;labelBackgroundColor=#FFFFFF;endArrow=none;startArrow=none;';
  },


  // ═══════════════════════════════════════════════════════════════
  // Position Calculation
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build position map from Cytoscape positions or fall back to grid.
   * Cytoscape positions are node-center; DrawIO positions are top-left.
   * Normalizes to positive coords with margin.
   */
  _buildPositions(nodeIds, cyPositions, nodeW, nodeH) {
    const positions = {};
    const w = nodeW || this.NODE_WIDTH;
    const h = nodeH || this.NODE_HEIGHT;

    if (cyPositions && Object.keys(cyPositions).length > 0) {
      // Find bounding box
      let minX = Infinity, minY = Infinity;
      for (const id of nodeIds) {
        const pos = cyPositions[id];
        if (pos) {
          minX = Math.min(minX, pos.x);
          minY = Math.min(minY, pos.y);
        }
      }

      // Scale up — Cytoscape uses tighter spacing than DrawIO
      const scale = 1.8;
      const marginX = this.GRID_OFFSET_X;
      const marginY = this.GRID_OFFSET_Y;
      const halfW = w / 2;
      const halfH = h / 2;

      for (const id of nodeIds) {
        const pos = cyPositions[id];
        if (pos) {
          // Convert center → top-left
          positions[id] = {
            x: Math.round((pos.x - minX) * scale + marginX - halfW),
            y: Math.round((pos.y - minY) * scale + marginY - halfH),
          };
        } else {
          positions[id] = { x: marginX, y: marginY };
        }
      }
    } else {
      // Grid fallback
      let idx = 0;
      for (const id of nodeIds) {
        const col = idx % this.GRID_COLS;
        const row = Math.floor(idx / this.GRID_COLS);
        positions[id] = {
          x: this.GRID_OFFSET_X + col * this.GRID_COL_SPACING,
          y: this.GRID_OFFSET_Y + row * this.GRID_ROW_SPACING,
        };
        idx++;
      }
    }

    return positions;
  },


  // ═══════════════════════════════════════════════════════════════
  // Main Export
  // ═══════════════════════════════════════════════════════════════

  /**
   * Generate DrawIO XML from topology data.
   *
   * @param {Object} mapData  SC2 map.json: { "device": { node_details, peers } }
   * @param {Object} [options]
   * @param {Object} [options.positions]           { nodeId: { x, y } } from Cytoscape
   * @param {string} [options.title]               Diagram title (default: 'Network Topology')
   * @param {boolean} [options.includeUndiscovered] Include undiscovered placeholders (default: true)
   * @param {string}  [options.shapeMode]           'icons' (default) or 'shapes'
   * @returns {string} Complete .drawio XML
   */
  generate(mapData, options = {}) {
    if (!mapData || typeof mapData !== 'object') {
      throw new Error('mapData must be an SC2 map.json object');
    }

    const {
      positions: cyPositions = null,
      title = 'Network Topology',
      includeUndiscovered = true,
      shapeMode = 'icons',
    } = options;

    const useShapes = shapeMode === 'shapes';
    const nodeW = useShapes ? this.SHAPE_NODE_WIDTH : this.NODE_WIDTH;
    const nodeH = useShapes ? this.SHAPE_NODE_HEIGHT : this.NODE_HEIGHT;

    this._resetIds();

    // ── Parse topology ──
    const nodes = [];
    const edges = [];
    const nodeSet = new Set();
    const edgeSet = new Set();

    // Discovered devices
    for (const [deviceName, deviceData] of Object.entries(mapData)) {
      const details = deviceData.node_details || {};
      nodeSet.add(deviceName);
      nodes.push({
        id: deviceName,
        label: deviceName,
        ip: details.ip || '',
        platform: details.platform || '',
        discovered: true,
      });
    }

    // Edges + undiscovered peers
    for (const [deviceName, deviceData] of Object.entries(mapData)) {
      const peers = deviceData.peers || {};

      for (const [peerName, peerData] of Object.entries(peers)) {
        if (!nodeSet.has(peerName)) {
          nodeSet.add(peerName);
          if (includeUndiscovered) {
            nodes.push({
              id: peerName, label: peerName,
              ip: '', platform: 'Undiscovered', discovered: false,
            });
          }
        }

        const edgeKey = [deviceName, peerName].sort().join('--');
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);

          let label = '';
          const connections = peerData.connections || [];
          if (connections.length === 1 && connections[0].length >= 2) {
            label = `${connections[0][0]} \u2194 ${connections[0][1]}`;
          } else if (connections.length > 1) {
            label = connections.map(c => `${c[0]} \u2194 ${c[1]}`).join('\n');
          }

          const srcOk = includeUndiscovered || mapData[deviceName];
          const tgtOk = includeUndiscovered || mapData[peerName];
          if (srcOk && tgtOk) {
            edges.push({ source: deviceName, target: peerName, label });
          }
        }
      }
    }

    // ── Positions ──
    const nodeIds = nodes.map(n => n.id);
    const positions = this._buildPositions(nodeIds, cyPositions, nodeW, nodeH);

    // ── Cell ID map ──
    const cellIds = {};
    for (const node of nodes) {
      cellIds[node.id] = this._getId();
    }

    // ── Build XML ──
    const xml = [];
    xml.push('<?xml version="1.0" encoding="UTF-8"?>');
    xml.push(`<mxfile host="sc-js" modified="${new Date().toISOString()}" type="device">`);
    xml.push(`  <diagram name="${this._escapeXml(title)}" id="topology">`);
    xml.push('    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">');
    xml.push('      <root>');
    xml.push('        <mxCell id="0"/>');
    xml.push('        <mxCell id="1" parent="0"/>');

    // Nodes
    for (const node of nodes) {
      const cid = cellIds[node.id];
      const pos = positions[node.id] || { x: 0, y: 0 };
      const style = this._buildNodeStyle(node.platform, node.id, node.discovered, useShapes);

      // Label: hostname \n ip \n platform (platform truncated when long)
      let label;
      if (node.discovered) {
        label = this._escapeXml(node.label);
        if (node.ip) label += '&#xa;' + this._escapeXml(node.ip);
        if (node.platform) {
          const plat = node.platform.length > 24 ? node.platform.slice(0, 22) + '…' : node.platform;
          label += '&#xa;' + this._escapeXml(plat);
        }
      } else {
        label = this._escapeXml(node.label) + '&#xa;?';
      }

      xml.push(`        <mxCell id="${cid}" value="${label}" style="${style}" vertex="1" parent="1">`);
      xml.push(`          <mxGeometry x="${pos.x}" y="${pos.y}" width="${nodeW}" height="${nodeH}" as="geometry"/>`);
      xml.push('        </mxCell>');
    }

    // Edges
    for (const edge of edges) {
      const eid = this._getId();
      const src = cellIds[edge.source];
      const tgt = cellIds[edge.target];
      if (src === undefined || tgt === undefined) continue;

      const style = this._buildEdgeStyle();
      const label = this._escapeXml(edge.label);

      xml.push(`        <mxCell id="${eid}" value="${label}" style="${style}" edge="1" parent="1" source="${src}" target="${tgt}">`);
      xml.push('          <mxGeometry relative="1" as="geometry"/>');
      xml.push('        </mxCell>');
    }

    xml.push('      </root>');
    xml.push('    </mxGraphModel>');
    xml.push('  </diagram>');
    xml.push('</mxfile>');

    return xml.join('\n');
  },


  // ═══════════════════════════════════════════════════════════════
  // Convenience: Extract positions from CytoscapeViewer
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get current visible node positions from a CytoscapeViewer instance.
   * @param {CytoscapeViewer} viewer
   * @returns {Object|null} { nodeId: { x, y } }
   */
  getPositionsFromViewer(viewer) {
    if (!viewer || !viewer.cy) return null;
    const positions = {};
    viewer.cy.nodes(':visible').forEach(node => {
      const pos = node.position();
      positions[node.id()] = { x: pos.x, y: pos.y };
    });
    return positions;
  },
};


// ── Export for both browser and Node.js ──
if (typeof window !== 'undefined') {
  window.DrawIOExport = DrawIOExport;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DrawIOExport };
}