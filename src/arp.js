/**
 * secure-cartography-js — ARP Table Collector.
 *
 * Ported from map_pioneer snmp/collectors/arp.py.
 * Collects ARP table (MAC to IP mapping) from devices.
 * Used as fallback for LLDP neighbors without management addresses.
 */

'use strict';

const { ARP } = require('./oids');
const { decodeMac, normalizeMac } = require('./parsers');

/**
 * Get ARP table from device.
 *
 * Queries ipNetToMediaPhysAddress for MAC-to-IP mappings.
 *
 * @param {object} walker - Walker implementation
 * @param {object} [options]
 * @param {number} [options.timeout=5000] - Timeout in ms
 * @param {boolean} [options.verbose=false] - Enable debug output
 * @returns {Promise<Object<string, string>>} MAC (lowercase, colon-separated) → IP
 */
async function getArpTable(walker, options = {}) {
  const { timeout = 5000, verbose = false } = options;

  const _vprint = verbose
    ? (msg) => console.log(`  [arp] ${msg}`)
    : () => {};

  const macToIp = {};

  _vprint(`Querying ARP table: ${ARP.NET_TO_MEDIA_PHYS_ADDRESS}`);

  const results = await walker.walk(ARP.NET_TO_MEDIA_PHYS_ADDRESS, { timeout });

  for (const { oid, value } of results) {
    try {
      // Extract IP from OID (last 4 octets)
      const parts = oid.split('.');
      if (parts.length < 4) continue;

      const ipParts = parts.slice(-4);
      const allValid = ipParts.every(p => {
        const n = parseInt(p, 10);
        return n >= 0 && n <= 255;
      });

      if (!allValid) continue;

      const ipAddr = ipParts.join('.');
      const mac = decodeMac(value);

      if (mac && mac.includes(':')) {
        const macLower = mac.toLowerCase();
        macToIp[macLower] = ipAddr;

        if (verbose) {
          _vprint(`  ${macLower} -> ${ipAddr}`);
        }
      }
    } catch (_) {
      continue;
    }
  }

  _vprint(`Found ${Object.keys(macToIp).length} ARP entries`);
  return macToIp;
}

/**
 * Look up IP address by MAC address.
 * Normalizes MAC format before lookup.
 *
 * @param {string} mac - MAC address in any common format
 * @param {Object<string, string>} arpTable - MAC → IP mapping
 * @returns {string|null} IP address or null
 */
function lookupIpByMac(mac, arpTable) {
  if (!mac || !arpTable) return null;

  const normalized = normalizeMac(mac);
  return arpTable[normalized] || null;
}

module.exports = {
  getArpTable,
  lookupIpByMac,
};