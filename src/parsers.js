/**
 * secure-cartography-js — SNMP Value Parsers.
 *
 * Ported from map_pioneer snmp/parsers.py.
 * Functions for decoding SNMP values into usable formats.
 *
 * Handles:
 * - MAC address decoding (Buffer and string)
 * - IP address decoding (with/without address family byte)
 * - LLDP chassis/port ID decoding by subtype
 * - Text value extraction from OctetString (Buffer)
 * - Vendor detection from sysDescr
 * - Hostname processing (extract, build FQDN)
 * - CDP/LLDP capability bitmap parsing
 *
 * All functions are defensive — they return safe fallback values
 * on decode errors rather than throwing.
 *
 * Key difference from Python version:
 * net-snmp returns Buffers for OctetString and native JS types
 * for Integer/Counter/OID. This eliminates the pysnmp type zoo
 * (asOctets, prettyPrint, etc.) and collapses most decode paths
 * to a single Buffer check.
 */

'use strict';

const { LLDP, CDP } = require('./oids');
const { DeviceVendor } = require('./models');

// =============================================================================
// MAC Address Decoding
// =============================================================================

/**
 * Decode binary data as MAC address.
 *
 * @param {Buffer|string} data - Raw MAC bytes or hex string
 * @returns {string} Colon-separated MAC (e.g., "aa:bb:cc:dd:ee:ff")
 *
 * @example
 *   decodeMac(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]))
 *   // => 'aa:bb:cc:dd:ee:ff'
 */
function decodeMac(data) {
  try {
    if (Buffer.isBuffer(data)) {
      const hex = data.toString('hex');
      return hex.match(/.{2}/g).join(':');
    }

    if (typeof data === 'string') {
      // Already formatted as hex (0x...)
      if (data.startsWith('0x')) {
        const hex = data.slice(2);
        if (hex.length === 12) {
          return hex.match(/.{2}/g).join(':');
        }
      }
      // Try as latin-1 encoded bytes
      const buf = Buffer.from(data, 'latin1');
      const hex = buf.toString('hex');
      return hex.match(/.{2}/g).join(':');
    }

    return String(data);
  } catch (_) {
    return `<mac_decode_error>`;
  }
}

/**
 * Normalize MAC address to lowercase colon-separated format.
 *
 * Handles: aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF, aabb.ccdd.eeff, aabbccddeeff
 *
 * @param {string} mac - MAC address in any common format
 * @returns {string} Normalized MAC or original string if invalid
 */
function normalizeMac(mac) {
  const clean = mac.replace(/[:\-.]/g, '').toLowerCase();

  if (clean.length === 12 && /^[0-9a-f]{12}$/.test(clean)) {
    return clean.match(/.{2}/g).join(':');
  }

  return mac;
}

// =============================================================================
// IP Address Decoding
// =============================================================================

/**
 * Decode binary data as IP address.
 *
 * Handles two common formats:
 * - 4 bytes: Direct IPv4 address
 * - 5 bytes: Address family byte + IPv4 address (CDP format)
 *
 * @param {Buffer|string} data - Raw IP bytes
 * @returns {string} Dotted-decimal IP (e.g., "192.168.1.1")
 *
 * @example
 *   decodeIp(Buffer.from([192, 168, 1, 1]))
 *   // => '192.168.1.1'
 *   decodeIp(Buffer.from([1, 192, 168, 1, 1]))  // with family byte
 *   // => '192.168.1.1'
 */
function decodeIp(data) {
  try {
    let buf = data;
    if (typeof data === 'string') {
      buf = Buffer.from(data, 'latin1');
    }
    if (!Buffer.isBuffer(buf)) {
      return String(data);
    }

    if (buf.length === 5) {
      // IPv4 with address family byte
      return `${buf[1]}.${buf[2]}.${buf[3]}.${buf[4]}`;
    }
    if (buf.length === 4) {
      // IPv4 without family byte
      return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
    }

    return String(data);
  } catch (_) {
    return String(data);
  }
}

/**
 * Check if string is a valid IPv4 address.
 * @param {string} ip
 * @returns {boolean}
 */
