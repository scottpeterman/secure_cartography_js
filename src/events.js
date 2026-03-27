/**
 * secure-cartography-js — Discovery Event System.
 *
 * Structured events for CLI and future Electron GUI integration.
 * The discovery engine emits events consumed by printers or GUI handlers.
 *
 * Event Flow:
 *   crawl_started → depth_started → device_queued* → device_started →
 *   device_complete/device_failed → neighbor_queued* → depth_complete →
 *   ... → crawl_complete
 *
 * Ported from map_pioneer events.py. Uses Node's built-in EventEmitter
 * as the base — this is native territory for JS.
 */

'use strict';

const { EventEmitter } = require('events');

// =========================================================================
// Event Types
// =========================================================================

const EventType = Object.freeze({
  // Crawl lifecycle
  CRAWL_STARTED: 'crawl_started',
  CRAWL_COMPLETE: 'crawl_complete',
  CRAWL_CANCELLED: 'crawl_cancelled',

  // Depth progression
  DEPTH_STARTED: 'depth_started',
  DEPTH_COMPLETE: 'depth_complete',

  // Device discovery
  DEVICE_QUEUED: 'device_queued',
  DEVICE_STARTED: 'device_started',
  DEVICE_COMPLETE: 'device_complete',
  DEVICE_FAILED: 'device_failed',
  DEVICE_EXCLUDED: 'device_excluded',

  // Neighbor processing
  NEIGHBOR_QUEUED: 'neighbor_queued',
  NEIGHBOR_SKIPPED: 'neighbor_skipped',

  // Aggregated updates (for efficient GUI updates)
  STATS_UPDATED: 'stats_updated',
  TOPOLOGY_UPDATED: 'topology_updated',

  // Log messages
  LOG_MESSAGE: 'log_message',
});

const LogLevel = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  SUCCESS: 'success',
});


// =========================================================================
// Discovery Event Emitter
// =========================================================================

class DiscoveryEmitter extends EventEmitter {
  /**
   * Extended EventEmitter with discovery-specific convenience methods
   * and built-in stats tracking.
   */
  constructor() {
    super();
    this.stats = this._freshStats();
  }

  _freshStats() {
    return {
      discovered: 0,
      failed: 0,
      queue: 0,
      total: 0,
      excluded: 0,
      skipped: 0,
      currentDepth: 0,
      maxDepth: 0,
      depthProgress: 0.0,
      currentDevice: '',
      status: 'Ready',
    };
  }

  resetStats() {
    this.stats = this._freshStats();
  }

  // ---- Convenience emitters (match map_pioneer events.py) ----

  crawlStarted(seeds, maxDepth, domains, excludePatterns, options = {}) {
    this.resetStats();
    this.stats.maxDepth = maxDepth;
    this.stats.queue = seeds.length;
    this.stats.status = 'Starting';

    this.emit(EventType.CRAWL_STARTED, {
      seeds,
      maxDepth,
      domains,
      excludePatterns,
      noDns: options.noDns || false,
      concurrency: options.concurrency || 20,
      timeout: options.timeout || 5.0,
      totalSeeds: seeds.length,
    });
    this._emitStatsUpdate();
  }

  crawlComplete(durationSeconds, topology) {
    this.stats.status = 'Complete';
    this.stats.queue = 0;
    this.stats.depthProgress = 1.0;

    this.emit(EventType.CRAWL_COMPLETE, {
      discovered: this.stats.discovered,
      failed: this.stats.failed,
      total: this.stats.total,
      excluded: this.stats.excluded,
      durationSeconds,
      topology,
    });
    this._emitStatsUpdate();
  }

  crawlCancelled() {
    this.stats.status = 'Cancelled';
    this.emit(EventType.CRAWL_CANCELLED, {});
    this._emitStatsUpdate();
  }

  depthStarted(depth, deviceCount) {
    this.stats.currentDepth = depth;
    this.stats.status = `Depth ${depth}`;

    if (this.stats.maxDepth > 0) {
      this.stats.depthProgress = depth / this.stats.maxDepth;
    } else {
      this.stats.depthProgress = 0.0;
    }

    this.emit(EventType.DEPTH_STARTED, {
      depth,
      maxDepth: this.stats.maxDepth,
      deviceCount,
    });
    this._emitStatsUpdate();
  }

