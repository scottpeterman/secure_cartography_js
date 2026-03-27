/**
 * secure-cartography-js — LLDP Neighbor Collector.
 *
 * Ported from map_pioneer snmp/collectors/lldp.py.
 * Collects LLDP (Link Layer Discovery Protocol) neighbor information.
 *
 * LLDP is more complex than CDP due to:
 * - Subtype-based encoding for chassis_id and port_id
 * - Separate management address table
 * - Three-part table index (timeMark.localPort.remIndex)
 * - Local port numbering may differ from ifIndex (requires lldpLocPortTable)
 *
 * Walker contract (any object with these async methods):
 *   walker.walk(oid, options)  → [{ oid: string, value: Buffer|number|string }, ...]
 *   walker.get(oid, options)   → { oid: string, value: Buffer|number|string } | null
 *
 * Unlike the Python version where walker receives (target, oid, auth, timeout)
 * on every call, the JS walker owns target and auth from construction.
 * This simplifies every collector signature.
 */

'use strict';

const { LLDP } = require('./oids');
const { Neighbor, NeighborProtocol } = require('./models');
const { LogLevel } = require('./events');
const {
  decodeString, decodeInt, decodeChassisId, decodePortId, isValidIpv4,
} = require('./parsers');
const { resolveInterfaceName } = require('./interfaces');

// =============================================================================
// LLDP Local Port Table
// =============================================================================

/**
 * Build mapping of lldpLocPortNum → interface name.
 *
 * CRITICAL: lldpLocPortNum in the remote table is NOT necessarily
 * the same as ifIndex. This mapping is the correct way to resolve
 * local port numbers to interface names.
 *
 * @param {object} walker - Walker implementation
 * @param {object} [options]
 * @param {number} [options.timeout=10000] - Timeout in ms
 * @param {boolean} [options.verbose=false] - Enable debug output
 * @returns {Promise<Object<number, string>>} lldpLocPortNum → interface name
 */
async function getLldpLocalPortMap(walker, options = {}) {
  const { timeout = 10000, verbose = false, events = null } = options;

  const _vprint = verbose
    ? (msg) => {
        console.log(`  [lldp-local] ${msg}`);
        if (events) events.log(`  ${msg}`, LogLevel.DEBUG);
      }
    : () => {};

  const portMap = {};

  _vprint(`Walking lldpLocPortTable: ${LLDP.LOC_PORT_ID}`);

  try {
    const results = await walker.walk(LLDP.LOC_PORT_ID, { timeout });

    if (results && results.length) {
      _vprint(`Got ${results.length} local port entries`);

      // OID: 1.0.8802.1.1.2.1.3.7.1.3.<lldpLocPortNum>
      //      --- 11 components ------- ^
      const BASE_LEN = 11;

      for (const { oid, value } of results) {
        const parts = oid.split('.');
        if (parts.length > BASE_LEN) {
          try {
            const localPortNum = parseInt(parts[BASE_LEN], 10);
            const portId = decodeString(value);
            if (portId) {
              portMap[localPortNum] = portId;
              _vprint(`  lldpLocPortNum ${localPortNum} -> ${portId}`);
            }
          } catch (_) {
            continue;
          }
        }
      }
    } else {
      _vprint('No lldpLocPortTable data — will fall back to ifIndex');
    }
  } catch (err) {
    _vprint(`Failed to get local port table: ${err.message}`);
  }

  return portMap;
}

// =============================================================================
// LLDP Neighbor Collector
// =============================================================================

/**
 * Column definitions within lldpRemEntry.
 *
 * Key = column number (string, from OID position).
 * Value = [fieldName, isSubtype].
 *
 * Subtypes must be stored and looked up when the corresponding
 * value column arrives. Since a single table walk returns results
 * interleaved by index (not grouped by column), we collect subtypes
 * into a separate dict and reference them during value decoding.
 */
const COLUMN_MAP = {
  '4':  ['chassis_id_subtype', true],
  '5':  ['chassis_id', false],
  '6':  ['port_id_subtype', true],
  '7':  ['port_id', false],
  '8':  ['port_description', false],
  '9':  ['system_name', false],
  '10': ['system_description', false],
  '11': ['capabilities_supported', false],
  '12': ['capabilities_enabled', false],
};

