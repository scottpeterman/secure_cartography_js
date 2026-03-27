#!/usr/bin/env node

/**
 * secure-cartography-js — CLI Entry Point.
 *
 * Three commands:
 *   test      Quick SNMP reachability check
 *   discover  Single device discovery with full collector suite
 *   crawl     Recursive neighbor-walk discovery
 *
 * Ported from map_pioneer cli.py using commander.
 */

'use strict';

const { program } = require('commander');
const path = require('path');
const fs = require('fs').promises;

const { DiscoveryEngine } = require('./engine');
const { DiscoveryEmitter, ConsoleEventPrinter, JsonEventPrinter } = require('./events');
const { buildCredsFromArgs, credToWalkerAuth } = require('./creds');
const { NetSnmpWalker } = require('./walker');
const { getSystemInfo } = require('./system');
const { loadSttLookup } = require('./stt-gen');


// =========================================================================
// Shared Options
// =========================================================================

function addGlobalOptions(cmd) {
  return cmd
    .option('-v, --verbose', 'Enable debug output')
    .option('--json', 'Structured JSON output to stdout')
    .option('--json-events', 'JSON lines event stream to stderr')
    .option('-t, --timeout <seconds>', 'SNMP timeout in seconds', parseFloat, 5.0)
    .option('--no-dns', 'Disable DNS lookups')
    .option('--stt-file <path>', 'STT-SNMP proxy YAML file for tunneled discovery');
}

function addCredOptions(cmd) {
  return cmd
    .option('-c, --community <string...>', 'SNMPv2c community string(s)')
    .option('--v3-user <string>', 'SNMPv3 username (triggers v3 mode)')
    .option('--v3-auth-pass <string>', 'SNMPv3 auth password')
    .option('--v3-priv-pass <string>', 'SNMPv3 priv password')
    .option('--v3-auth-proto <proto>', 'SNMPv3 auth protocol', 'sha')
    .option('--v3-priv-proto <proto>', 'SNMPv3 priv protocol', 'aes');
}


// =========================================================================
// STT Helper
// =========================================================================

function loadSttFromOpts(opts) {
  if (!opts.sttFile) return null;
  try {
    const lookup = loadSttLookup(opts.sttFile);
    if (opts.verbose) {
      console.log(`  [stt] Loaded ${lookup.size} proxy mappings from ${opts.sttFile}`);
    }
    return lookup;
  } catch (e) {
    console.error(`Error loading STT file ${opts.sttFile}: ${e.message}`);
    process.exit(1);
  }
}

function resolveStt(target, sttLookup) {
  if (sttLookup && sttLookup.has(target)) {
    const m = sttLookup.get(target);
    return { host: m.host, port: m.port };
  }
  return { host: target, port: 161 };
}


// =========================================================================
// Test Command
// =========================================================================

async function cmdTest(target, opts) {
  const community = (opts.community && opts.community[0]) || 'public';
  const timeout = (opts.timeout || 5) * 1000;
  const sttLookup = loadSttFromOpts(opts);
  const { host, port } = resolveStt(target, sttLookup);

  const auth = { version: 2, community };
  const walker = new NetSnmpWalker(host, auth, { timeout, port });

  if (!opts.json) {
    const via = port !== 161 ? ` via STT ${host}:${port}` : '';
    console.log(`Testing SNMP to ${target} (community: ${community}, timeout: ${opts.timeout}s${via})`);
  }

  try {
    const sysInfo = await getSystemInfo(walker, { verbose: opts.verbose });

    if (sysInfo.sys_name || sysInfo.sys_descr) {
      if (opts.json) {
        const result = {
          target,
          success: true,
          sys_name: sysInfo.sys_name,
          sys_descr: sysInfo.sys_descr,
          vendor: sysInfo.vendor || 'unknown',
          sys_location: sysInfo.sys_location,
          sys_contact: sysInfo.sys_contact,
          uptime_ticks: sysInfo.uptime_ticks,
        };
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`  sysName:     ${sysInfo.sys_name || 'N/A'}`);
        console.log(`  sysDescr:    ${sysInfo.sys_descr || 'N/A'}`);
        console.log(`  Vendor:      ${sysInfo.vendor || 'unknown'}`);
        console.log(`  sysLocation: ${sysInfo.sys_location || 'N/A'}`);

        const uptime = sysInfo.uptime_ticks;
        if (uptime) {
          const days = Math.floor(uptime / 8640000);
          const hours = Math.floor((uptime % 8640000) / 360000);
          console.log(`  Uptime:      ${days}d ${hours}h (${uptime} ticks)`);
        }

        console.log('\n  SNMP reachable.');
      }
      process.exitCode = 0;
    } else {
      if (opts.json) {
        console.log(JSON.stringify({ target, success: false, error: 'No system data returned' }));
      } else {
        console.log(`  No response from ${target} — SNMP unreachable or wrong community.`);
      }
      process.exitCode = 1;
    }
  } catch (e) {
    if (opts.json) {
      console.log(JSON.stringify({ target, success: false, error: e.message }));
    } else {
      console.log(`  Error: ${e.message}`);
    }
    process.exitCode = 1;
  } finally {
    walker.close();
  }
}


