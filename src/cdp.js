/**
 * secure-cartography-js — CDP Neighbor Collector.
 *
 * Ported from map_pioneer snmp/collectors/cdp.py.
 * Collects CDP (Cisco Discovery Protocol) neighbor information.
 *
 * CDP is simpler than LLDP:
 * - No subtype encoding (device_id is always a string, address is always binary IP)
 * - Two-part index: cdpCacheIfIndex.cdpCacheDeviceIndex
 * - Column-by-column walk (device_id first to establish entries, then other columns)
 */

'use strict';

const { CDP } = require('./oids');
const { Neighbor, NeighborProtocol } = require('./models');
const { decodeString, decodeIp, isValidIpv4 } = require('./parsers');
const { resolveInterfaceName } = require('./interfaces');

/**
 * Get CDP neighbors from device.
 *
 * Queries CISCO-CDP-MIB for neighbor information. Uses the interface
 * table to resolve local ifIndex to interface names.
 *
 * @param {object} walker - Walker implementation
 * @param {object} [options]
 * @param {Object<number, import('../../models').Interface>} [options.interfaceTable]
 *   Pre-fetched interface table for name resolution
 * @param {number} [options.timeout=5000] - Timeout in ms
 * @param {boolean} [options.verbose=false] - Enable debug output
 * @returns {Promise<import('../../models').Neighbor[]>} List of Neighbor instances
 */
async function getCdpNeighbors(walker, options = {}) {
  const { interfaceTable = null, timeout = 5000, verbose = false } = options;

  const _vprint = verbose
    ? (msg) => console.log(`  [cdp] ${msg}`)
    : () => {};

  // Temporary storage keyed by CDP index (ifIndex.deviceIndex)
  const neighborsRaw = {};

  // -----------------------------------------------------------------------
  // Query cdpCacheDeviceId first to establish entries
  // -----------------------------------------------------------------------
  _vprint('Querying cdpCacheDeviceId...');
  let results = await walker.walk(CDP.CACHE_DEVICE_ID, { timeout });

  if (!results || !results.length) {
    _vprint('No CDP data available');
    return [];
  }

  for (const { oid, value } of results) {
    const deviceId = decodeString(value);

    // Skip empty or invalid entries
    if (!deviceId || ['', '(', '(\x00', 'CW_'].includes(deviceId)) {
      continue;
    }

    // Extract index from OID: base.ifIndex.deviceIndex
    const parts = oid.split('.');
    if (parts.length >= 2) {
      const ifIndex = parseInt(parts[parts.length - 2], 10);
      const index = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;

      neighborsRaw[index] = {
        index,
        if_index: ifIndex,
        device_id: deviceId,
      };
    }
  }

  _vprint(`Found ${Object.keys(neighborsRaw).length} CDP entries`);

  if (!Object.keys(neighborsRaw).length) {
    return [];
  }

  // -----------------------------------------------------------------------
  // Query cdpCacheDevicePort (remote port)
  // -----------------------------------------------------------------------
  _vprint('Querying cdpCacheDevicePort...');
  results = await walker.walk(CDP.CACHE_DEVICE_PORT, { timeout });

  for (const { oid, value } of results) {
    const parts = oid.split('.');
    if (parts.length >= 2) {
      const index = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      if (index in neighborsRaw) {
        neighborsRaw[index].remote_port = decodeString(value);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Query cdpCacheAddress (IP address — binary encoded)
  // -----------------------------------------------------------------------
  _vprint('Querying cdpCacheAddress...');
  results = await walker.walk(CDP.CACHE_ADDRESS, { timeout });

  for (const { oid, value } of results) {
    const parts = oid.split('.');
    if (parts.length >= 2) {
      const index = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      if (index in neighborsRaw) {
        const ipAddr = decodeIp(value);
        if (isValidIpv4(ipAddr)) {
          neighborsRaw[index].ip_address = ipAddr;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Query cdpCachePlatform
  // -----------------------------------------------------------------------
  _vprint('Querying cdpCachePlatform...');
  results = await walker.walk(CDP.CACHE_PLATFORM, { timeout });

  for (const { oid, value } of results) {
    const parts = oid.split('.');
    if (parts.length >= 2) {
      const index = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      if (index in neighborsRaw) {
        neighborsRaw[index].platform = decodeString(value);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Query cdpCacheVersion (software version string)
  // -----------------------------------------------------------------------
  _vprint('Querying cdpCacheVersion...');
  results = await walker.walk(CDP.CACHE_VERSION, { timeout });

  for (const { oid, value } of results) {
    const parts = oid.split('.');
    if (parts.length >= 2) {
      const index = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      if (index in neighborsRaw) {
        neighborsRaw[index].version = decodeString(value);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Convert to Neighbor objects
  // -----------------------------------------------------------------------
  const neighbors = [];

  for (const [index, data] of Object.entries(neighborsRaw)) {
    let deviceId = data.device_id || '';

    // Skip entries with no meaningful device ID
    if (!deviceId || ['', 'N/A', 'n/a'].includes(deviceId)) {
      if (!data.ip_address) continue;
      deviceId = data.ip_address;
    }

    // Resolve local interface name
    const ifIndex = data.if_index || 0;
    const localInterface = interfaceTable
      ? resolveInterfaceName(ifIndex, interfaceTable)
      : `ifIndex_${ifIndex}`;

    const neighbor = Neighbor.fromCdp({
      localInterface,
      deviceId,
      remotePort:  data.remote_port || '',
      ipAddress:   data.ip_address || null,
      platform:    data.platform || null,
      localIfIndex: ifIndex,
      rawIndex:    index,
    });

    // Add version to description if present
    if (data.version) {
      neighbor.remoteDescription = data.version;
    }

    neighbors.push(neighbor);
  }

  _vprint(`Returning ${neighbors.length} valid CDP neighbors`);
  return neighbors;
}

/**
 * Get raw CDP neighbor data as plain objects.
 * Useful for debugging or custom processing.
 *
 * @param {object} walker
 * @param {object} [options]
 * @param {number} [options.timeout=5000]
 * @param {boolean} [options.verbose=false]
 * @returns {Promise<Object<string, object>>} index → raw neighbor data
 */
async function getCdpNeighborsRaw(walker, options = {}) {
  const { timeout = 5000 } = options;
  const neighbors = {};

  const columns = [
    [CDP.CACHE_DEVICE_ID,    'device_id'],
    [CDP.CACHE_DEVICE_PORT,  'remote_port'],
    [CDP.CACHE_ADDRESS,      'ip_address'],
    [CDP.CACHE_PLATFORM,     'platform'],
    [CDP.CACHE_VERSION,      'version'],
    [CDP.CACHE_CAPABILITIES, 'capabilities'],
    [CDP.CACHE_NATIVE_VLAN,  'native_vlan'],
  ];

  for (const [oidBase, fieldName] of columns) {
    const results = await walker.walk(oidBase, { timeout });

    for (const { oid, value } of results) {
      const parts = oid.split('.');
      if (parts.length >= 2) {
        const index = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;

        if (!(index in neighbors)) {
          neighbors[index] = {
            index,
            if_index: parseInt(parts[parts.length - 2], 10),
          };
        }

        // Special handling for IP address (binary encoded)
        if (fieldName === 'ip_address') {
          neighbors[index][fieldName] = decodeIp(value);
        } else {
          neighbors[index][fieldName] = decodeString(value);
        }
      }
    }
  }

  return neighbors;
}

module.exports = {
  getCdpNeighbors,
  getCdpNeighborsRaw,
};