/**
 * OID component count for lldpRemEntry base.
 * 1.0.8802.1.1.2.1.4.1.1 = 10 components
 * Column is at [10], index starts at [11].
 */
const BASE_LEN = 10;

/**
 * Get LLDP neighbors from device.
 *
 * Queries LLDP-MIB lldpRemTable using single-table walk approach
 * which works better on devices where column-by-column walks
 * timeout (e.g., older Juniper).
 *
 * @param {object} walker - Walker implementation
 * @param {object} [options]
 * @param {Object<number, import('./models').Interface>} [options.interfaceTable]
 *   Pre-fetched interface table for name resolution (ifIndex → Interface)
 * @param {number} [options.timeout=10000] - Timeout in ms (LLDP walks can be slow)
 * @param {boolean} [options.verbose=false] - Enable debug output
 * @returns {Promise<import('./models').Neighbor[]>} List of Neighbor instances
 */
async function getLldpNeighbors(walker, options = {}) {
  const { interfaceTable = null, timeout = 10000, verbose = false, events = null } = options;

  const _vprint = verbose
    ? (msg) => {
        console.log(`  [lldp] ${msg}`);
        if (events) events.log(`  ${msg}`, LogLevel.DEBUG);
      }
    : () => {};

  // -----------------------------------------------------------------------
  // Step 1: Get the local port mapping (lldpLocPortNum → interface name)
  // -----------------------------------------------------------------------
  const lldpPortMap = await getLldpLocalPortMap(walker, { timeout, verbose, events });

  if (Object.keys(lldpPortMap).length) {
    _vprint(`Got ${Object.keys(lldpPortMap).length} local port mappings from lldpLocPortTable`);
  } else {
    _vprint('No lldpLocPortTable — falling back to ifIndex resolution');
  }

  // -----------------------------------------------------------------------
  // Step 2: Walk entire lldpRemTable in one shot
  // -----------------------------------------------------------------------
  const neighborsRaw = {};  // idx → { field: value, ... }
  const subtypes = {};      // idx → { chassis_id_subtype: n, port_id_subtype: n }

  _vprint(`Walking lldpRemTable: ${LLDP.REMOTE_TABLE}`);
  const results = await walker.walk(LLDP.REMOTE_TABLE, { timeout });

  if (!results || !results.length) {
    _vprint('No LLDP data available');
    return [];
  }

  _vprint(`Got ${results.length} raw LLDP results`);

  // -----------------------------------------------------------------------
  // Step 3: Parse results into neighborsRaw
  // -----------------------------------------------------------------------
  for (const { oid, value } of results) {
    const parts = oid.split('.');

    // Need at least BASE_LEN + 4 components:
    // base(10) + column(1) + timeMark(1) + localPort(1) + remIndex(1)
    if (parts.length < BASE_LEN + 4) {
      continue;
    }

    const column = parts[BASE_LEN];
    const idx = parts.slice(BASE_LEN + 1).join('.');

    if (!(column in COLUMN_MAP)) {
      continue;
    }

    const [fieldName, isSubtype] = COLUMN_MAP[column];

    // Initialize entry on first encounter
    if (!(idx in neighborsRaw)) {
      neighborsRaw[idx] = { index: idx };
      subtypes[idx] = {};

      // Extract local port number from index (2nd component after column)
      if (parts.length >= BASE_LEN + 3) {
        try {
          const localPortNum = parseInt(parts[BASE_LEN + 2], 10);
          neighborsRaw[idx].local_port_num = localPortNum;
        } catch (_) {
          // Skip
        }
      }
    }

    // Store subtypes for later decoding
    if (isSubtype) {
      const intVal = decodeInt(value);
      subtypes[idx][fieldName] = (intVal != null) ? intVal : 0;
      continue;
    }

    // Decode value based on field type
    if (fieldName === 'chassis_id') {
      const subtype = (subtypes[idx] || {}).chassis_id_subtype ?? LLDP.CHASSIS_SUBTYPE_MAC;
      neighborsRaw[idx].chassis_id = decodeChassisId(subtype, value);
      neighborsRaw[idx].chassis_id_subtype = subtype;
    } else if (fieldName === 'port_id') {
      const subtype = (subtypes[idx] || {}).port_id_subtype ?? LLDP.PORT_SUBTYPE_IF_NAME;
      neighborsRaw[idx].port_id = decodePortId(subtype, value);
      neighborsRaw[idx].port_id_subtype = subtype;
    } else {
      neighborsRaw[idx][fieldName] = decodeString(value);
    }
  }

  _vprint(`Parsed ${Object.keys(neighborsRaw).length} LLDP neighbor entries`);

  // -----------------------------------------------------------------------
  // Step 4: Fetch management addresses
  // -----------------------------------------------------------------------
  await _fetchManagementAddresses(walker, neighborsRaw, { timeout, _vprint });

  // -----------------------------------------------------------------------
  // Step 5: Convert to Neighbor objects
  // -----------------------------------------------------------------------
  const neighbors = [];

  for (const [idx, data] of Object.entries(neighborsRaw)) {
    const systemName = data.system_name || '';
    const chassisId  = data.chassis_id || '';
    const mgmtAddr   = data.management_address || null;

    // Skip entries with no useful identification
    if (!systemName && !chassisId && !mgmtAddr) {
      continue;
    }

    // Filter garbage values
    const garbage = ['', '(', '(\x00'];
    const cleanSysName  = garbage.includes(systemName) ? null : systemName;
    const cleanChassisId = garbage.includes(chassisId) ? null : chassisId;

    if (!cleanSysName && !cleanChassisId && !mgmtAddr) {
      continue;
    }

    // Resolve local interface name
    const localPortNum = data.local_port_num || 0;
    let localInterface = null;

    // Try lldpLocPortTable first (correct way)
    if (localPortNum in lldpPortMap) {
      localInterface = lldpPortMap[localPortNum];
      _vprint(`Resolved port ${localPortNum} via lldpLocPortTable -> ${localInterface}`);
    }
    // Fall back to ifIndex (may not always match!)
    else if (interfaceTable) {
      localInterface = resolveInterfaceName(localPortNum, interfaceTable);
      _vprint(`Resolved port ${localPortNum} via ifIndex (fallback) -> ${localInterface}`);
    }

    if (!localInterface) {
      localInterface = `ifIndex_${localPortNum}`;
    }

    const neighbor = Neighbor.fromLldp({
      localInterface,
      systemName:        cleanSysName,
      portId:            data.port_id || null,
      managementAddress: mgmtAddr,
      chassisId:         cleanChassisId,
      portDescription:   data.port_description || null,
      systemDescription: data.system_description || null,
      capabilities:      data.capabilities_enabled || null,
      chassisIdSubtype:  data.chassis_id_subtype ?? null,
      portIdSubtype:     data.port_id_subtype ?? null,
      localIfIndex:      localPortNum,
      rawIndex:          idx,
    });

    neighbors.push(neighbor);
  }

  _vprint(`Returning ${neighbors.length} valid LLDP neighbors`);
  return neighbors;
}