// =========================================================================
// Discover Command
// =========================================================================

async function cmdDiscover(target, opts) {
  const credProvider = buildCredsFromArgs(opts);
  const sttLookup = loadSttFromOpts(opts);

  // Events
  const emitter = new DiscoveryEmitter();
  if (opts.jsonEvents) {
    new JsonEventPrinter().attach(emitter);
  } else if (!opts.json) {
    new ConsoleEventPrinter({ verbose: opts.verbose }).attach(emitter);
  }

  const engine = new DiscoveryEngine({
    credentialProvider: credProvider,
    timeout: opts.timeout,
    verbose: opts.verbose,
    noDns: !opts.dns,
    events: emitter,
    sttLookup,
  });

  const device = await engine.discoverDevice(target, {
    domains: opts.domains || [],
    collectArp: opts.arp !== false,
  });

  // Save per-device files
  if (opts.outputDir) {
    await fs.mkdir(opts.outputDir, { recursive: true });
    await engine._saveDeviceFiles(device, opts.outputDir);
    if (!opts.json) {
      console.log(`\nDevice files saved to: ${opts.outputDir}`);
    }
  }

  // Output
  if (opts.json) {
    console.log(JSON.stringify(device.toDict(), null, 2));
  } else if (!opts.jsonEvents) {
    printDeviceSummary(device);
  }

  process.exitCode = device.discoverySuccess ? 0 : 1;
}


// =========================================================================
// Crawl Command
// =========================================================================

async function cmdCrawl(seeds, opts) {
  const credProvider = buildCredsFromArgs(opts);
  const sttLookup = loadSttFromOpts(opts);

  // Events
  const emitter = new DiscoveryEmitter();
  if (opts.jsonEvents) {
    new JsonEventPrinter().attach(emitter);
  } else if (!opts.json) {
    new ConsoleEventPrinter({ verbose: opts.verbose }).attach(emitter);
  }

  const engine = new DiscoveryEngine({
    credentialProvider: credProvider,
    timeout: opts.timeout,
    verbose: opts.verbose,
    noDns: !opts.dns,
    maxConcurrent: parseInt(opts.maxConcurrent, 10) || 20,
    events: emitter,
    sttLookup,
    peerExclude: opts.peerExclude || [],
  });

  const result = await engine.crawl({
    seeds,
    maxDepth: parseInt(opts.maxDepth, 10) || 3,
    domains: opts.domains || [],
    excludePatterns: opts.exclude || [],
    outputDir: opts.outputDir || null,
  });

  // JSON output
  if (opts.json) {
    const summary = {
      seeds: result.seedDevices,
      max_depth: result.maxDepth,
      devices_found: result.devices.length,
      devices_successful: result.devices.filter(d => d.discoverySuccess).length,
      devices_failed: result.devices.filter(d => !d.discoverySuccess).length,
      duration_seconds: result.durationSeconds,
      devices: result.devices.map(d => d.toDict()),
    };
    console.log(JSON.stringify(summary, null, 2));
  } else if (!opts.jsonEvents) {
    printCrawlSummary(result);
  }

  if (opts.outputDir && !opts.json) {
    console.log(`\nOutput saved to: ${opts.outputDir}`);
  }

  process.exitCode = result.devices.length > 0 ? 0 : 1;
}


// =========================================================================
// Output Formatting
// =========================================================================

