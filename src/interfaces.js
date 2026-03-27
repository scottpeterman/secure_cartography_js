/**
 * secure-cartography-js — Interface Table Collector.
 *
 * Ported from map_pioneer snmp/collectors/interfaces.py.
 * Collects interface information from IF-MIB (ifName, ifDescr, ifAlias).
 * Used for resolving ifIndex references in CDP/LLDP tables.
 */

'use strict';

const { INTERFACES } = require('./oids');
const { Interface, InterfaceStatus } = require('./models');
const { decodeString, decodeInt, decodeMac } = require('./parsers');

/**
 * Get interface table from device.
 *
 * Queries IF-MIB for interface information, returning an object
 * keyed by ifIndex for fast lookups during neighbor processing.
 *
 * @param {object} walker - Walker implementation
 * @param {object} [options]
 * @param {number} [options.timeout=5000] - Timeout in ms
 * @param {boolean} [options.verbose=false] - Enable debug output
 * @returns {Promise<Object<number, Interface>>} ifIndex → Interface map
 */
async function getInterfaceTable(walker, options = {}) {
  const { timeout = 5000, verbose = false } = options;
  const interfaces = {};

  const _vprint = verbose
    ? (msg) => console.log(`  [interfaces] ${msg}`)
    : () => {};

  // Query ifName (preferred short name like "Gi0/1")
  _vprint('Querying ifName...');
  let results = await walker.walk(INTERFACES.IF_NAME, { timeout });

  for (const { oid, value } of results) {
    try {
      const ifIndex = parseInt(oid.split('.').pop(), 10);
      const name = decodeString(value);
      if (!(ifIndex in interfaces)) {
        interfaces[ifIndex] = new Interface({ name, ifIndex });
      } else {
        interfaces[ifIndex].name = name;
      }
    } catch (_) {
      continue;
    }
  }

  _vprint(`  Got ${results.length} ifName entries`);

  // Query ifDescr (often same as ifName, but sometimes more descriptive)
  _vprint('Querying ifDescr...');
  results = await walker.walk(INTERFACES.IF_DESCR, { timeout });

  for (const { oid, value } of results) {
    try {
      const ifIndex = parseInt(oid.split('.').pop(), 10);
      const descr = decodeString(value);
      if (!(ifIndex in interfaces)) {
        interfaces[ifIndex] = new Interface({ name: descr, ifIndex, description: descr });
      } else {
        interfaces[ifIndex].description = descr;
      }
    } catch (_) {
      continue;
    }
  }

  _vprint(`  Got ${results.length} ifDescr entries`);

  // Query ifAlias (user-configured description)
  _vprint('Querying ifAlias...');
  results = await walker.walk(INTERFACES.IF_ALIAS, { timeout });

  for (const { oid, value } of results) {
    try {
      const ifIndex = parseInt(oid.split('.').pop(), 10);
      const alias = decodeString(value);
      if (alias && ifIndex in interfaces) {
        interfaces[ifIndex].alias = alias;
      }
    } catch (_) {
      continue;
    }
  }

  _vprint(`  Got ${results.length} ifAlias entries`);
  _vprint(`Total interfaces: ${Object.keys(interfaces).length}`);

  return interfaces;
}

/**
 * Get extended interface table including status, MAC, speed, MTU.
 *
 * Slower than getInterfaceTable due to additional walks.
 *
 * @param {object} walker
 * @param {object} [options]
 * @param {number} [options.timeout=5000]
 * @param {boolean} [options.verbose=false]
 * @returns {Promise<Object<number, Interface>>} ifIndex → Interface map
 */
async function getInterfaceTableExtended(walker, options = {}) {
  const { timeout = 5000, verbose = false } = options;

  // Start with basic interface table
  const interfaces = await getInterfaceTable(walker, { timeout, verbose });

  if (!Object.keys(interfaces).length) {
    return interfaces;
  }

  const _vprint = verbose
    ? (msg) => console.log(`  [interfaces] ${msg}`)
    : () => {};

  // Query ifOperStatus
  _vprint('Querying ifOperStatus...');
  let results = await walker.walk(INTERFACES.IF_OPER_STATUS, { timeout });

  for (const { oid, value } of results) {
    try {
      const ifIndex = parseInt(oid.split('.').pop(), 10);
      const statusInt = decodeInt(value);

      if (ifIndex in interfaces && statusInt != null) {
        if (statusInt === INTERFACES.OPER_STATUS_UP) {
          interfaces[ifIndex].status = InterfaceStatus.UP;
        } else if (statusInt === INTERFACES.OPER_STATUS_DOWN) {
          interfaces[ifIndex].status = InterfaceStatus.DOWN;
        } else if (statusInt === INTERFACES.OPER_STATUS_LOWER_LAYER_DOWN) {
          interfaces[ifIndex].status = InterfaceStatus.ADMIN_DOWN;
        } else {
          interfaces[ifIndex].status = InterfaceStatus.UNKNOWN;
        }
      }
    } catch (_) {
      continue;
    }
  }

  // Query ifPhysAddress (MAC)
  _vprint('Querying ifPhysAddress...');
  results = await walker.walk(INTERFACES.IF_PHYS_ADDRESS, { timeout });

  for (const { oid, value } of results) {
    try {
      const ifIndex = parseInt(oid.split('.').pop(), 10);
      const mac = decodeMac(value);

      if (ifIndex in interfaces && mac && mac.includes(':')) {
        interfaces[ifIndex].macAddress = mac;
      }
    } catch (_) {
      continue;
    }
  }

  // Query ifHighSpeed (Mbps)
  _vprint('Querying ifHighSpeed...');
  results = await walker.walk(INTERFACES.IF_HIGH_SPEED, { timeout });

  for (const { oid, value } of results) {
    try {
      const ifIndex = parseInt(oid.split('.').pop(), 10);
      const speed = decodeInt(value);

      if (ifIndex in interfaces && speed != null) {
        interfaces[ifIndex].speedMbps = speed;
      }
    } catch (_) {
      continue;
    }
  }

  // Query ifMtu
  _vprint('Querying ifMtu...');
  results = await walker.walk(INTERFACES.IF_MTU, { timeout });

  for (const { oid, value } of results) {
    try {
      const ifIndex = parseInt(oid.split('.').pop(), 10);
      const mtu = decodeInt(value);

      if (ifIndex in interfaces && mtu != null) {
        interfaces[ifIndex].mtu = mtu;
      }
    } catch (_) {
      continue;
    }
  }

  return interfaces;
}

/**
 * Build simple ifIndex → name lookup from interface table.
 *
 * @param {Object<number, Interface>} interfaces
 * @returns {Object<number, string>}
 */
function buildInterfaceLookup(interfaces) {
  const lookup = {};
  for (const [ifIndex, iface] of Object.entries(interfaces)) {
    lookup[ifIndex] = iface.name || iface.description || `ifIndex_${ifIndex}`;
  }
  return lookup;
}

/**
 * Resolve ifIndex to interface name. Falls back to 'ifIndex_N'.
 *
 * @param {number} ifIndex
 * @param {Object<number, Interface>} interfaces - ifIndex → Interface map
 * @returns {string} Interface name
 */
function resolveInterfaceName(ifIndex, interfaces) {
  if (ifIndex in interfaces) {
    const iface = interfaces[ifIndex];
    return iface.name || iface.description || `ifIndex_${ifIndex}`;
  }
  return `ifIndex_${ifIndex}`;
}

module.exports = {
  getInterfaceTable,
  getInterfaceTableExtended,
  buildInterfaceLookup,
  resolveInterfaceName,
};