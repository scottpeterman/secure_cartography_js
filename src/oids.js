/**
 * secure-cartography-js — SNMP OID Constants.
 *
 * Ported from map_pioneer oids.py.
 * Centralized OID definitions for network discovery.
 *
 * Organization:
 * - SNMPv2-MIB: System group (sysDescr, sysName, etc.)
 * - IF-MIB: Interface table (ifName, ifDescr, ifAlias, ifOperStatus)
 * - CISCO-CDP-MIB: Cisco Discovery Protocol
 * - LLDP-MIB: Link Layer Discovery Protocol
 * - IP-MIB: ARP table (ipNetToMedia)
 * - ENTITY-MIB: Physical entity table (serial, model)
 *
 * Usage:
 *   const { SYSTEM, INTERFACES, CDP, LLDP } = require('./oids');
 *
 *   // Walk CDP neighbors
 *   const results = await walker.walk(CDP.CACHE_ENTRY);
 *
 *   // Get sysDescr
 *   const result = await walker.get(SYSTEM.SYS_DESCR);
 *
 * Notes:
 * - Numeric OIDs preferred for performance (skip MIB resolution)
 * - Some devices only respond to numeric OIDs
 */

'use strict';

// =============================================================================
// SNMPv2-MIB — System Group
// =============================================================================

const SYSTEM = Object.freeze({
  BASE:          '1.3.6.1.2.1.1',

  // Scalar objects (append .0 for GET)
  SYS_DESCR:     '1.3.6.1.2.1.1.1.0',
  SYS_OBJECT_ID: '1.3.6.1.2.1.1.2.0',
  SYS_UPTIME:    '1.3.6.1.2.1.1.3.0',
  SYS_CONTACT:   '1.3.6.1.2.1.1.4.0',
  SYS_NAME:      '1.3.6.1.2.1.1.5.0',
  SYS_LOCATION:  '1.3.6.1.2.1.1.6.0',
  SYS_SERVICES:  '1.3.6.1.2.1.1.7.0',

  MIB_NAME: 'SNMPv2-MIB',
});

// =============================================================================
// IF-MIB — Interface Table
// =============================================================================

const INTERFACES = Object.freeze({
  IF_TABLE:       '1.3.6.1.2.1.2.2',
  IF_ENTRY:       '1.3.6.1.2.1.2.2.1',

  IF_INDEX:       '1.3.6.1.2.1.2.2.1.1',
  IF_DESCR:       '1.3.6.1.2.1.2.2.1.2',
  IF_TYPE:        '1.3.6.1.2.1.2.2.1.3',
  IF_MTU:         '1.3.6.1.2.1.2.2.1.4',
  IF_SPEED:       '1.3.6.1.2.1.2.2.1.5',
  IF_PHYS_ADDRESS:'1.3.6.1.2.1.2.2.1.6',
  IF_ADMIN_STATUS:'1.3.6.1.2.1.2.2.1.7',
  IF_OPER_STATUS: '1.3.6.1.2.1.2.2.1.8',

  IF_X_TABLE:     '1.3.6.1.2.1.31.1.1',
  IF_X_ENTRY:     '1.3.6.1.2.1.31.1.1.1',

  IF_NAME:        '1.3.6.1.2.1.31.1.1.1.1',
  IF_HIGH_SPEED:  '1.3.6.1.2.1.31.1.1.1.15',
  IF_ALIAS:       '1.3.6.1.2.1.31.1.1.1.18',

  MIB_NAME: 'IF-MIB',

  ADMIN_STATUS_UP:      1,
  ADMIN_STATUS_DOWN:    2,
  ADMIN_STATUS_TESTING: 3,

  OPER_STATUS_UP:               1,
  OPER_STATUS_DOWN:             2,
  OPER_STATUS_TESTING:          3,
  OPER_STATUS_UNKNOWN:          4,
  OPER_STATUS_DORMANT:          5,
  OPER_STATUS_NOT_PRESENT:      6,
  OPER_STATUS_LOWER_LAYER_DOWN: 7,
});