function printDeviceSummary(device) {
  const status = device.discoverySuccess ? 'OK' : 'FAILED';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${device.hostname || device.ipAddress}  [${status}]`);
  console.log('='.repeat(60));

  if (!device.discoverySuccess) {
    for (const err of (device.discoveryErrors || [])) {
      console.log(`  Error: ${err}`);
    }
    return;
  }

  console.log(`  IP:          ${device.ipAddress}`);
  console.log(`  sysName:     ${device.sysName || 'N/A'}`);
  console.log(`  Vendor:      ${device.vendor || 'unknown'}`);

  if (device.sysDescr) {
    let firstLine = device.sysDescr.split('\n')[0].trim();
    if (firstLine.length > 80) firstLine = firstLine.slice(0, 77) + '...';
    console.log(`  sysDescr:    ${firstLine}`);
  }

  if (device.interfaces) {
    console.log(`  Interfaces:  ${device.interfaces.length}`);
  }

  const cdpCount = device.cdpNeighbors ? device.cdpNeighbors.length : 0;
  const lldpCount = device.lldpNeighbors ? device.lldpNeighbors.length : 0;
  const totalNeighbors = cdpCount + lldpCount;

  if (totalNeighbors) {
    console.log(`  Neighbors:   ${totalNeighbors} (CDP: ${cdpCount}, LLDP: ${lldpCount})`);
    for (const n of (device.cdpNeighbors || [])) {
      console.log(`    CDP  ${(n.localInterface || '').padEnd(20)} → ${(n.remoteDevice || 'unknown').padEnd(30)} ${n.remoteInterface || ''}`);
    }
    for (const n of (device.lldpNeighbors || [])) {
      console.log(`    LLDP ${(n.localInterface || '').padEnd(20)} → ${(n.remoteDevice || 'unknown').padEnd(30)} ${n.remoteInterface || ''}`);
    }
  }

  if (device.arpTable && Object.keys(device.arpTable).length > 0) {
    console.log(`  ARP entries: ${Object.keys(device.arpTable).length}`);
  }
}

function printCrawlSummary(result) {
  const total = result.devices.length;
  const ok = result.devices.filter(d => d.discoverySuccess).length;
  const failed = total - ok;

  console.log(`\n${'='.repeat(60)}`);
  console.log('  Crawl Complete');
  console.log('='.repeat(60));
  console.log(`  Seeds:       ${result.seedDevices.join(', ')}`);
  console.log(`  Max depth:   ${result.maxDepth}`);
  console.log(`  Discovered:  ${ok} devices`);
  if (failed) console.log(`  Failed:      ${failed} devices`);
  if (result.durationSeconds) {
    console.log(`  Duration:    ${result.durationSeconds.toFixed(1)}s`);
  }

  if (result.devices.length > 0) {
    console.log('\n  Devices:');
    const sorted = [...result.devices].sort((a, b) =>
      (a.ipAddress || '').localeCompare(b.ipAddress || '')
    );
    for (const d of sorted) {
      const status = d.discoverySuccess ? 'OK' : 'FAIL';
      const name = d.sysName || d.hostname || d.ipAddress;
      const vendor = d.vendor || '';
      const nCount = (d.cdpNeighbors || []).length + (d.lldpNeighbors || []).length;
      console.log(`    [${status.padEnd(4)}] ${(d.ipAddress || '').padEnd(16)} ${name.padEnd(30)} ${String(vendor).padEnd(12)} neighbors:${nCount}`);
    }
  }
}


// =========================================================================
// Program Definition
// =========================================================================

program
  .name('sc-js')
  .description('Network discovery crawler — SNMP neighbor walk with recursive topology mapping.')
  .version('0.1.0');

// --- test ---
const testCmd = program
  .command('test <target>')
  .description('Quick SNMP reachability check');
addGlobalOptions(testCmd);
addCredOptions(testCmd);
testCmd.action(cmdTest);

// --- discover ---
const discoverCmd = program
  .command('discover <target>')
  .description('Single device, full collector suite');
addGlobalOptions(discoverCmd);
addCredOptions(discoverCmd);
discoverCmd
  .option('-o, --output-dir <dir>', 'Directory for device JSON files')
  .option('-d, --domains <domain...>', 'Domain suffix for hostname resolution')
  .option('--no-arp', 'Skip ARP table collection')
  .action(cmdDiscover);

// --- crawl ---
const crawlCmd = program
  .command('crawl <seeds...>')
  .description('Recursive neighbor-walk discovery');
addGlobalOptions(crawlCmd);
addCredOptions(crawlCmd);
crawlCmd
  .option('-o, --output-dir <dir>', 'Directory for per-device JSON and map.json')
  .option('--max-depth <n>', 'Maximum recursion depth', '3')
  .option('--max-concurrent <n>', 'Max concurrent SNMP sessions', '20')
  .option('-d, --domains <domain...>', 'Domain suffix for hostname resolution')
  .option('-x, --exclude <pattern...>', 'Exclude pattern for sysDescr/hostname')
  .option('--peer-exclude <pattern...>', 'Exclude peer name substrings from topology map (e.g. "Broadcom Adv." "fw_version:")')
  .action(cmdCrawl);

// Parse and run
program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});