/**
 * secure-cartography-js — Concurrent Discovery Engine.
 *
 * High-level discovery orchestration with pluggable credential
 * provider. SNMP-first, recursive crawl with depth limits.
 *
 * Ported from map_pioneer engine.py (~1,364 lines) with:
 *   - Walker created per-device (net-snmp session per target)
 *   - Collectors take (walker, options) — no target/auth threading
 *   - asyncio.Semaphore → parallelLimit helper
 *   - asyncio.gather → Promise.allSettled
 *   - pysnmp auth → credToWalkerAuth mapping
 *   - aiofiles → fs/promises
 *
 * Features (preserved from map_pioneer):
 *   - Single device discovery
 *   - Recursive crawl with depth limits
 *   - Concurrent discovery within each depth level
 *   - Credential preference caching by /24 subnet
 *   - Atomic deduplication to prevent duplicate discovery
 *   - Structured event emission for GUI integration
 *   - Cancellation support
 *   - Per-device JSON + aggregate map.json output
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const dns = require('dns');
const { promisify } = require('util');

const dnsLookup = promisify(dns.lookup);

const { NetSnmpWalker } = require('./walker');
const { DiscoveryEmitter, EventType, LogLevel } = require('./events');
const { credToWalkerAuth } = require('./creds');
const {
  Device, Interface, Neighbor, DiscoveryResult,
} = require('./models');
const { getSystemInfo, getSysName } = require('./system');
const { getInterfaceTable, getInterfaceTableExtended } = require('./interfaces');
const { getCdpNeighbors } = require('./cdp');
const { getLldpNeighbors } = require('./lldp');
const { getArpTable, lookupIpByMac } = require('./arp');
const {
  extractHostname, buildFqdn,
} = require('./parsers');


// =========================================================================
// Utility
// =========================================================================

const MAC_PATTERN = /^([0-9a-fA-F]{2}[:\-.]?){5}[0-9a-fA-F]{2}$|^([0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}$/;

function isMacAddress(value) {
  if (!value) return false;
  return MAC_PATTERN.test(value);
}

function isIpAddress(value) {
  if (!value) return false;
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

function getSubnet(ip) {
  if (!ip || !isIpAddress(ip)) return '';
  const parts = ip.split('.');
  return parts.slice(0, 3).join('.');
}

function extractPlatform(sysDescr, vendor) {
  if (!sysDescr) return 'Unknown';

  // Arista
  if (sysDescr.includes('Arista')) {
    let model = 'Arista';
    if (sysDescr.includes('vEOS-lab')) model = 'Arista vEOS-lab';
    else if (sysDescr.includes('vEOS')) model = 'Arista vEOS';
    const eosMatch = sysDescr.match(/EOS version (\S+)/);
    const version = eosMatch ? `EOS ${eosMatch[1]}` : '';
    return `${model} ${version}`.trim();
  }

  // Cisco
  if (sysDescr.includes('Cisco IOS') || sysDescr.includes('Cisco')) {
    let model = 'Cisco';
    if (sysDescr.includes('IOSv') || sysDescr.includes('VIOS')) model = 'Cisco IOSv';
    else if (sysDescr.includes('vios_l2')) model = 'Cisco IOS';
    else if (sysDescr.includes('7200')) model = 'Cisco 7200';
    else if (sysDescr.includes('7206VXR')) model = 'Cisco 7206VXR';
    const verMatch = sysDescr.match(/Version (\S+),/);
    if (verMatch) return `${model} IOS ${verMatch[1]}`;
    return model;
  }

  // Juniper
  if (sysDescr.includes('Juniper') || sysDescr.includes('JUNOS')) {
    const verMatch = sysDescr.match(/JUNOS (\S+)/);
    if (verMatch) return `Juniper JUNOS ${verMatch[1]}`;
    return 'Juniper';
  }

  return sysDescr.slice(0, 50).trim();
}


// =========================================================================
// Concurrency Helper
// =========================================================================

/**
 * Run async tasks with a concurrency limit.
 * Returns Promise.allSettled-style results.
 *
 * @param {Array<Function>} tasks - Array of () => Promise
 * @param {number} limit - Max concurrent
 * @returns {Promise<Array<{status, value?, reason?}>>}
 */