// =============================================================================
// Management Address Table
// =============================================================================

/**
 * Fetch management addresses from lldpRemManAddrTable.
 * Updates neighborsRaw dict in place with 'management_address' field.
 *
 * The management address is encoded in the OID itself:
 *   ....<timeMark>.<localPort>.<remIndex>.<addrType>.<addrLen>.<addr1>.<addr2>.<addr3>.<addr4>
 *
 * For IPv4 (addrType=1), the last 4 OID components are the IP octets.
 *
 * @param {object} walker
 * @param {Object<string, object>} neighborsRaw - Mutable neighbor data dict
 * @param {object} [options]
 * @param {number} [options.timeout=10000]
 * @param {function} [options._vprint] - Debug print function
 */
async function _fetchManagementAddresses(walker, neighborsRaw, options = {}) {
  const { timeout = 10000, _vprint = () => {} } = options;

  const MGMT_BASE_LEN = 11;

  _vprint(`Querying management address table: ${LLDP.REM_MAN_ADDR_TABLE}`);

  try {
    const results = await walker.walk(LLDP.REM_MAN_ADDR_TABLE, { timeout });

    if (!results || !results.length) {
      _vprint('No management address data');
      return;
    }

    _vprint(`Got ${results.length} management address entries`);

    for (const { oid } of results) {
      const parts = oid.split('.');

      if (parts.length < MGMT_BASE_LEN + 7) {
        continue;
      }

      try {
        // Construct the neighbor index (timeMark.localPort.remIndex)
        const idx = parts.slice(MGMT_BASE_LEN, MGMT_BASE_LEN + 3).join('.');

        // Address type: 1 = IPv4
        const addrType = (parts.length > MGMT_BASE_LEN + 3)
          ? parseInt(parts[MGMT_BASE_LEN + 3], 10)
          : 0;

        if (addrType === 1 && parts.length >= MGMT_BASE_LEN + 8) {
          // Last 4 OID components are the IPv4 address
          const addrParts = parts.slice(-4);
          const allValid = addrParts.every(p => {
            const n = parseInt(p, 10);
            return n >= 0 && n <= 255;
          });

          if (allValid) {
            const ipAddr = addrParts.join('.');

            if (idx in neighborsRaw) {
              neighborsRaw[idx].management_address = ipAddr;
            } else {
              // Create placeholder entry for this neighbor
              let localPort = 0;
              try {
                localPort = parseInt(parts[MGMT_BASE_LEN + 1], 10) || 0;
              } catch (_) {
                // Keep default
              }

              neighborsRaw[idx] = {
                index: idx,
                local_port_num: localPort,
                management_address: ipAddr,
              };
            }
          }
        }
      } catch (_) {
        continue;
      }
    }
  } catch (err) {
    _vprint(`Management address query failed: ${err.message}`);
  }
}

