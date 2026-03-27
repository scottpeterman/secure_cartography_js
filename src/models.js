/**
 * secure-cartography-js — Data Models.
 *
 * Four enums + four classes, ported from map_pioneer models.py.
 *
 * Session 2 update: Added engine-level properties to Device
 * (discoverySuccess, discoveryErrors, depth, discoveredVia, fqdn,
 * credentialUsed, discoveryDurationMs) and full DiscoveryResult class.
 *
 * Conventions:
 *   - JS properties: camelCase
 *   - JSON output (toDict): snake_case (for map_pioneer / VelocityCMDB compat)
 *   - fromDict() accepts snake_case input
 */

'use strict';

// =========================================================================
// Enums
// =========================================================================

const DiscoveryProtocol = Object.freeze({
  SNMP: 'snmp',
  SSH: 'ssh',
  MANUAL: 'manual',
});

const NeighborProtocol = Object.freeze({
  CDP: 'cdp',
  LLDP: 'lldp',
});

const InterfaceStatus = Object.freeze({
  UP: 'up',
  DOWN: 'down',
  TESTING: 'testing',
  UNKNOWN: 'unknown',
  DORMANT: 'dormant',
  NOT_PRESENT: 'notPresent',
  LOWER_LAYER_DOWN: 'lowerLayerDown',
});

const DeviceVendor = Object.freeze({
  CISCO: 'cisco',
  ARISTA: 'arista',
  JUNIPER: 'juniper',
  PALOALTO: 'paloalto',
  FORTINET: 'fortinet',
  UNKNOWN: 'unknown',
});


// =========================================================================
// Interface
// =========================================================================

class Interface {
  constructor(opts = {}) {
    this.ifIndex = opts.ifIndex || 0;
    this.ifName = opts.ifName || '';
    this.ifDescr = opts.ifDescr || '';
    this.ifAlias = opts.ifAlias || '';
    this.ifOperStatus = opts.ifOperStatus || InterfaceStatus.UNKNOWN;
    this.ifPhysAddress = opts.ifPhysAddress || '';
    this.ifHighSpeed = opts.ifHighSpeed || 0;
    this.ifMtu = opts.ifMtu || 0;
  }

  toDict() {
    return {
      if_index: this.ifIndex,
      if_name: this.ifName,
      if_descr: this.ifDescr,
      if_alias: this.ifAlias,
      if_oper_status: this.ifOperStatus,
      if_phys_address: this.ifPhysAddress,
      if_high_speed: this.ifHighSpeed,
      if_mtu: this.ifMtu,
    };
  }

  static fromDict(d) {
    return new Interface({
      ifIndex: d.if_index,
      ifName: d.if_name,
      ifDescr: d.if_descr,
      ifAlias: d.if_alias,
      ifOperStatus: d.if_oper_status,
      ifPhysAddress: d.if_phys_address,
      ifHighSpeed: d.if_high_speed,
      ifMtu: d.if_mtu,
    });
  }
}


// =========================================================================
// Neighbor
// =========================================================================

class Neighbor {
  constructor(opts = {}) {
    this.localInterface = opts.localInterface || '';
    this.remoteDevice = opts.remoteDevice || '';
    this.remoteInterface = opts.remoteInterface || '';
    this.remoteIp = opts.remoteIp || '';
    this.remotePlatform = opts.remotePlatform || '';
    this.remoteDescription = opts.remoteDescription || '';
    this.protocol = opts.protocol || '';
    this.chassisId = opts.chassisId || '';
    this.portId = opts.portId || '';
    this.managementIp = opts.managementIp || '';
    this.capabilities = opts.capabilities || '';
  }

  toDict() {
    return {
      local_interface: this.localInterface,
      remote_device: this.remoteDevice,
      remote_interface: this.remoteInterface,
      remote_ip: this.remoteIp,
      remote_platform: this.remotePlatform,
      remote_description: this.remoteDescription,
      protocol: this.protocol,
      chassis_id: this.chassisId,
      port_id: this.portId,
      management_ip: this.managementIp,
      capabilities: this.capabilities,
    };
  }