// =============================================================================
// CISCO-CDP-MIB — Cisco Discovery Protocol
// =============================================================================

const CDP = Object.freeze({
  BASE: '1.3.6.1.4.1.9.9.23',

  CDP_GLOBAL:                  '1.3.6.1.4.1.9.9.23.1.3',
  CDP_GLOBAL_RUN:              '1.3.6.1.4.1.9.9.23.1.3.1.0',
  CDP_GLOBAL_MESSAGE_INTERVAL: '1.3.6.1.4.1.9.9.23.1.3.2.0',
  CDP_GLOBAL_HOLDTIME:         '1.3.6.1.4.1.9.9.23.1.3.3.0',

  CACHE_TABLE: '1.3.6.1.4.1.9.9.23.1.2.1',
  CACHE_ENTRY: '1.3.6.1.4.1.9.9.23.1.2.1.1',

  // Index: cdpCacheIfIndex.cdpCacheDeviceIndex
  CACHE_ADDRESS_TYPE:            '1.3.6.1.4.1.9.9.23.1.2.1.1.1',
  CACHE_ADDRESS:                 '1.3.6.1.4.1.9.9.23.1.2.1.1.4',
  CACHE_VERSION:                 '1.3.6.1.4.1.9.9.23.1.2.1.1.5',
  CACHE_DEVICE_ID:               '1.3.6.1.4.1.9.9.23.1.2.1.1.6',
  CACHE_DEVICE_PORT:             '1.3.6.1.4.1.9.9.23.1.2.1.1.7',
  CACHE_PLATFORM:                '1.3.6.1.4.1.9.9.23.1.2.1.1.8',
  CACHE_CAPABILITIES:            '1.3.6.1.4.1.9.9.23.1.2.1.1.9',
  CACHE_VTP_MGMT_DOMAIN:         '1.3.6.1.4.1.9.9.23.1.2.1.1.10',
  CACHE_NATIVE_VLAN:             '1.3.6.1.4.1.9.9.23.1.2.1.1.11',
  CACHE_DUPLEX:                  '1.3.6.1.4.1.9.9.23.1.2.1.1.12',
  CACHE_PRIMARY_MGMT_ADDR_TYPE:  '1.3.6.1.4.1.9.9.23.1.2.1.1.15',
  CACHE_PRIMARY_MGMT_ADDR:       '1.3.6.1.4.1.9.9.23.1.2.1.1.16',
  CACHE_SECONDARY_MGMT_ADDR_TYPE:'1.3.6.1.4.1.9.9.23.1.2.1.1.17',
  CACHE_SECONDARY_MGMT_ADDR:     '1.3.6.1.4.1.9.9.23.1.2.1.1.18',

  MIB_NAME: 'CISCO-CDP-MIB',

  CAP_ROUTER:              0x01,
  CAP_TRANSPARENT_BRIDGE:  0x02,
  CAP_SOURCE_ROUTE_BRIDGE: 0x04,
  CAP_SWITCH:              0x08,
  CAP_HOST:                0x10,
  CAP_IGMP:                0x20,
  CAP_REPEATER:            0x40,
});

// =============================================================================
// LLDP-MIB — Link Layer Discovery Protocol
// =============================================================================

