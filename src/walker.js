/**
 * secure-cartography-js — SNMP Walker (net-snmp wrapper).
 *
 * Implements the walker contract:
 *   walker.get(oid)           → { oid, value } | null
 *   walker.getMultiple(oids)  → [value, ...] (null for missing OIDs)
 *   walker.walk(oid)          → [{ oid, value }, ...]
 *   walker.close()            → void
 *
 * Walker owns target + auth from construction. Collectors receive
 * the walker and call its methods — no target/auth threading needed.
 *
 * Each walker holds one net-snmp session (one UDP socket). Must be
 * closed in a finally block to prevent file descriptor exhaustion.
 */

'use strict';

const snmp = require('net-snmp');

// =========================================================================
// Auth helpers — map credential objects to net-snmp session config
// =========================================================================

const AUTH_PROTOCOL_MAP = {
  none: snmp.AuthProtocols.none,
  md5: snmp.AuthProtocols.md5,
  sha: snmp.AuthProtocols.sha,
  sha224: snmp.AuthProtocols.sha224,
  sha256: snmp.AuthProtocols.sha256,
  sha384: snmp.AuthProtocols.sha384,
  sha512: snmp.AuthProtocols.sha512,
};

const PRIV_PROTOCOL_MAP = {
  none: snmp.PrivProtocols.none,
  des: snmp.PrivProtocols.des,
  aes: snmp.PrivProtocols.aes,
  aes256b: snmp.PrivProtocols.aes256b,
};


class NetSnmpWalker {
  /**
   * Create a walker for a single target.
   *
   * @param {string} target - IP address or hostname
   * @param {object} auth - Credential object:
   *   v2c: { version: 2, community: 'string' }
   *   v3:  { version: 3, user: 'string', authProtocol, authKey, privProtocol, privKey }
   * @param {object} [options]
   * @param {number} [options.timeout=10000] - SNMP timeout in ms
   * @param {number} [options.retries=1] - SNMP retries
   * @param {boolean} [options.verbose=false]
   */
  constructor(target, auth, options = {}) {
    this.target = target;
    this.auth = auth;
    this.timeout = options.timeout || 10000;
    this.retries = options.retries !== undefined ? options.retries : 1;
    this.port = options.port || 161;
    this.verbose = options.verbose || false;
    this._closed = false;

    this.session = this._createSession(target, auth);
  }

  _createSession(target, auth) {
    if (auth.version === 3) {
      // SNMPv3
      const user = {
        name: auth.user || auth.username,
        level: snmp.SecurityLevel.noAuthNoPriv,
      };

      if (auth.authKey || auth.authPassword) {
        user.level = snmp.SecurityLevel.authNoPriv;
        user.authProtocol = AUTH_PROTOCOL_MAP[auth.authProtocol || 'sha'] || snmp.AuthProtocols.sha;
        user.authKey = auth.authKey || auth.authPassword;
      }

      if (auth.privKey || auth.privPassword) {
        user.level = snmp.SecurityLevel.authPriv;
        user.privProtocol = PRIV_PROTOCOL_MAP[auth.privProtocol || 'aes'] || snmp.PrivProtocols.aes;
        user.privKey = auth.privKey || auth.privPassword;
      }

      return snmp.createV3Session(target, user, {
        timeout: this.timeout,
        retries: this.retries,
        port: this.port,
      });
    }

    // SNMPv2c (default)
    return snmp.createSession(target, auth.community || 'public', {
      version: snmp.Version2c,
      timeout: this.timeout,
      retries: this.retries,
      port: this.port,
    });
  }

  /**
   * GET a single scalar OID.
   * @param {string} oid - Dotted OID string (no leading dot)
   * @returns {Promise<{oid: string, value: *}|null>}
   */
  async get(oid) {
    if (this._closed) throw new Error('Walker session is closed');

    return new Promise((resolve, reject) => {
      this.session.get([oid], (error, varbinds) => {
        if (error) return reject(error);
        if (!varbinds || varbinds.length === 0) return resolve(null);

        const vb = varbinds[0];
        if (snmp.isVarbindError(vb)) return resolve(null);

        resolve({ oid: vb.oid, value: vb.value });
      });
    });
  }

  /**
   * GET multiple scalar OIDs in one PDU.
   * @param {string[]} oids - Array of dotted OID strings
   * @returns {Promise<Array<*>>} Values in same order (null for missing)
   */
  async getMultiple(oids) {
    if (this._closed) throw new Error('Walker session is closed');

    return new Promise((resolve, reject) => {
      this.session.get(oids, (error, varbinds) => {
        if (error) return reject(error);
        if (!varbinds) return resolve(oids.map(() => null));

        const values = varbinds.map(vb => {
          if (snmp.isVarbindError(vb)) return null;
          return vb.value;
        });
        resolve(values);
      });
    });
  }

  /**
   * Walk a subtree (GETNEXT loop).
   * @param {string} oid - Base OID for subtree walk
   * @returns {Promise<Array<{oid: string, value: *}>>}
   */
  async walk(oid) {
    if (this._closed) throw new Error('Walker session is closed');

    return new Promise((resolve, reject) => {
      const results = [];

      this.session.subtree(
        oid,
        // feedCb — called multiple times with batches
        (varbinds) => {
          for (const vb of varbinds) {
            if (!snmp.isVarbindError(vb)) {
              results.push({ oid: vb.oid, value: vb.value });
            }
          }
        },
        // doneCb — called once when complete
        (error) => {
          if (error) {
            // Some devices send error on walk completion even when
            // data was returned. Resolve with collected results if
            // we got any; reject only if truly empty.
            if (results.length > 0) {
              resolve(results);
            } else {
              // Check for "end of MIB" which is normal
              const msg = error.message || String(error);
              if (msg.includes('end of MIB') || msg.includes('endOfMibView')) {
                resolve(results);
              } else {
                reject(error);
              }
            }
          } else {
            resolve(results);
          }
        }
      );
    });
  }

  /**
   * Close the SNMP session (releases UDP socket).
   * Must be called when done — net-snmp won't GC sessions.
   */
  close() {
    if (!this._closed) {
      this._closed = true;
      try {
        this.session.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}


module.exports = { NetSnmpWalker };