  static fromDict(d) {
    return new Neighbor({
      localInterface: d.local_interface,
      remoteDevice: d.remote_device,
      remoteInterface: d.remote_interface,
      remoteIp: d.remote_ip,
      remotePlatform: d.remote_platform,
      remoteDescription: d.remote_description,
      protocol: d.protocol,
      chassisId: d.chassis_id,
      portId: d.port_id,
      managementIp: d.management_ip,
      capabilities: d.capabilities,
    });
  }

  /**
   * Create Neighbor from CDP collector output.
   * Maps CDP-specific field names to Neighbor properties.
   */
  static fromCdp(opts) {
    return new Neighbor({
      localInterface: opts.localInterface || '',
      remoteDevice: opts.deviceId || opts.remoteDevice || '',
      remoteInterface: opts.remotePort || opts.remoteInterface || '',
      remoteIp: opts.ipAddress || opts.remoteIp || '',
      remotePlatform: opts.platform || opts.remotePlatform || '',
      remoteDescription: opts.remoteDescription || '',
      chassisId: opts.chassisId || '',
      portId: opts.portId || '',
      managementIp: opts.managementIp || '',
      capabilities: opts.capabilities || '',
      protocol: NeighborProtocol.CDP,
    });
  }

  /**
   * Create Neighbor from LLDP collector output.
   * lldp.js passes: systemName, portId, managementAddress, chassisId,
   * portDescription, systemDescription, capabilities (from Python from_lldp).
   * Falls back to chassisId for remoteDevice when systemName is absent.
   */
  static fromLldp(opts) {
    return new Neighbor({
      localInterface: opts.localInterface || '',
      remoteDevice: opts.remoteDevice || opts.systemName || opts.sysName || opts.chassisId || '',
      remoteInterface: opts.remoteInterface || opts.portId || opts.portDescription || '',
      remoteIp: opts.remoteIp || opts.managementAddress || opts.managementIp || '',
      remotePlatform: opts.remotePlatform || '',
      remoteDescription: opts.remoteDescription || opts.systemDescription || '',
      chassisId: opts.chassisId || '',
      portId: opts.portId || '',
      managementIp: opts.managementAddress || opts.managementIp || '',
      capabilities: opts.capabilities || '',
      protocol: NeighborProtocol.LLDP,
    });
  }
}


// =========================================================================
// Device
// =========================================================================

class Device {
  constructor(opts = {}) {
    // Identity
    this.hostname = opts.hostname || '';
    this.ipAddress = opts.ipAddress || '';
    this.sysName = opts.sysName || '';
    this.sysDescr = opts.sysDescr || '';
    this.sysLocation = opts.sysLocation || '';
    this.sysContact = opts.sysContact || '';
    this.sysObjectId = opts.sysObjectId || '';
    this.uptimeTicks = opts.uptimeTicks || 0;
    this.vendor = opts.vendor || DeviceVendor.UNKNOWN;
    this.fqdn = opts.fqdn || '';

    // Collections
    this.interfaces = opts.interfaces || [];
    this.neighbors = opts.neighbors || [];
    this.arpTable = opts.arpTable || {};

    // Discovery metadata (engine-level)
    this.depth = opts.depth || 0;
    this.discoveredVia = opts.discoveredVia || '';
    this.discoverySuccess = opts.discoverySuccess !== undefined ? opts.discoverySuccess : true;
    this.discoveryErrors = opts.discoveryErrors || [];
    this.discoveryDurationMs = opts.discoveryDurationMs || 0;
    this.credentialUsed = opts.credentialUsed || '';
  }

  /**
   * Add neighbor with dedup (same remote_device + local_interface = skip).
   */
  addNeighbor(neighbor) {
    const isDup = this.neighbors.some(
      n => n.remoteDevice === neighbor.remoteDevice
        && n.localInterface === neighbor.localInterface
        && n.protocol === neighbor.protocol
    );
    if (!isDup) {
      this.neighbors.push(neighbor);
    }
  }

