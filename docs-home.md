# Secure Cartography — API Reference

Recursive SNMP network discovery with topology mapping. Electron desktop app and Node.js CLI.

## Architecture

```
Electron App (main.js)                    CLI (sc-js.js)
        │                                       │
        └──────── DiscoveryEngine ──────────────┘
                        │
          ┌─────────────┼─────────────┐
          │             │             │
     NetSnmpWalker  Collectors   Topology Map
     (walker.js)        │        (engine.js)
                   ┌────┼────┐
                   │    │    │
               system  cdp  lldp  interfaces  arp
```

The **DiscoveryEngine** is the core orchestrator. It manages concurrent SNMP sessions (one `NetSnmpWalker` per device), runs collectors in sequence, handles credential caching and neighbor deduplication, and generates the topology map.

Two entry points share the same engine:

- **main.js** — Electron main process. Receives config via IPC from the renderer, runs the engine, forwards events back to the GUI.
- **sc-js.js** — CLI entry point. Parses arguments via commander, constructs the engine, streams output to the terminal.

## Module Overview

| Module | Purpose |
|--------|---------|
| `engine.js` | `DiscoveryEngine` class — crawl orchestration, topology map generation, credential caching, dedup |
| `walker.js` | `NetSnmpWalker` class — net-snmp session wrapper (v2c + v3), walker contract implementation |
| `lldp.js` | LLDP-MIB collector — `lldpRemTable` walk, subtype decoding, management address resolution |
| `cdp.js` | CISCO-CDP-MIB collector — CDP neighbor table with platform and capabilities |
| `system.js` | SNMPv2-MIB system group — sysName, sysDescr, sysObjectID, vendor detection |
| `interfaces.js` | IF-MIB interface table — ifName, ifDescr, ifAlias, status, MAC, speed |
| `arp.js` | IP-MIB ARP table — MAC → IP resolution for neighbor IP lookup |
| `models.js` | Data classes — `Device`, `Neighbor`, `Interface`, `DiscoveryResult` |
| `events.js` | `DiscoveryEmitter` — typed event system for GUI/CLI integration |
| `creds.js` | Credential providers — v2c community strings, v3 user/auth/priv |
| `parsers.js` | Value decoding — SNMP buffer parsing, vendor detection, hostname extraction |
| `oids.js` | OID constants — numeric OIDs for all MIB tables (no MIB file resolution) |
| `stt-gen.js` | STT-SNMP proxy — port map generation and runtime IP → localhost:port lookup |
| `main.js` | Electron main process — IPC handlers, splash screen, native dialogs |

## Key Patterns

### Walker Contract

Every collector receives a `walker` object and calls its methods. The walker owns the SNMP session (target + credentials). Collectors never see transport details.

```javascript
const info = await getSystemInfo(walker, { verbose: true });
const neighbors = await getLldpNeighbors(walker, { interfaceTable, timeout: 15000 });
```

### Event-Driven Discovery

The engine emits typed events throughout discovery. The Electron GUI and CLI both consume these through the same `DiscoveryEmitter` interface.

```javascript
const emitter = new DiscoveryEmitter();
emitter.on('device_complete', (data) => { /* update UI */ });
emitter.on('crawl_complete', (data) => { /* show summary */ });

const engine = new DiscoveryEngine({ events: emitter });
```

### Topology Map Determinism

The topology map generator sorts LLDP neighbors so hostname-identified entries always win the per-interface dedup gate over bare MAC addresses. The `peerExclude` option filters firmware noise strings. See the `_generateTopologyMap()` method in `DiscoveryEngine`.

## Getting Started

```bash
# Install dependencies
npm install

# Generate docs (after adding jsdoc to devDependencies)
npm run docs

# Serve locally
npx http-server docs -p 8080
```