  depthComplete(depth, discovered, failed) {
    this.emit(EventType.DEPTH_COMPLETE, { depth, discovered, failed });
  }

  deviceQueued(target, depth, source = '') {
    this.stats.queue += 1;
    this.emit(EventType.DEVICE_QUEUED, { target, depth, source });
    // Don't emit stats for every queue — too noisy
  }

  deviceStarted(target, depth) {
    this.stats.currentDevice = target;
    this.stats.status = `Discovering: ${target}`;
    this.emit(EventType.DEVICE_STARTED, { target, depth });
    this._emitStatsUpdate();
  }

  deviceComplete(target, hostname, ip, vendor, neighborCount, durationMs, method, depth) {
    this.stats.discovered += 1;
    this.stats.total += 1;
    this.stats.queue = Math.max(0, this.stats.queue - 1);

    this.emit(EventType.DEVICE_COMPLETE, {
      target, hostname, ip, vendor,
      neighborCount, durationMs, method, depth,
    });
    this._emitStatsUpdate();
  }

  deviceFailed(target, error, depth) {
    this.stats.failed += 1;
    this.stats.total += 1;
    this.stats.queue = Math.max(0, this.stats.queue - 1);

    this.emit(EventType.DEVICE_FAILED, { target, error, depth });
    this._emitStatsUpdate();
  }

  deviceExcluded(hostname, pattern) {
    this.stats.excluded += 1;
    this.emit(EventType.DEVICE_EXCLUDED, { hostname, pattern });
    this._emitStatsUpdate();
  }

  neighborQueued(target, ip, fromDevice, depth) {
    this.stats.queue += 1;
    this.emit(EventType.NEIGHBOR_QUEUED, { target, ip, fromDevice, depth });
    this._emitStatsUpdate();
  }

  neighborSkipped(target, reason, fromDevice) {
    this.stats.skipped += 1;
    this.emit(EventType.NEIGHBOR_SKIPPED, { target, reason, fromDevice });
  }

  topologyUpdated(topology) {
    this.emit(EventType.TOPOLOGY_UPDATED, { topology, deviceCount: Object.keys(topology).length });
  }

  log(message, level = LogLevel.INFO, device = '') {
    this.emit(EventType.LOG_MESSAGE, { message, level, device });
  }

  _emitStatsUpdate() {
    this.emit(EventType.STATS_UPDATED, { ...this.stats });
  }
}


// =========================================================================
// Console Event Printer (for CLI)
// =========================================================================

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

class ConsoleEventPrinter {
  /**
   * Prints discovery events to console with optional color.
   *
   * Usage:
   *   const printer = new ConsoleEventPrinter({ verbose: true });
   *   printer.attach(emitter);
   */
  constructor(options = {}) {
    this.verbose = options.verbose || false;
    this.color = options.color !== undefined ? options.color : true;
    this.showTimestamps = options.showTimestamps || false;
  }

  _c(text, ...colors) {
    if (!this.color) return text;
    const codes = colors.map(c => COLORS[c] || '').join('');
    return `${codes}${text}${COLORS.reset}`;
  }

  _ts() {
    if (!this.showTimestamps) return '';
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `[${h}:${m}:${s}] `;
  }

  /**
   * Attach this printer to a DiscoveryEmitter.
   * Subscribes to all event types.
   */
  attach(emitter) {
    const handler = (type, data) => {
      const method = `_handle_${type}`;
      if (typeof this[method] === 'function') {
        this[method](data);
      } else if (this.verbose) {
        console.log(`${this._ts()}[${type}]`, data);
      }
    };

    // Subscribe to each known event type
    for (const type of Object.values(EventType)) {
      emitter.on(type, (data) => handler(type, data));
    }
  }

  _handle_crawl_started(data) {
    console.log();
    console.log(this._c('='.repeat(60), 'cyan', 'bold'));
    console.log(this._c('NETWORK DISCOVERY STARTED', 'cyan', 'bold'));
    console.log(this._c('='.repeat(60), 'cyan', 'bold'));
    console.log(`Seeds: ${data.seeds.join(', ')}`);
    console.log(`Max Depth: ${data.maxDepth}`);
    if (data.domains && data.domains.length) {
      console.log(`Domains: ${data.domains.join(', ')}`);
    }
    if (data.excludePatterns && data.excludePatterns.length) {
      console.log(`Exclude: ${data.excludePatterns.join(', ')}`);
    }
    console.log();
  }