// =============================================================================
// Raw LLDP (for debugging)
// =============================================================================

/**
 * Get raw LLDP neighbor data as plain objects.
 * Useful for debugging or custom processing.
 *
 * @param {object} walker
 * @param {object} [options]
 * @param {number} [options.timeout=10000]
 * @param {boolean} [options.verbose=false]
 * @returns {Promise<Object<string, object>>} idx → raw neighbor data
 */
async function getLldpNeighborsRaw(walker, options = {}) {
  const { timeout = 10000, verbose = false, events = null } = options;

  const neighbors = {};
  const subs = {};

  const results = await walker.walk(LLDP.REMOTE_TABLE, { timeout });
  if (!results) return neighbors;

  for (const { oid, value } of results) {
    const parts = oid.split('.');

    if (parts.length < BASE_LEN + 4) continue;

    const column = parts[BASE_LEN];
    const idx = parts.slice(BASE_LEN + 1).join('.');

    if (!(idx in neighbors)) {
      neighbors[idx] = { index: idx };
      subs[idx] = {};
      if (parts.length >= BASE_LEN + 3) {
        try {
          neighbors[idx].local_port_num = parseInt(parts[BASE_LEN + 2], 10);
        } catch (_) {
          // Skip
        }
      }
    }

    switch (column) {
      case '4':
        subs[idx].chassis_id_subtype = decodeInt(value);
        break;
      case '5': {
        const subtype = (subs[idx] || {}).chassis_id_subtype ?? 4;
        neighbors[idx].chassis_id = decodeChassisId(subtype, value);
        neighbors[idx].chassis_id_subtype = subtype;
        break;
      }
      case '6':
        subs[idx].port_id_subtype = decodeInt(value);
        break;
      case '7': {
        const subtype = (subs[idx] || {}).port_id_subtype ?? 5;
        neighbors[idx].port_id = decodePortId(subtype, value);
        neighbors[idx].port_id_subtype = subtype;
        break;
      }
      case '8':
        neighbors[idx].port_description = decodeString(value);
        break;
      case '9':
        neighbors[idx].system_name = decodeString(value);
        break;
      case '10':
        neighbors[idx].system_description = decodeString(value);
        break;
      case '11':
        neighbors[idx].capabilities_supported = decodeString(value);
        break;
      case '12':
        neighbors[idx].capabilities_enabled = decodeString(value);
        break;
    }
  }

  // Fetch management addresses
  const _vprint = verbose
    ? (msg) => {
        console.log(`  [lldp] ${msg}`);
        if (events) events.log(`  ${msg}`, LogLevel.DEBUG);
      }
    : () => {};
  await _fetchManagementAddresses(walker, neighbors, { timeout, _vprint });

  return neighbors;
}

module.exports = {
  getLldpLocalPortMap,
  getLldpNeighbors,
  getLldpNeighborsRaw,
};