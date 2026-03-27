/**
 * secure-cartography-js — System Info Collector.
 *
 * Ported from map_pioneer snmp/collectors/system.py.
 * Collects system MIB information (sysDescr, sysName, etc.).
 *
 * Walker contract note:
 *   This collector uses walker.getMultiple(oids, options) which
 *   fetches multiple scalar OIDs in a single SNMP GET request.
 *   Returns an array of values in the same order as the input OIDs.
 *   Null entries for OIDs that returned noSuchObject/noSuchInstance.
 */

'use strict';

const { SYSTEM } = require('./oids');
const { DeviceVendor } = require('./models');
const { decodeString, decodeInt, detectVendor } = require('./parsers');

/**
 * Get system MIB information from device.
 *
 * @param {object} walker - Walker implementation
 * @param {object} [options]
 * @param {number} [options.timeout=5000] - Timeout in ms
 * @param {boolean} [options.verbose=false] - Enable debug output
 * @returns {Promise<object>} System info dict with sys_descr, sys_name,
 *   sys_location, sys_contact, sys_object_id, uptime_ticks, vendor
 */
async function getSystemInfo(walker, options = {}) {
  const { timeout = 5000, verbose = false } = options;

  const _vprint = verbose
    ? (msg) => console.log(`  [system] ${msg}`)
    : () => {};

  const oids = [
    SYSTEM.SYS_DESCR,
    SYSTEM.SYS_NAME,
    SYSTEM.SYS_LOCATION,
    SYSTEM.SYS_CONTACT,
    SYSTEM.SYS_OBJECT_ID,
    SYSTEM.SYS_UPTIME,
  ];

  _vprint('Querying system MIB scalars...');
  const values = await walker.getMultiple(oids, { timeout });

  const result = {
    sys_descr:     null,
    sys_name:      null,
    sys_location:  null,
    sys_contact:   null,
    sys_object_id: null,
    uptime_ticks:  null,
    vendor:        DeviceVendor.UNKNOWN,
  };

  if (values[0] != null) {
    result.sys_descr = decodeString(values[0]);
    result.vendor = detectVendor(result.sys_descr);
  }

  if (values[1] != null) {
    result.sys_name = decodeString(values[1]);
  }

  if (values[2] != null) {
    result.sys_location = decodeString(values[2]);
  }

  if (values[3] != null) {
    result.sys_contact = decodeString(values[3]);
  }

  if (values[4] != null) {
    result.sys_object_id = decodeString(values[4]);
  }

  if (values[5] != null) {
    result.uptime_ticks = decodeInt(values[5]);
  }

  _vprint(`sysName=${result.sys_name} vendor=${result.vendor}`);
  return result;
}

/**
 * Quick sysName lookup.
 *
 * @param {object} walker
 * @param {object} [options]
 * @param {number} [options.timeout=3000]
 * @returns {Promise<string|null>}
 */
async function getSysName(walker, options = {}) {
  const { timeout = 3000 } = options;
  const result = await walker.get(SYSTEM.SYS_NAME, { timeout });
  return result ? decodeString(result.value) : null;
}

/**
 * Quick sysDescr lookup.
 *
 * @param {object} walker
 * @param {object} [options]
 * @param {number} [options.timeout=3000]
 * @returns {Promise<string|null>}
 */
async function getSysDescr(walker, options = {}) {
  const { timeout = 3000 } = options;
  const result = await walker.get(SYSTEM.SYS_DESCR, { timeout });
  return result ? decodeString(result.value) : null;
}

/**
 * Detect device vendor from sysDescr.
 *
 * @param {object} walker
 * @param {object} [options]
 * @param {number} [options.timeout=3000]
 * @returns {Promise<{ vendor: string, sysDescr: string|null }>}
 */
async function detectDeviceVendor(walker, options = {}) {
  const sysDescr = await getSysDescr(walker, options);
  const vendor = detectVendor(sysDescr);
  return { vendor, sysDescr };
}

module.exports = {
  getSystemInfo,
  getSysName,
  getSysDescr,
  detectDeviceVendor,
};