function isValidIpv4(ip) {
  if (!ip) return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

/**
 * Check if string looks like an IP address (IPv4).
 * @param {string} s
 * @returns {boolean}
 */
function isIpAddress(s) {
  return isValidIpv4(s);
}

// =============================================================================
// LLDP Subtype Decoding
// =============================================================================

/**
 * Decode LLDP chassis ID based on subtype.
 *
 * Subtypes (LldpChassisIdSubtype):
 *   1 = chassis component (entPhysicalAlias)
 *   2 = interface alias (ifAlias)
 *   3 = port component
 *   4 = MAC address (most common)
 *   5 = network address
 *   6 = interface name (ifName)
 *   7 = locally assigned
 *
 * @param {number} subtype - LldpChassisIdSubtype value
 * @param {Buffer|string} value - Raw chassis ID
 * @returns {string} Decoded chassis ID
 */
function decodeChassisId(subtype, value) {
  try {
    if (subtype === LLDP.CHASSIS_SUBTYPE_MAC) {
      return decodeMac(value);
    }
    if (subtype === LLDP.CHASSIS_SUBTYPE_NETWORK) {
      return decodeIp(value);
    }
    // Text-based subtypes: component, if_alias, port, if_name, local
    return decodeString(value);
  } catch (_) {
    return '<chassis_decode_error>';
  }
}

/**
 * Decode LLDP port ID based on subtype.
 *
 * Subtypes (LldpPortIdSubtype):
 *   1 = interface alias (ifAlias)
 *   2 = port component
 *   3 = MAC address
 *   4 = network address
 *   5 = interface name (ifName) — most common
 *   6 = agent circuit ID
 *   7 = locally assigned
 *
 * @param {number} subtype - LldpPortIdSubtype value
 * @param {Buffer|string} value - Raw port ID
 * @returns {string} Decoded port ID
 */
function decodePortId(subtype, value) {
  try {
    if (subtype === LLDP.PORT_SUBTYPE_MAC) {
      return decodeMac(value);
    }
    if (subtype === LLDP.PORT_SUBTYPE_NETWORK) {
      return decodeIp(value);
    }
    // Text-based subtypes
    return decodeString(value);
  } catch (_) {
    return '<port_decode_error>';
  }
}

// =============================================================================
// String Decoding
// =============================================================================

/**
 * Safely convert SNMP value to string.
 *
 * Handles Buffer (OctetString), native string, and numeric types.
 * Strips null bytes and control characters.
 *
 * @param {Buffer|string|number} value - Raw SNMP value
 * @returns {string} Clean string value
 */
function decodeString(value) {
  try {
    let result;

    if (Buffer.isBuffer(value)) {
      // Try UTF-8 first, fall back to latin-1
      result = value.toString('utf-8');
      // Check for replacement chars indicating bad UTF-8
      if (result.includes('\ufffd')) {
        result = value.toString('latin1');
      }
    } else {
      result = String(value);
    }

    // Clean: remove null bytes, trim whitespace
    result = result.replace(/\x00/g, '').trim();

    // Remove hex prefix if present (some devices return 0x... text)
    if (result.startsWith('0x')) {
      try {
        const hexBytes = Buffer.from(result.slice(2), 'hex');
        result = hexBytes.toString('utf-8');
      } catch (_) {
        // Keep original
      }
    }

    return result;
  } catch (_) {
    return String(value);
  }
}

/**
 * Safely convert SNMP value to integer.
 *
 * @param {Buffer|string|number} value - Raw SNMP value
 * @returns {number|null} Integer value or null on failure
 */
function decodeInt(value) {
  if (typeof value === 'number') return value;
  const n = parseInt(String(value), 10);
  return isNaN(n) ? null : n;
}

// =============================================================================
// Vendor Detection
// =============================================================================

/**
 * Vendor detection patterns (case-insensitive).
 * Evaluated in order — first match wins.
 * @type {Array<[string, RegExp[]]>}
 */
const VENDOR_PATTERNS = [
  [DeviceVendor.CISCO, [
    /cisco/i,
    /\bios\b/i,
    /nx-?os/i,
    /\basa\b/i,
    /cat\d/i,
  ]],
  [DeviceVendor.ARISTA, [
    /arista/i,
    /\beos\b/i,
  ]],
  [DeviceVendor.JUNIPER, [
    /juniper/i,
    /junos/i,
    /\bsrx\b/i,
    /\bmx\d/i,
    /\bqfx\b/i,
    /\bex\d/i,
  ]],
  [DeviceVendor.PALOALTO, [
    /palo\s*alto/i,
    /pan-?os/i,
  ]],
  [DeviceVendor.FORTINET, [
    /fortinet/i,
    /fortigate/i,
    /fortios/i,
  ]],
];

/**
 * Detect device vendor from sysDescr string.
 *
 * @param {string|null} sysDescr - sysDescr string from SNMP
 * @returns {string} DeviceVendor value
 *
 * @example
 *   detectVendor('Cisco IOS Software, C3750 Software...')
 *   // => 'cisco'
 *   detectVendor('Juniper Networks, Inc. ex4300-48t...')
 *   // => 'juniper'
 */
function detectVendor(sysDescr) {
  if (!sysDescr) return DeviceVendor.UNKNOWN;

  for (const [vendor, patterns] of VENDOR_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(sysDescr)) {
        return vendor;
      }
    }
  }

  return DeviceVendor.UNKNOWN;
}

