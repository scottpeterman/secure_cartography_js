#!/usr/bin/env node
/**
 * secure-cartography-js — Test Client
 *
 * Wraps net-snmp in a minimal walker that satisfies the collector contract,
 * then runs all five collectors against a single target device.
 *
 * Usage:
 *   node test_client.js <target_ip> [community] [--verbose]
 *
 * Examples:
 *   node test_client.js 10.0.0.1 private
 *   node test_client.js 10.0.0.1 private --verbose
 *   node test_client.js 10.0.0.1              # defaults to 'public'
 *
 * Requires: npm install net-snmp
 */

'use strict';

const snmp = require('net-snmp');

// --- Imports from flat src/ layout ---
const { SYSTEM } = require('./src/oids');
const { Device, DeviceVendor } = require('./src/models');
const { getSystemInfo, getSysName } = require('./src/system');
const { getInterfaceTable, getInterfaceTableExtended } = require('./src/interfaces');
const { getCdpNeighbors } = require('./src/cdp');
const { getLldpNeighbors } = require('./src/lldp');
const { getArpTable } = require('./src/arp');

// =============================================================================
// Minimal Walker (wraps net-snmp to satisfy collector contract)
// =============================================================================

/**
 * Walker contract:
 *   walker.get(oid, options)          → { oid, value } | null
 *   walker.getMultiple(oids, options) → [value, ...] (null for missing)
 *   walker.walk(oid, options)         → [{ oid, value }, ...]
 *   walker.close()                    → void
 */
class NetSnmpWalker {
  /**
   * @param {string} target - Device IP address
   * @param {object} auth - { version: 2, community: 'public' } or v3 params
   * @param {object} [options]
   * @param {number} [options.timeout=5000] - Default timeout in ms
   * @param {number} [options.retries=1] - SNMP retries
   */
  constructor(target, auth, options = {}) {
    this.target = target;
    this.auth = auth;
    this.defaultTimeout = options.timeout || 5000;

    if (auth.version === 3) {
      // SNMPv3
      const user = {
        name: auth.user,
        level: snmp.SecurityLevel.authPriv,
        authProtocol: snmp.AuthProtocols[auth.authProtocol || 'sha'],
        authKey: auth.authKey,
        privProtocol: snmp.PrivProtocols[auth.privProtocol || 'aes'],
        privKey: auth.privKey,
      };
      this.session = snmp.createV3Session(target, user, {
        timeout: this.defaultTimeout,
        retries: options.retries ?? 1,
      });
    } else {
      // SNMPv2c
      this.session = snmp.createSession(target, auth.community || 'public', {
        version: snmp.Version2c,
        timeout: this.defaultTimeout,
        retries: options.retries ?? 1,
      });
    }
  }

  /**
   * SNMP GET for a single OID.
   * @param {string} oid
   * @param {object} [options]
   * @returns {Promise<{ oid: string, value: * }|null>}
   */
  get(oid, options = {}) {
    return new Promise((resolve, reject) => {
      this.session.get([oid], (error, varbinds) => {
        if (error) return reject(error);
        if (!varbinds || !varbinds.length) return resolve(null);

        const vb = varbinds[0];
        if (snmp.isVarbindError(vb)) return resolve(null);

        resolve({ oid: vb.oid, value: vb.value });
      });
    });
  }

  /**
   * SNMP GET for multiple OIDs in a single request.
   * Returns array of values in same order as input OIDs.
   * Null for OIDs that returned noSuchObject/noSuchInstance.
   *
   * @param {string[]} oids
   * @param {object} [options]
   * @returns {Promise<Array<*|null>>}
   */
  getMultiple(oids, options = {}) {
    return new Promise((resolve, reject) => {
      this.session.get(oids, (error, varbinds) => {
        if (error) return reject(error);

        const values = varbinds.map(vb => {
          if (snmp.isVarbindError(vb)) return null;
          return vb.value;
        });

        resolve(values);
      });
    });
  }

  /**
   * SNMP WALK (subtree) for an OID prefix.
   * Returns all OID/value pairs under the prefix.
   *
   * @param {string} oid
   * @param {object} [options]
   * @returns {Promise<Array<{ oid: string, value: * }>>}
   */
  walk(oid, options = {}) {
    return new Promise((resolve, reject) => {
      const results = [];

      // feedCb is called multiple times with batches of varbinds
      function feedCb(varbinds) {
        for (const vb of varbinds) {
          if (!snmp.isVarbindError(vb)) {
            results.push({ oid: vb.oid, value: vb.value });
          }
        }
      }

      // doneCb is called once when the walk completes
      function doneCb(error) {
        if (error) {
          // Some errors are normal (endOfMibView, etc.)
          // Still return whatever we collected
          if (results.length > 0) {
            resolve(results);
          } else {
            reject(error);
          }
        } else {
          resolve(results);
        }
      }

      this.session.subtree(oid, feedCb, doneCb);
    });
  }