const LLDP = Object.freeze({
  BASE: '1.0.8802.1.1.2',

  LLDP_CONFIG: '1.0.8802.1.1.2.1.1',

  // Local System Data
  LOCAL_SYSTEM:             '1.0.8802.1.1.2.1.3',
  LOCAL_CHASSIS_ID_SUBTYPE: '1.0.8802.1.1.2.1.3.1.0',
  LOCAL_CHASSIS_ID:         '1.0.8802.1.1.2.1.3.2.0',
  LOCAL_SYS_NAME:           '1.0.8802.1.1.2.1.3.3.0',
  LOCAL_SYS_DESC:           '1.0.8802.1.1.2.1.3.4.0',
  LOCAL_SYS_CAP_SUPPORTED:  '1.0.8802.1.1.2.1.3.5.0',
  LOCAL_SYS_CAP_ENABLED:    '1.0.8802.1.1.2.1.3.6.0',

  // Local Port Table
  LOC_PORT_TABLE:      '1.0.8802.1.1.2.1.3.7',
  LOC_PORT_ENTRY:      '1.0.8802.1.1.2.1.3.7.1',
  LOC_PORT_ID_SUBTYPE: '1.0.8802.1.1.2.1.3.7.1.2',
  LOC_PORT_ID:         '1.0.8802.1.1.2.1.3.7.1.3',
  LOC_PORT_DESC:       '1.0.8802.1.1.2.1.3.7.1.4',

  // Remote Systems Data (Neighbor Table)
  REMOTE_TABLE: '1.0.8802.1.1.2.1.4.1',
  REMOTE_ENTRY: '1.0.8802.1.1.2.1.4.1.1',

  // lldpRemTable columns
  // OID: 1.0.8802.1.1.2.1.4.1.1.<column>.<timeMark>.<localPort>.<remIndex>
  REM_CHASSIS_ID_SUBTYPE: '1.0.8802.1.1.2.1.4.1.1.4',
  REM_CHASSIS_ID:         '1.0.8802.1.1.2.1.4.1.1.5',
  REM_PORT_ID_SUBTYPE:    '1.0.8802.1.1.2.1.4.1.1.6',
  REM_PORT_ID:            '1.0.8802.1.1.2.1.4.1.1.7',
  REM_PORT_DESC:          '1.0.8802.1.1.2.1.4.1.1.8',
  REM_SYS_NAME:           '1.0.8802.1.1.2.1.4.1.1.9',
  REM_SYS_DESC:           '1.0.8802.1.1.2.1.4.1.1.10',
  REM_SYS_CAP_SUPPORTED:  '1.0.8802.1.1.2.1.4.1.1.11',
  REM_SYS_CAP_ENABLED:    '1.0.8802.1.1.2.1.4.1.1.12',

  // Remote Management Address Table
  REM_MAN_ADDR_TABLE:      '1.0.8802.1.1.2.1.4.2',
  REM_MAN_ADDR_ENTRY:      '1.0.8802.1.1.2.1.4.2.1',
  REM_MAN_ADDR_IF_SUBTYPE: '1.0.8802.1.1.2.1.4.2.1.3',
  REM_MAN_ADDR_IF_ID:      '1.0.8802.1.1.2.1.4.2.1.4',
  REM_MAN_ADDR_OID:        '1.0.8802.1.1.2.1.4.2.1.5',

  MIB_NAME: 'LLDP-MIB',

  // Column numbers within lldpRemEntry
  COLUMN_CHASSIS_ID_SUBTYPE: 4,
  COLUMN_CHASSIS_ID:         5,
  COLUMN_PORT_ID_SUBTYPE:    6,
  COLUMN_PORT_ID:            7,
  COLUMN_PORT_DESC:          8,
  COLUMN_SYS_NAME:           9,
  COLUMN_SYS_DESC:           10,
  COLUMN_CAP_SUPPORTED:      11,
  COLUMN_CAP_ENABLED:        12,

  // Chassis ID Subtypes (LldpChassisIdSubtype)
  CHASSIS_SUBTYPE_COMPONENT: 1,
  CHASSIS_SUBTYPE_IF_ALIAS:  2,
  CHASSIS_SUBTYPE_PORT:      3,
  CHASSIS_SUBTYPE_MAC:       4,   // Most common
  CHASSIS_SUBTYPE_NETWORK:   5,
  CHASSIS_SUBTYPE_IF_NAME:   6,
  CHASSIS_SUBTYPE_LOCAL:     7,

  // Port ID Subtypes (LldpPortIdSubtype)
  PORT_SUBTYPE_IF_ALIAS: 1,
  PORT_SUBTYPE_PORT:     2,
  PORT_SUBTYPE_MAC:      3,
  PORT_SUBTYPE_NETWORK:  4,
  PORT_SUBTYPE_IF_NAME:  5,   // Most common
  PORT_SUBTYPE_AGENT:    6,
  PORT_SUBTYPE_LOCAL:    7,

  // Capabilities bitmap
  CAP_OTHER:     0x01,
  CAP_REPEATER:  0x02,
  CAP_BRIDGE:    0x04,
  CAP_WLAN_AP:   0x08,
  CAP_ROUTER:    0x10,
  CAP_TELEPHONE: 0x20,
  CAP_DOCSIS:    0x40,
  CAP_STATION:   0x80,
});