  // Computed properties
  get cdpNeighbors() {
    return this.neighbors.filter(n => n.protocol === NeighborProtocol.CDP);
  }

  get lldpNeighbors() {
    return this.neighbors.filter(n => n.protocol === NeighborProtocol.LLDP);
  }

  get interfaceByIndex() {
    const map = {};
    for (const iface of this.interfaces) {
      map[iface.ifIndex] = iface;
    }
    return map;
  }

  get interfaceByName() {
    const map = {};
    for (const iface of this.interfaces) {
      if (iface.ifName) map[iface.ifName] = iface;
    }
    return map;
  }

  toDict() {
    return {
      hostname: this.hostname,
      ip_address: this.ipAddress,
      sys_name: this.sysName,
      sys_descr: this.sysDescr,
      sys_location: this.sysLocation,
      sys_contact: this.sysContact,
      sys_object_id: this.sysObjectId,
      uptime_ticks: this.uptimeTicks,
      vendor: this.vendor,
      fqdn: this.fqdn,
      interfaces: this.interfaces.map(i =>
        i instanceof Interface ? i.toDict() : i
      ),
      neighbors: this.neighbors.map(n =>
        n instanceof Neighbor ? n.toDict() : n
      ),
      arp_table: this.arpTable,
      depth: this.depth,
      discovered_via: this.discoveredVia,
      discovery_success: this.discoverySuccess,
      discovery_errors: this.discoveryErrors,
      discovery_duration_ms: this.discoveryDurationMs,
      credential_used: this.credentialUsed,
    };
  }

  static fromDict(d) {
    return new Device({
      hostname: d.hostname,
      ipAddress: d.ip_address,
      sysName: d.sys_name,
      sysDescr: d.sys_descr,
      sysLocation: d.sys_location,
      sysContact: d.sys_contact,
      sysObjectId: d.sys_object_id,
      uptimeTicks: d.uptime_ticks,
      vendor: d.vendor,
      fqdn: d.fqdn,
      interfaces: (d.interfaces || []).map(Interface.fromDict),
      neighbors: (d.neighbors || []).map(Neighbor.fromDict),
      arpTable: d.arp_table || {},
      depth: d.depth,
      discoveredVia: d.discovered_via,
      discoverySuccess: d.discovery_success,
      discoveryErrors: d.discovery_errors,
      discoveryDurationMs: d.discovery_duration_ms,
      credentialUsed: d.credential_used,
    });
  }
}


// =========================================================================
// DiscoveryResult
// =========================================================================

class DiscoveryResult {
  constructor(opts = {}) {
    this.seedDevices = opts.seedDevices || [];
    this.maxDepth = opts.maxDepth || 0;
    this.domains = opts.domains || [];
    this.excludePatterns = opts.excludePatterns || [];

    this.startedAt = opts.startedAt || null;
    this.completedAt = opts.completedAt || null;

    this.devices = opts.devices || [];
    this.totalAttempted = opts.totalAttempted || 0;
    this.successful = opts.successful || 0;
    this.failed = opts.failed || 0;
    this.excluded = opts.excluded || 0;
  }

  get durationSeconds() {
    if (this.startedAt && this.completedAt) {
      return (this.completedAt.getTime() - this.startedAt.getTime()) / 1000;
    }
    return null;
  }

  toDict() {
    return {
      seed_devices: this.seedDevices,
      max_depth: this.maxDepth,
      domains: this.domains,
      exclude_patterns: this.excludePatterns,
      started_at: this.startedAt ? this.startedAt.toISOString() : null,
      completed_at: this.completedAt ? this.completedAt.toISOString() : null,
      total_attempted: this.totalAttempted,
      successful: this.successful,
      failed: this.failed,
      excluded: this.excluded,
      duration_seconds: this.durationSeconds,
      devices: this.devices.map(d =>
        d instanceof Device ? d.toDict() : d
      ),
    };
  }
}


module.exports = {
  DiscoveryProtocol,
  NeighborProtocol,
  InterfaceStatus,
  DeviceVendor,
  Interface,
  Neighbor,
  Device,
  DiscoveryResult,
};