  /** Close the SNMP session and release the UDP socket. */
  close() {
    this.session.close();
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const positional = args.filter(a => !a.startsWith('-'));

  if (!positional.length) {
    console.error('Usage: node test_client.js <target_ip> [community] [--verbose]');
    process.exit(1);
  }

  const target = positional[0];
  const community = positional[1] || 'public';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  secure-cartography-js — Test Client`);
  console.log(`  Target:    ${target}`);
  console.log(`  Community: ${community}`);
  console.log(`  Verbose:   ${verbose}`);
  console.log(`${'='.repeat(60)}\n`);

  // Create walker
  const walker = new NetSnmpWalker(target, { version: 2, community }, {
    timeout: 10000,
    retries: 1,
  });

  const startTime = Date.now();

  try {
    // -----------------------------------------------------------------------
    // 1. System Info
    // -----------------------------------------------------------------------
    console.log('[1/5] Collecting system info...');
    const systemInfo = await getSystemInfo(walker, { verbose });
    console.log(`  sysName:  ${systemInfo.sys_name}`);
    console.log(`  sysDescr: ${(systemInfo.sys_descr || '').slice(0, 80)}...`);
    console.log(`  vendor:   ${systemInfo.vendor}`);
    console.log();

    // -----------------------------------------------------------------------
    // 2. Interface Table
    // -----------------------------------------------------------------------
    console.log('[2/5] Collecting interface table...');
    const interfaces = await getInterfaceTableExtended(walker, { verbose });
    const ifCount = Object.keys(interfaces).length;
    console.log(`  Found ${ifCount} interfaces`);

    // Show first 5
    const ifEntries = Object.entries(interfaces).slice(0, 5);
    for (const [idx, iface] of ifEntries) {
      console.log(`    ifIndex ${idx}: ${iface.name} (${iface.status})`);
    }
    if (ifCount > 5) console.log(`    ... and ${ifCount - 5} more`);
    console.log();

    // -----------------------------------------------------------------------
    // 3. CDP Neighbors
    // -----------------------------------------------------------------------
    console.log('[3/5] Collecting CDP neighbors...');
    const cdpNeighbors = await getCdpNeighbors(walker, {
      interfaceTable: interfaces,
      verbose,
    });
    console.log(`  Found ${cdpNeighbors.length} CDP neighbors`);
    for (const n of cdpNeighbors.slice(0, 5)) {
      console.log(`    ${n.localInterface} → ${n.remoteDevice} (${n.remoteInterface}) [${n.remoteIp || 'no IP'}]`);
    }
    if (cdpNeighbors.length > 5) console.log(`    ... and ${cdpNeighbors.length - 5} more`);
    console.log();

    // -----------------------------------------------------------------------
    // 4. LLDP Neighbors
    // -----------------------------------------------------------------------
    console.log('[4/5] Collecting LLDP neighbors...');
    const lldpNeighbors = await getLldpNeighbors(walker, {
      interfaceTable: interfaces,
      verbose,
    });
    console.log(`  Found ${lldpNeighbors.length} LLDP neighbors`);
    for (const n of lldpNeighbors.slice(0, 5)) {
      console.log(`    ${n.localInterface} → ${n.remoteDevice} (${n.remoteInterface}) [${n.remoteIp || 'no IP'}]`);
    }
    if (lldpNeighbors.length > 5) console.log(`    ... and ${lldpNeighbors.length - 5} more`);
    console.log();

    // -----------------------------------------------------------------------
    // 5. ARP Table
    // -----------------------------------------------------------------------
    console.log('[5/5] Collecting ARP table...');
    const arpTable = await getArpTable(walker, { verbose });
    const arpCount = Object.keys(arpTable).length;
    console.log(`  Found ${arpCount} ARP entries`);

    // Show first 5
    const arpEntries = Object.entries(arpTable).slice(0, 5);
    for (const [mac, ip] of arpEntries) {
      console.log(`    ${mac} → ${ip}`);
    }
    if (arpCount > 5) console.log(`    ... and ${arpCount - 5} more`);
    console.log();

    // -----------------------------------------------------------------------
    // Assemble Device
    // -----------------------------------------------------------------------
    const elapsed = Date.now() - startTime;

    const allNeighbors = [...cdpNeighbors, ...lldpNeighbors];

    const device = new Device({
      hostname:           systemInfo.sys_name || target,
      ipAddress:          target,
      sysName:            systemInfo.sys_name,
      sysDescr:           systemInfo.sys_descr,
      sysLocation:        systemInfo.sys_location,
      sysContact:         systemInfo.sys_contact,
      sysObjectId:        systemInfo.sys_object_id,
      uptimeTicks:        systemInfo.uptime_ticks,
      vendor:             systemInfo.vendor,
      interfaces:         Object.values(interfaces),
      neighbors:          allNeighbors,
      arpTable:           arpTable,
      discoveryDurationMs: elapsed,
    });

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    console.log(`${'='.repeat(60)}`);
    console.log(`  Discovery complete in ${elapsed}ms`);
    console.log(`  Device:     ${device.hostname} (${device.ipAddress})`);
    console.log(`  Vendor:     ${device.vendor}`);
    console.log(`  Interfaces: ${device.interfaces.length}`);
    console.log(`  CDP:        ${device.cdpNeighbors.length}`);
    console.log(`  LLDP:       ${device.lldpNeighbors.length}`);
    console.log(`  ARP:        ${Object.keys(device.arpTable).length}`);
    console.log(`${'='.repeat(60)}\n`);

    // -----------------------------------------------------------------------
    // Write JSON output
    // -----------------------------------------------------------------------
    const outFile = `${device.hostname || target}.json`;
    const fs = require('fs');
    fs.writeFileSync(outFile, device.toJSON());
    console.log(`  Wrote ${outFile}`);

  } catch (err) {
    console.error('\nDiscovery failed:', err.message);
    if (verbose) console.error(err.stack);
    process.exit(1);
  } finally {
    walker.close();
  }
}

main();