// =============================================================================
// IP-MIB — ARP Table
// =============================================================================

const ARP = Object.freeze({
  NET_TO_MEDIA_TABLE:        '1.3.6.1.2.1.4.22',
  NET_TO_MEDIA_ENTRY:        '1.3.6.1.2.1.4.22.1',
  NET_TO_MEDIA_IF_INDEX:     '1.3.6.1.2.1.4.22.1.1',
  NET_TO_MEDIA_PHYS_ADDRESS: '1.3.6.1.2.1.4.22.1.2',
  NET_TO_MEDIA_NET_ADDRESS:  '1.3.6.1.2.1.4.22.1.3',
  NET_TO_MEDIA_TYPE:         '1.3.6.1.2.1.4.22.1.4',

  NET_TO_PHYSICAL_TABLE: '1.3.6.1.2.1.4.35',

  TYPE_OTHER:   1,
  TYPE_INVALID: 2,
  TYPE_DYNAMIC: 3,
  TYPE_STATIC:  4,
});

// =============================================================================
// ENTITY-MIB — Physical Entity Table
// =============================================================================

const ENTITY = Object.freeze({
  PHYSICAL_TABLE: '1.3.6.1.2.1.47.1.1.1',
  PHYSICAL_ENTRY: '1.3.6.1.2.1.47.1.1.1.1',

  PHYS_DESCR:         '1.3.6.1.2.1.47.1.1.1.1.2',
  PHYS_VENDOR_TYPE:   '1.3.6.1.2.1.47.1.1.1.1.3',
  PHYS_CONTAINED_IN:  '1.3.6.1.2.1.47.1.1.1.1.4',
  PHYS_CLASS:         '1.3.6.1.2.1.47.1.1.1.1.5',
  PHYS_PARENT_REL_POS:'1.3.6.1.2.1.47.1.1.1.1.6',
  PHYS_NAME:          '1.3.6.1.2.1.47.1.1.1.1.7',
  PHYS_HARDWARE_REV:  '1.3.6.1.2.1.47.1.1.1.1.8',
  PHYS_FIRMWARE_REV:  '1.3.6.1.2.1.47.1.1.1.1.9',
  PHYS_SOFTWARE_REV:  '1.3.6.1.2.1.47.1.1.1.1.10',
  PHYS_SERIAL_NUM:    '1.3.6.1.2.1.47.1.1.1.1.11',
  PHYS_MFG_NAME:      '1.3.6.1.2.1.47.1.1.1.1.12',
  PHYS_MODEL_NAME:    '1.3.6.1.2.1.47.1.1.1.1.13',
  PHYS_ALIAS:         '1.3.6.1.2.1.47.1.1.1.1.14',
  PHYS_ASSET_ID:      '1.3.6.1.2.1.47.1.1.1.1.15',
  PHYS_IS_FRU:        '1.3.6.1.2.1.47.1.1.1.1.16',

  CLASS_OTHER:        1,
  CLASS_UNKNOWN:      2,
  CLASS_CHASSIS:      3,
  CLASS_BACKPLANE:    4,
  CLASS_CONTAINER:    5,
  CLASS_POWER_SUPPLY: 6,
  CLASS_FAN:          7,
  CLASS_SENSOR:       8,
  CLASS_MODULE:       9,
  CLASS_PORT:         10,
  CLASS_STACK:        11,
  CLASS_CPU:          12,
});