  _handle_crawl_complete(data) {
    console.log();
    console.log(this._c('#'.repeat(60), 'green', 'bold'));
    console.log(this._c('DISCOVERY COMPLETE', 'green', 'bold'));
    console.log(this._c('#'.repeat(60), 'green', 'bold'));
    console.log(`Total Attempted: ${data.total}`);
    console.log(`Successful: ${this._c(String(data.discovered), 'green')}`);
    console.log(`Failed: ${this._c(String(data.failed), 'red')}`);
    if (data.excluded > 0) {
      console.log(`Excluded: ${data.excluded}`);
    }
    console.log(`Duration: ${data.durationSeconds.toFixed(1)}s`);
    console.log();
  }

  _handle_crawl_cancelled() {
    console.log();
    console.log(this._c('Discovery cancelled by user', 'yellow', 'bold'));
    console.log();
  }

  _handle_depth_started(data) {
    console.log();
    console.log(this._c('='.repeat(60), 'blue'));
    console.log(this._c(
      `DEPTH ${data.depth}/${data.maxDepth}: Processing ${data.deviceCount} devices`,
      'blue', 'bold'
    ));
    console.log(this._c('='.repeat(60), 'blue'));
  }

  _handle_depth_complete(data) {
    if (this.verbose) {
      console.log(`  Depth ${data.depth} complete: ${data.discovered} discovered, ${data.failed} failed`);
    }
  }

  _handle_device_started(data) {
    if (this.verbose) {
      console.log(`${this._ts()}  Discovering: ${data.target}`);
    }
  }

  _handle_device_complete(data) {
    const status = this._c('OK', 'green', 'bold');
    const detail = `via ${data.method} (${data.neighborCount} neighbors, ${data.durationMs.toFixed(0)}ms)`;
    console.log(`${this._ts()}  ${status}: ${data.hostname} ${detail}`);
  }

  _handle_device_failed(data) {
    const status = this._c('FAILED', 'red', 'bold');
    let error = data.error || 'Unknown error';
    if (error.length > 60) error = error.slice(0, 57) + '...';
    console.log(`${this._ts()}  ${status}: ${data.target} - ${error}`);
  }

  _handle_device_excluded(data) {
    const status = this._c('EXCLUDED', 'yellow');
    console.log(`${this._ts()}  ${status}: ${data.hostname} (matches: ${data.pattern})`);
  }

  _handle_neighbor_queued(data) {
    const ipStr = data.ip && data.ip !== data.target ? ` (${data.ip})` : '';
    console.log(`${this._ts()}  ${this._c('QUEUED', 'cyan')}: ${data.target}${ipStr}`);
  }

  _handle_neighbor_skipped(data) {
    if (this.verbose) {
      console.log(`${this._ts()}  SKIPPED: ${data.target} (${data.reason})`);
    }
  }

  _handle_log_message(data) {
    const level = data.level || 'info';
    const message = data.message || '';
    const colorMap = {
      debug: ['dim'],
      info: [],
      warning: ['yellow'],
      error: ['red'],
      success: ['green'],
    };
    const colors = colorMap[level] || [];
    const prefix = this.verbose ? `[${level.toUpperCase()}]` : '';
    console.log(`${this._ts()}${prefix} ${this._c(message, ...colors)}`);
  }

  // Stats and topology updates are silent in CLI (visual in GUI)
  _handle_stats_updated() {}
  _handle_topology_updated() {}
}


// =========================================================================
// JSON Event Printer (for --json-events, outputs to stderr)
// =========================================================================

class JsonEventPrinter {
  /**
   * Print events as JSON lines to stderr.
   *
   * Usage:
   *   const printer = new JsonEventPrinter();
   *   printer.attach(emitter);
   */
  attach(emitter) {
    for (const type of Object.values(EventType)) {
      emitter.on(type, (data) => {
        const record = {
          timestamp: new Date().toISOString(),
          type,
          data,
        };
        try {
          process.stderr.write(JSON.stringify(record) + '\n');
        } catch (e) {
          // Non-serializable data — stringify it
          record.data = String(data);
          process.stderr.write(JSON.stringify(record) + '\n');
        }
      });
    }
  }
}


module.exports = {
  EventType,
  LogLevel,
  DiscoveryEmitter,
  ConsoleEventPrinter,
  JsonEventPrinter,
};