async function parallelLimit(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then(
      (value) => { executing.delete(p); return { status: 'fulfilled', value }; },
      (reason) => { executing.delete(p); return { status: 'rejected', reason }; }
    );
    executing.add(p);
    results.push(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}


// =========================================================================
// Interface Normalization
// =========================================================================

const CISCO_REPLACEMENTS = [
  ['GigabitEthernet', 'Gi'],
  ['TenGigabitEthernet', 'Te'],
  ['TenGigE', 'Te'],
  ['FortyGigabitEthernet', 'Fo'],
  ['FortyGigE', 'Fo'],
  ['HundredGigE', 'Hu'],
  ['HundredGigabitEthernet', 'Hu'],
  ['TwentyFiveGigE', 'Twe'],
  ['FastEthernet', 'Fa'],
  ['Ethernet', 'Eth'],
];

function normalizeInterface(iface) {
  if (!iface) return '';
  let result = iface.trim();

  for (const [long, short] of CISCO_REPLACEMENTS) {
    if (result.startsWith(long)) {
      result = short + result.slice(long.length);
      break;
    }
  }

  const poMatch = result.match(/^[Pp]ort-[Cc]hannel(\d+.*)$/);
  if (poMatch) result = `Po${poMatch[1]}`;

  const vlanMatch = result.match(/^[Vv][Ll][Aa][Nn]-?(\d+.*)$/);
  if (vlanMatch) result = `Vl${vlanMatch[1]}`;

  if (result.startsWith('Null')) result = 'Nu' + result.slice(4);
  if (result.startsWith('Loopback')) result = 'Lo' + result.slice(8);

  result = result.replace(/^Et(\d)/, 'Eth$1');

  result = result.replace(
    /^((?:xe|ge|et|ae|irb|em|me|fxp)-?\d+(?:\/\d+)*)\.0$/i,
    '$1'
  );

  return result;
}


// =========================================================================
// Discovery Engine
// =========================================================================

class DiscoveryEngine {
  /**
   * @param {object} [options]
   * @param {object} [options.credentialProvider] - Duck type: getSnmpCredentials(), getSshCredentials()
   * @param {number} [options.timeout=5000] - SNMP timeout in ms
   * @param {boolean} [options.verbose=false]
   * @param {boolean} [options.noDns=false]
   * @param {number} [options.maxConcurrent=20]
   * @param {DiscoveryEmitter} [options.events]
   * @param {Map} [options.sttLookup] - STT proxy lookup: IP → { host, port, label }
   */
  constructor(options = {}) {
    this.credentialProvider = options.credentialProvider || null;
    this.timeout = (options.timeout || 5) * 1000; // Convert seconds to ms
    this.verbose = options.verbose || false;
    this.noDns = options.noDns || false;
    this.maxConcurrent = options.maxConcurrent || 20;
    this.events = options.events || new DiscoveryEmitter();

    // STT-SNMP proxy lookup: real device IP → { host, port, label }
    this._sttLookup = options.sttLookup || null;

    // Deduplication
    this._claimed = new Set();
    this._discoveredSysnames = new Set();

    // Credential preference cache: '/24 subnet' → { credName, auth }
    this._subnetPreferences = new Map();
  }

  _vprint(msg, level = 1) {
    if (this.verbose) {
      const indent = '  '.repeat(level);
      console.log(`${indent}[discovery] ${msg}`);
      // Emit to GUI via event system
      if (this.events) {
        this.events.log(`${indent}${msg}`, LogLevel.DEBUG);
      }
    }
  }

  _log(message, level = LogLevel.INFO, device = '') {
    this.events.log(message, level, device);
    if (this.verbose || level === LogLevel.WARNING || level === LogLevel.ERROR) {
      console.log(`  [discovery] ${message}`);
    }
  }

  // =====================================================================
  // Walker Creation
  // =====================================================================

  /**
   * Resolve target through STT proxy if configured.
   * Returns { host, port } for walker connection.
   */
  _resolveTarget(target) {
    if (this._sttLookup && this._sttLookup.has(target)) {
      const mapping = this._sttLookup.get(target);
      this._vprint(`STT proxy: ${target} → ${mapping.host}:${mapping.port} (${mapping.label})`, 2);
      return { host: mapping.host, port: mapping.port };
    }
    return { host: target, port: 161 };
  }

  /**
   * Create a walker for a target with given auth.
   * Routes through STT proxy when --stt-file is configured.
   * Caller is responsible for closing the walker.
   */
  _createWalker(target, auth) {
    const { host, port } = this._resolveTarget(target);
    return new NetSnmpWalker(host, auth, {
      timeout: this.timeout,
      verbose: this.verbose,
      port,
    });
  }

  // =====================================================================
  // sysName Resolution (lightweight probe)
  // =====================================================================

  async _resolveSysname(ip) {
    try {
      let auth = null;

      // Check subnet preference cache first
      const subnet = getSubnet(ip);
      if (this._subnetPreferences.has(subnet)) {
        auth = this._subnetPreferences.get(subnet).auth;
      }

      // Fall back to first credential
      if (!auth && this.credentialProvider) {
        const creds = this.credentialProvider.getSnmpCredentials();
        if (creds.length > 0) {
          auth = credToWalkerAuth(creds[0]);
        }
      }

      if (!auth) return null;

      const { host, port } = this._resolveTarget(ip);
      const walker = new NetSnmpWalker(host, auth, { timeout: 3000, port });
      try {
        const name = await getSysName(walker);
        if (name) return name.trim().replace(/\.$/, '');
      } finally {
        walker.close();
      }
    } catch (e) {
      // Probe failed — that's fine
    }
    return null;
  }

  // =====================================================================
  // Exclusion
  // =====================================================================

  _shouldExcludeDevice(device, excludePatterns) {
    if (!excludePatterns || excludePatterns.length === 0) return { excluded: false, pattern: '' };

    const expanded = [];
    for (const p of excludePatterns) {
      for (const part of p.split(',')) {
        const trimmed = part.trim();
        if (trimmed) expanded.push(trimmed);
      }
    }

    const fields = [
      (device.sysDescr || '').toLowerCase(),
      (device.hostname || '').toLowerCase(),
      (device.sysName || '').toLowerCase(),
    ];

    for (const pattern of expanded) {
      const lower = pattern.toLowerCase();
      for (const field of fields) {
        if (field && field.includes(lower)) {
          return { excluded: true, pattern };
        }
      }
    }

    return { excluded: false, pattern: '' };
  }

  // =====================================================================
  // Deduplication
  // =====================================================================

  _normalizeId(identifier) {
    if (!identifier) return '';
    return identifier.toLowerCase().replace(/\.$/, '');
  }

  _tryClaim(target) {
    const norm = this._normalizeId(target);
    if (!norm) return false;
    if (this._claimed.has(norm)) return false;
    this._claimed.add(norm);
    return true;
  }

  _registerDevice(device) {
    const ids = [device.ipAddress, device.hostname, device.sysName, device.fqdn];
    for (const id of ids) {
      if (id) this._claimed.add(this._normalizeId(id));
    }
  }

  _isClaimed(target) {
    return this._claimed.has(this._normalizeId(target));
  }

  resetState() {
    this._claimed.clear();
    this._discoveredSysnames.clear();
    this._subnetPreferences.clear();
    this.events.resetStats();
  }

  // =====================================================================
  // Credential Management
  // =====================================================================

  async _getWorkingCredential(target) {
    const subnet = getSubnet(target);

    // Check subnet preference cache
    if (this._subnetPreferences.has(subnet)) {
      const cached = this._subnetPreferences.get(subnet);
      this._vprint(`Using cached credential '${cached.credName}' for ${subnet}.*`, 3);
      return cached;
    }

    if (!this.credentialProvider) return null;

    const creds = this.credentialProvider.getSnmpCredentials();

    for (const cred of creds) {
      const auth = credToWalkerAuth(cred);
      const { host, port } = this._resolveTarget(target);
      const walker = new NetSnmpWalker(host, auth, { timeout: 3000, port });

      try {
        const name = await Promise.race([
          getSysName(walker),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 5000)
          ),
        ]);

        if (name) {
          this._vprint(`Credential '${cred.name}' works for ${target}`, 2);
          const result = { credName: cred.name, auth };
          if (subnet) this._subnetPreferences.set(subnet, result);
          walker.close();
          return result;
        }
      } catch (e) {
        this._vprint(`Credential '${cred.name}' failed for ${target}: ${e.message}`, 3);
      }

      walker.close();
    }

    return null;
  }

  // =====================================================================
  // Hostname Resolution
  // =====================================================================

  async _resolveHostname(hostname, domains) {
    if (this.noDns) return null;
    if (isIpAddress(hostname)) return hostname;

    const hasDomain = domains.some(d => hostname.endsWith('.' + d));

    if (hasDomain) {
      try {
        const result = await dnsLookup(hostname);
        this._vprint(`Resolved ${hostname} → ${result.address}`, 3);
        return result.address;
      } catch (e) {
        return null;
      }
    }

    for (const domain of domains) {
      const fqdn = `${hostname}.${domain}`;
      try {
        const result = await dnsLookup(fqdn);
        this._vprint(`Resolved ${hostname} → ${fqdn} → ${result.address}`, 3);
        return result.address;
      } catch (e) {
        continue;
      }
    }

    return null;
  }

  // =====================================================================
  // Single Device Discovery
  // =====================================================================

  /**
   * Discover a single device.
   *
   * @param {string} target - IP address or hostname
   * @param {object} [options]
   * @param {object} [options.auth] - Pre-built walker auth (skip credential cycling)
   * @param {string} [options.credName]
   * @param {string[]} [options.domains=[]]
   * @param {number} [options.depth=0]
   * @param {boolean} [options.collectArp=true]
   * @returns {Promise<Device>}
   */
  async discoverDevice(target, options = {}) {
    const startTime = Date.now();
    const domains = options.domains || [];
    const depth = options.depth || 0;
    const collectArp = options.collectArp !== false;
    let auth = options.auth || null;
    let credName = options.credName || null;

    // Resolve hostname to IP
    let deviceIp, hostname;
    if (isIpAddress(target)) {
      deviceIp = target;
      hostname = target;
    } else {
      hostname = target;
      if (this.noDns) {
        return new Device({
          hostname: target,
          ipAddress: '',
          discoverySuccess: false,
          discoveryErrors: [`DNS disabled, cannot resolve: ${target}`],
          depth,
        });
      }
      try {
        const fqdn = buildFqdn(target, domains);
        const result = await dnsLookup(fqdn);
        deviceIp = result.address;
      } catch (e) {
        return new Device({
          hostname: target,
          ipAddress: '',
          discoverySuccess: false,
          discoveryErrors: [`DNS resolution failed for ${target}`],
          depth,
        });
      }
    }

    this._vprint(`Discovering ${hostname} (${deviceIp})`, 1);

    // Get working credential if not provided
    if (!auth) {
      const result = await this._getWorkingCredential(deviceIp);
      if (result) {
        auth = result.auth;
        credName = result.credName;
      } else {
        return new Device({
          hostname,
          ipAddress: deviceIp,
          discoverySuccess: false,
          discoveryErrors: ['No working SNMP credential found'],
          depth,
        });
      }
    }

    // Create walker for this device
    const walker = this._createWalker(deviceIp, auth);

    try {
      // ---- SNMP Discovery ----

      // System info
      this._vprint('Collecting system info...', 2);
      const sysInfo = await getSystemInfo(walker, { verbose: this.verbose });

      // Create device
      const device = new Device({
        hostname,
        ipAddress: deviceIp,
        sysName: sysInfo.sys_name,
        sysDescr: sysInfo.sys_descr,
        sysLocation: sysInfo.sys_location,
        sysContact: sysInfo.sys_contact,
        sysObjectId: sysInfo.sys_object_id,
        uptimeTicks: sysInfo.uptime_ticks,
        vendor: sysInfo.vendor || 'unknown',
        credentialUsed: credName,
        depth,
        discoveredVia: 'snmp',
      });

      // Update hostname if current is IP and we got sysName
      if (device.sysName && isIpAddress(hostname)) {
        const resolvedHostname = extractHostname(device.sysName, domains);
        if (resolvedHostname) {
          device.hostname = resolvedHostname;
          device.fqdn = device.sysName;
        }
      }

      // Interfaces
      this._vprint('Collecting interface table...', 2);
      let interfaceTable = {};
      try {
        interfaceTable = await getInterfaceTableExtended(walker, { verbose: this.verbose });
        device.interfaces = Object.values(interfaceTable);
      } catch (e) {
        device.discoveryErrors.push(`Interface collection failed: ${e.message}`);
      }

      // ARP table
      let arpTable = {};
      if (collectArp) {
        this._vprint('Collecting ARP table...', 2);
        try {
          arpTable = await getArpTable(walker, { verbose: this.verbose });
          device.arpTable = arpTable;
        } catch (e) {
          device.discoveryErrors.push(`ARP collection failed: ${e.message}`);
        }
      }

      // CDP neighbors (Cisco only — but try anyway, non-Cisco returns empty)
      this._vprint('Collecting CDP neighbors...', 2);
      try {
        const cdpNeighbors = await getCdpNeighbors(walker, { interfaceTable, verbose: this.verbose });
        for (const n of cdpNeighbors) {
          if (n.remoteDevice && domains.length > 0) {
            const normalized = extractHostname(n.remoteDevice, domains);
            if (normalized) n.remoteDevice = normalized;
          }
          device.addNeighbor(n);
        }
      } catch (e) {
        device.discoveryErrors.push(`CDP collection failed: ${e.message}`);
      }

      // LLDP neighbors
      this._vprint('Collecting LLDP neighbors...', 2);
      try {
        const lldpNeighbors = await getLldpNeighbors(walker, { interfaceTable, verbose: this.verbose, events: this.events });

        for (const n of lldpNeighbors) {
          // Resolve LLDP chassis_id → IP via ARP if no mgmt address
          if (!n.remoteIp && n.chassisId && Object.keys(arpTable).length > 0) {
            const resolvedIp = lookupIpByMac(n.chassisId, arpTable);
            if (resolvedIp) {
              n.remoteIp = resolvedIp;
              this._vprint(`Resolved ${n.chassisId} to ${resolvedIp} via ARP`, 3);
            }
          }

          if (n.remoteDevice && domains.length > 0) {
            const normalized = extractHostname(n.remoteDevice, domains);
            if (normalized) n.remoteDevice = normalized;
          }

          device.addNeighbor(n);
        }
      } catch (e) {
        device.discoveryErrors.push(`LLDP collection failed: ${e.message}`);
      }

      // Duration
      device.discoveryDurationMs = Date.now() - startTime;

      this._vprint(
        `Discovery complete: ${device.interfaces.length} interfaces, ` +
        `${device.neighbors.length} neighbors in ${device.discoveryDurationMs}ms`,
        1
      );

      return device;

    } finally {
      walker.close();
    }
  }

  // =====================================================================
  // File I/O
  // =====================================================================

  async _writeJsonFile(filepath, data) {
    const content = JSON.stringify(data, null, 2);
    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, content, 'utf-8');
  }

  async _saveDeviceFiles(device, outputDir) {
    const deviceDir = path.join(outputDir, device.hostname || device.ipAddress);
    await fs.mkdir(deviceDir, { recursive: true });

    await this._writeJsonFile(
      path.join(deviceDir, 'device.json'),
      device.toDict()
    );

    if (device.cdpNeighbors && device.cdpNeighbors.length > 0) {
      await this._writeJsonFile(
        path.join(deviceDir, 'cdp.json'),
        device.cdpNeighbors.map(n => n.toDict())
      );
    }

    if (device.lldpNeighbors && device.lldpNeighbors.length > 0) {
      await this._writeJsonFile(
        path.join(deviceDir, 'lldp.json'),
        device.lldpNeighbors.map(n => n.toDict())
      );
    }
  }

  // =====================================================================
  // Crawl
  // =====================================================================

  /**
   * Recursively discover network from seed devices.
   *
   * @param {object} options
   * @param {string[]} options.seeds - Starting IPs or hostnames
   * @param {number} [options.maxDepth=3]
   * @param {string[]} [options.domains=[]]
   * @param {string[]} [options.excludePatterns=[]]
   * @param {string} [options.outputDir]
   * @param {object} [options.cancelSignal] - AbortSignal for cancellation
   * @returns {Promise<DiscoveryResult>}
   */
  async crawl(options) {
    const {
      seeds,
      maxDepth = 3,
      domains = [],
      excludePatterns = [],
      outputDir = null,
      cancelSignal = null,
    } = options;

    this.resetState();

    const result = new DiscoveryResult({
      seedDevices: seeds,
      maxDepth,
      domains,
      excludePatterns,
      startedAt: new Date(),
    });

    this.events.crawlStarted(seeds, maxDepth, domains, excludePatterns, {
      noDns: this.noDns,
      concurrency: this.maxConcurrent,
      timeout: this.timeout / 1000,
    });

    // Claim and queue seeds
    let currentBatch = [];
    for (const seed of seeds) {
      if (this._tryClaim(seed)) {
        currentBatch.push({ target: seed, depth: 0 });
        this.events.deviceQueued(seed, 0);
      }
    }

    if (outputDir) {
      await fs.mkdir(outputDir, { recursive: true });
    }

    // Breadth-first crawl loop
    while (currentBatch.length > 0) {
      // Check cancellation
      if (cancelSignal && cancelSignal.aborted) {
        this.events.crawlCancelled();
        result.completedAt = new Date();
        return result;
      }

      const depth = currentBatch[0].depth;
      const batchSize = currentBatch.length;

      this.events.depthStarted(depth, batchSize);

      // Discover all devices at this depth concurrently
      const tasks = currentBatch.map(({ target, depth: d }) => () =>
        this._discoverWithLimit(target, d, domains)
      );

      const settled = await parallelLimit(tasks, this.maxConcurrent);

      // Process results and collect next batch
      const nextBatch = [];
      let depthDiscovered = 0;
      let depthFailed = 0;

      for (let i = 0; i < settled.length; i++) {
        const { target } = currentBatch[i];
        const settledResult = settled[i];
        result.totalAttempted += 1;

        if (settledResult.status === 'rejected') {
          result.failed += 1;
          depthFailed += 1;
          this.events.deviceFailed(target, String(settledResult.reason), depth);
          continue;
        }

        const device = settledResult.value;

        // Post-discovery dedup: two IPs in the same concurrent batch
        // can resolve to the same device (same sysName)
        if (device.discoverySuccess && device.sysName) {
          const normSysname = this._normalizeId(device.sysName);
          if (this._discoveredSysnames.has(normSysname)) {
            this._vprint(
              `Dedup: ${target} is ${device.sysName} (already discovered via another IP)`, 1
            );
            this._registerDevice(device);
            continue;
          }
          this._discoveredSysnames.add(normSysname);
        }

        this._registerDevice(device);

        if (device.discoverySuccess) {
          result.successful += 1;
          depthDiscovered += 1;
          result.devices.push(device);

          const method = device.discoveredVia || 'unknown';
          this.events.deviceComplete(
            target,
            device.hostname,
            device.ipAddress,
            device.vendor || 'unknown',
            device.neighbors.length,
            device.discoveryDurationMs,
            method,
            depth
          );

          // Check exclusion
          const { excluded, pattern } = this._shouldExcludeDevice(device, excludePatterns);
          if (excluded) {
            result.excluded += 1;
            this.events.deviceExcluded(device.hostname, pattern);
            continue;
          }

          // Save to file
          if (outputDir) {
            try {
              await this._saveDeviceFiles(device, outputDir);
            } catch (e) {
              this._log(`Failed to save ${device.hostname}: ${e.message}`, LogLevel.WARNING, device.hostname);
            }
          }

          // Queue neighbors for next depth
          if (depth < maxDepth) {
            for (const neighbor of device.neighbors) {
              let deviceName = neighbor.remoteDevice;
              let neighborIp = neighbor.remoteIp;

              // MAC-named neighbor resolution
              if (deviceName && isMacAddress(deviceName)) {
                if (neighborIp && !isMacAddress(neighborIp)) {
                  const resolvedName = await this._resolveSysname(neighborIp);
                  if (resolvedName) {
                    this._vprint(`Resolved MAC ${deviceName} → ${resolvedName} via sysName (${neighborIp})`, 2);
                    deviceName = resolvedName;
                  } else {
                    this._vprint(`sysName probe failed for ${deviceName} (${neighborIp}), queuing by IP`, 2);
                    deviceName = null;
                  }
                } else {
                  // MAC name and no usable IP — skip
                  this.events.neighborSkipped(deviceName, 'MAC address, no IP', device.hostname);
                  continue;
                }
              }

              if (neighborIp && isMacAddress(neighborIp)) {
                neighborIp = null;
              }

              // Dedup by device name (sysName) — that's the device identity
              let dedupKey = deviceName || neighborIp;
              if (!dedupKey) continue;

              // Crawl target: prefer IP (avoids DNS failures)
              const crawlTarget = neighborIp || deviceName;

              if (this._tryClaim(dedupKey)) {
                nextBatch.push({ target: crawlTarget, depth: depth + 1 });

                // Also claim the other identifier
                if (neighborIp && neighborIp !== dedupKey) this._tryClaim(neighborIp);
                if (deviceName && deviceName !== dedupKey) this._tryClaim(deviceName);

                this.events.neighborQueued(
                  crawlTarget,
                  neighborIp !== crawlTarget ? neighborIp : null,
                  device.hostname,
                  depth + 1
                );
              } else {
                this.events.neighborSkipped(dedupKey, 'already claimed', device.hostname);
              }
            }
          }

        } else {
          // Discovery failed
          result.failed += 1;
          depthFailed += 1;
          const errorMsg = device.discoveryErrors && device.discoveryErrors.length > 0
            ? device.discoveryErrors.join('; ')
            : 'Unknown error';
          this.events.deviceFailed(target, errorMsg, depth);
        }
      }

      this.events.depthComplete(depth, depthDiscovered, depthFailed);
      currentBatch = nextBatch;
    }

    result.completedAt = new Date();

    // Generate topology map
    let topologyMap = null;
    if (outputDir) {
      topologyMap = this._generateTopologyMap(result.devices);
      const mapFile = path.join(outputDir, 'map.json');
      await this._writeJsonFile(mapFile, topologyMap);
      this._log(`Topology map saved to: ${mapFile}`, LogLevel.INFO);
    }

    if (topologyMap) {
      this.events.topologyUpdated(topologyMap);
    }

    this.events.crawlComplete(
      result.durationSeconds || 0,
      topologyMap
    );

    return result;
  }

  /**
   * Rate-limited single device discovery (used by crawl loop).
   */
  async _discoverWithLimit(target, depth, domains) {
    this.events.deviceStarted(target, depth);
    return this.discoverDevice(target, { domains, depth });
  }

  // =====================================================================
  // Topology Map Generation
  // =====================================================================

  /**
   * Generate topology map from discovered devices.
   * Output format matches SC Map Viewer expectations.
   *
   * @param {Device[]} devices
   * @returns {object} Topology map dict
   */
  _generateTopologyMap(devices) {
    // Build device info lookup
    const deviceInfo = new Map();
    for (const device of devices) {
      if (device.hostname) deviceInfo.set(device.hostname, device);
      if (device.sysName && device.sysName !== device.hostname) {
        deviceInfo.set(device.sysName, device);
      }
      if (device.ipAddress) deviceInfo.set(device.ipAddress, device);
    }

    const getCanonicalName = (device) =>
      device.sysName || device.hostname || device.ipAddress;

    // Collect all discovered device names
    const discoveredDevices = new Set();
    for (const device of devices) {
      const canonical = getCanonicalName(device);
      if (canonical) {
        discoveredDevices.add(canonical);
        if (device.sysName) discoveredDevices.add(device.sysName);
        if (device.hostname) discoveredDevices.add(device.hostname);
      }
    }

    // Helper: was peer discovered?
    const peerWasDiscovered = (peerCanonical, peerOriginal) => {
      return discoveredDevices.has(peerCanonical)
        || discoveredDevices.has(peerOriginal)
        || deviceInfo.has(peerOriginal);
    };

    // Helper: is peer a leaf (no neighbors)?
    const peerIsLeaf = (peerCanonical, peerOriginal) => {
      const dev = deviceInfo.get(peerCanonical) || deviceInfo.get(peerOriginal);
      return dev && dev.neighbors.length === 0;
    };

    // Build topology
    const topology = {};
    const seenDevices = new Set();

    for (const device of devices) {
      const canonicalName = getCanonicalName(device);
      if (!canonicalName || seenDevices.has(canonicalName)) continue;
      seenDevices.add(canonicalName);

      const node = {
        node_details: {
          ip: device.ipAddress,
          platform: extractPlatform(
            device.sysDescr,
            device.vendor
          ),
        },
        peers: {},
      };

      const peerConnections = {};
      const usedLocalInterfaces = new Set();

      for (const neighbor of device.neighbors) {
        if (!neighbor.remoteDevice) continue;

        const localIf = normalizeInterface(neighbor.localInterface);
        const remoteIf = normalizeInterface(neighbor.remoteInterface);

        if (!localIf || !remoteIf) continue;
        if (usedLocalInterfaces.has(localIf)) continue;

        let peerName = neighbor.remoteDevice;
        let canonicalPeer = peerName;
        if (deviceInfo.has(peerName)) {
          canonicalPeer = getCanonicalName(deviceInfo.get(peerName));
        }

        // Check if peer was discovered (for validation)
        const peerDiscovered = peerWasDiscovered(canonicalPeer, peerName);
        if (peerDiscovered) {
          const isLeaf = peerIsLeaf(canonicalPeer, peerName);
          if (!isLeaf) {
            // has_reverse_claim always returns true in Python — preserved
          }
        }

        // Build peer platform
        let peerPlatform = neighbor.remoteDescription
          ? extractPlatform(neighbor.remoteDescription)
          : null;
        if (deviceInfo.has(peerName)) {
          const peerDev = deviceInfo.get(peerName);
          peerPlatform = extractPlatform(peerDev.sysDescr, peerDev.vendor);
        }

        if (!peerConnections[canonicalPeer]) {
          peerConnections[canonicalPeer] = {
            ip: neighbor.remoteIp,
            platform: peerPlatform || 'Unknown',
            connections: [],
          };
        }

        peerConnections[canonicalPeer].connections.push([localIf, remoteIf]);
        usedLocalInterfaces.add(localIf);
      }

      node.peers = peerConnections;
      topology[canonicalName] = node;
    }

    return topology;
  }
}


module.exports = {
  DiscoveryEngine,
  parallelLimit,
  isMacAddress,
  isIpAddress,
  extractPlatform,
  normalizeInterface,
};