// =============================================================================
// Vendor-specific OIDs
// =============================================================================

const CISCO_ENVMON = Object.freeze({
  BASE:       '1.3.6.1.4.1.9.9.13',
  TEMP_TABLE: '1.3.6.1.4.1.9.9.13.1.3',
  TEMP_DESCR: '1.3.6.1.4.1.9.9.13.1.3.1.2',
  TEMP_VALUE: '1.3.6.1.4.1.9.9.13.1.3.1.3',
  TEMP_STATE: '1.3.6.1.4.1.9.9.13.1.3.1.6',
});

const JUNIPER_OID = Object.freeze({
  BASE:           '1.3.6.1.4.1.2636',
  CHASSIS_SERIAL: '1.3.6.1.4.1.2636.3.1.3.0',
});

const ARISTA_OID = Object.freeze({
  BASE: '1.3.6.1.4.1.30065',
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract index portion from an OID.
 *
 * @param {string} oid - Full OID string
 * @param {string} baseOid - Base OID to strip
 * @returns {string} Index portion
 *
 * @example
 *   extractIndexFromOid('1.3.6.1.4.1.9.9.23.1.2.1.1.6.10.1',
 *                       '1.3.6.1.4.1.9.9.23.1.2.1.1.6')
 *   // => '10.1'
 */
function extractIndexFromOid(oid, baseOid) {
  const prefix = baseOid + '.';
  if (oid.startsWith(prefix)) {
    return oid.slice(prefix.length);
  }
  return oid;
}

/**
 * Parse CDP cache index from OID.
 *
 * CDP index format: ifIndex.deviceIndex
 * @param {string} oid - Index portion of OID
 * @returns {{ ifIndex: number, deviceIndex: number }}
 */
function parseCdpIndex(oid) {
  const parts = oid.split('.');
  if (parts.length >= 2) {
    return {
      ifIndex:     parseInt(parts[parts.length - 2], 10) || 0,
      deviceIndex: parseInt(parts[parts.length - 1], 10) || 0,
    };
  }
  return { ifIndex: 0, deviceIndex: 0 };
}

/**
 * Parse LLDP remote table index from OID.
 *
 * LLDP index format: timeMark.localPortNum.remIndex
 * @param {string} oid - Index portion of OID
 * @returns {{ timeMark: number, localPort: number, remIndex: number }}
 */
function parseLldpIndex(oid) {
  const parts = oid.split('.');
  if (parts.length >= 3) {
    return {
      timeMark:  parseInt(parts[parts.length - 3], 10) || 0,
      localPort: parseInt(parts[parts.length - 2], 10) || 0,
      remIndex:  parseInt(parts[parts.length - 1], 10) || 0,
    };
  }
  return { timeMark: 0, localPort: 0, remIndex: 0 };
}

/**
 * Extract IP address from the last N octets of an OID.
 *
 * Used for ARP table where IP is encoded in OID index.
 * @param {string} oid - Full OID string
 * @param {number} [count=4] - Number of octets to extract
 * @returns {string} Dotted-decimal IP address
 */
function ipFromOidSuffix(oid, count = 4) {
  const parts = oid.split('.');
  if (parts.length >= count) {
    return parts.slice(-count).join('.');
  }
  return '';
}

module.exports = {
  SYSTEM,
  INTERFACES,
  CDP,
  LLDP,
  ARP,
  ENTITY,
  CISCO_ENVMON,
  JUNIPER: JUNIPER_OID,
  ARISTA: ARISTA_OID,
  extractIndexFromOid,
  parseCdpIndex,
  parseLldpIndex,
  ipFromOidSuffix,
};