/**
 * Check if sysDescr indicates a network device (vs server/host).
 *
 * @param {string|null} sysDescr
 * @returns {boolean}
 */
function isNetworkDevice(sysDescr) {
  if (!sysDescr) return false;
  return detectVendor(sysDescr) !== DeviceVendor.UNKNOWN;
}

// Exclusion patterns for non-network devices
const DEFAULT_EXCLUDE_PATTERNS = [
  'linux', 'windows', 'vmware', 'esxi', 'hypervisor',
  'ucs', 'server', 'hp proliant', 'dell poweredge', 'ibm system',
];

/**
 * Check if device should be excluded from discovery.
 *
 * Uses case-insensitive substring matching against exclusion patterns.
 *
 * @param {string|null} sysDescr - sysDescr string from SNMP
 * @param {string[]} [excludePatterns] - Patterns to match (default: DEFAULT_EXCLUDE_PATTERNS)
 * @returns {boolean} True if device should be excluded
 */
function shouldExclude(sysDescr, excludePatterns) {
  if (!sysDescr) return false;

  const patterns = excludePatterns || DEFAULT_EXCLUDE_PATTERNS;
  const lower = sysDescr.toLowerCase();

  for (const pattern of patterns) {
    if (lower.includes(pattern.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// Hostname Processing
// =============================================================================

/**
 * Extract base hostname by stripping domain suffix.
 *
 * @param {string} systemName - Full system name (e.g., 'switch01.example.com')
 * @param {string|string[]} domains - Domain(s) to strip
 * @returns {string} Hostname without domain (e.g., 'switch01')
 *
 * @example
 *   extractHostname('switch01.example.com', 'example.com')
 *   // => 'switch01'
 *   extractHostname('agg01.dc1.example.com', ['example.com', 'local'])
 *   // => 'agg01.dc1'
 */
function extractHostname(systemName, domains) {
  if (!systemName) return '';

  const domainList = Array.isArray(domains) ? domains : [domains];

  for (const domain of domainList) {
    const suffix = `.${domain}`;
    if (systemName.toLowerCase().endsWith(suffix.toLowerCase())) {
      return systemName.slice(0, -suffix.length);
    }
  }

  return systemName;
}

/**
 * Build FQDN from system name and domain(s).
 *
 * If systemName already ends with a configured domain, returns as-is.
 * If systemName looks like an FQDN (2+ dots), returns as-is.
 * Otherwise appends the primary (first) domain.
 *
 * @param {string} systemName - Hostname or partial FQDN
 * @param {string|string[]} domains - Domain(s) to use (first is primary)
 * @returns {string|null} FQDN string or null if invalid input
 */
function buildFqdn(systemName, domains) {
  if (!systemName) return null;

  const domainList = Array.isArray(domains) ? domains : [domains];
  if (!domainList.length) return systemName;

  // Check if already ends with any configured domain
  for (const domain of domainList) {
    if (systemName.toLowerCase().endsWith(`.${domain.toLowerCase()}`)) {
      return systemName;
    }
  }

  // Check if it looks like an FQDN already (2+ dots)
  if ((systemName.match(/\./g) || []).length >= 2) {
    return systemName;
  }

  // Append primary domain
  return `${systemName}.${domainList[0]}`;
}

/**
 * Try to extract hostname from LLDP port_description field.
 *
 * Fallback for devices that don't advertise lldpRemSysName.
 *
 * Common patterns:
 *   'INT::hostname.domain::interface' -> hostname.domain
 *   'TO::hostname::interface' -> hostname
 *
 * @param {string|null} portDesc
 * @returns {string|null} Extracted hostname or null
 */
function extractHostnameFromPortDesc(portDesc) {
  if (!portDesc || !portDesc.includes('::')) return null;

  const parts = portDesc.split('::');
  if (parts.length < 2) return null;

  const candidate = parts[1].trim();

  // Validate it looks like a hostname (not an interface name)
  const ifPrefixes = [
    'et-', 'xe-', 'ge-', 'eth', 'te', 'gi', 'fa',
    'po', 'vlan', 'lo', 'mgmt', 'ae'
  ];

  if (!candidate) return null;
  if (ifPrefixes.some(p => candidate.toLowerCase().startsWith(p))) return null;
  if (!/[a-zA-Z]/.test(candidate)) return null;

  return candidate;
}

// =============================================================================
// Capability Parsing
// =============================================================================

/**
 * Parse CDP capabilities bitmap.
 * @param {number} capValue - Capability bitmap
 * @returns {string[]} List of capability strings
 */
function parseCdpCapabilities(capValue) {
  const capabilities = [];
  if (capValue & CDP.CAP_ROUTER)              capabilities.push('router');
  if (capValue & CDP.CAP_TRANSPARENT_BRIDGE)  capabilities.push('bridge');
  if (capValue & CDP.CAP_SOURCE_ROUTE_BRIDGE) capabilities.push('source-route-bridge');
  if (capValue & CDP.CAP_SWITCH)              capabilities.push('switch');
  if (capValue & CDP.CAP_HOST)                capabilities.push('host');
  if (capValue & CDP.CAP_IGMP)                capabilities.push('igmp');
  if (capValue & CDP.CAP_REPEATER)            capabilities.push('repeater');
  return capabilities;
}

/**
 * Parse LLDP capabilities bitmap.
 * @param {number} capValue - Capability bitmap
 * @returns {string[]} List of capability strings
 */
function parseLldpCapabilities(capValue) {
  const capabilities = [];
  if (capValue & LLDP.CAP_OTHER)     capabilities.push('other');
  if (capValue & LLDP.CAP_REPEATER)  capabilities.push('repeater');
  if (capValue & LLDP.CAP_BRIDGE)    capabilities.push('bridge');
  if (capValue & LLDP.CAP_WLAN_AP)   capabilities.push('wlan-ap');
  if (capValue & LLDP.CAP_ROUTER)    capabilities.push('router');
  if (capValue & LLDP.CAP_TELEPHONE) capabilities.push('telephone');
  if (capValue & LLDP.CAP_DOCSIS)    capabilities.push('docsis');
  if (capValue & LLDP.CAP_STATION)   capabilities.push('station');
  return capabilities;
}

module.exports = {
  // MAC
  decodeMac,
  normalizeMac,
  // IP
  decodeIp,
  isValidIpv4,
  isIpAddress,
  // LLDP subtype decoding
  decodeChassisId,
  decodePortId,
  // String/Int
  decodeString,
  decodeInt,
  // Vendor detection
  detectVendor,
  isNetworkDevice,
  shouldExclude,
  DEFAULT_EXCLUDE_PATTERNS,
  // Hostname processing
  extractHostname,
  buildFqdn,
  extractHostnameFromPortDesc,
  // Capability parsing
  parseCdpCapabilities,
  parseLldpCapabilities,
};
