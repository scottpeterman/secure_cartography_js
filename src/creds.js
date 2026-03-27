/**
 * secure-cartography-js — Credential Provider.
 *
 * Thin abstraction over credential storage. Duck-typed interface —
 * any object with getSnmpCredentials() and getSshCredentials() works.
 *
 * Credential types:
 *   SNMPv2c: { version: 2, community: 'string', name: 'label' }
 *   SNMPv3:  { version: 3, username, authProtocol, authPassword, privProtocol, privPassword, name }
 *   SSH:     { username, password, keyContent?, keyPassphrase?, timeout? }
 *
 * Ported from map_pioneer creds/provider.py.
 */

'use strict';

// =========================================================================
// Credential Shapes (documentation — JS uses duck typing)
// =========================================================================

/**
 * Build an SNMPv2c credential object.
 * @param {string} community - Community string
 * @param {string} [name] - Label for this credential
 * @returns {object}
 */
function snmpV2cCredential(community, name) {
  return {
    name: name || `v2c-${community}`,
    version: 2,
    community,
  };
}

/**
 * Build an SNMPv3 credential object.
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} [opts.authProtocol='sha'] - none|md5|sha|sha224|sha256|sha384|sha512
 * @param {string} [opts.authPassword='']
 * @param {string} [opts.privProtocol='aes'] - none|des|aes|aes192|aes256
 * @param {string} [opts.privPassword='']
 * @param {string} [opts.name]
 * @returns {object}
 */
function snmpV3Credential(opts) {
  return {
    name: opts.name || `v3-${opts.username}`,
    version: 3,
    username: opts.username,
    authProtocol: opts.authProtocol || 'sha',
    authPassword: opts.authPassword || '',
    privProtocol: opts.privProtocol || 'aes',
    privPassword: opts.privPassword || '',
  };
}

/**
 * Build an SSH credential object.
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} [opts.password='']
 * @param {string} [opts.keyContent] - Private key content
 * @param {string} [opts.keyPassphrase]
 * @param {number} [opts.timeout=30]
 * @param {string} [opts.name]
 * @returns {object}
 */
function sshCredential(opts) {
  return {
    name: opts.name || `ssh-${opts.username}`,
    username: opts.username,
    password: opts.password || '',
    keyContent: opts.keyContent || null,
    keyPassphrase: opts.keyPassphrase || null,
    timeout: opts.timeout || 30,
  };
}


// =========================================================================
// Credential Providers
// =========================================================================

/**
 * Simple credential provider — hardcoded credentials for testing.
 *
 * Satisfies the CredentialProvider duck type:
 *   getSnmpCredentials() → Array
 *   getSshCredentials()  → Array
 */
class SimpleCreds {
  constructor(snmpCreds = [], sshCreds = []) {
    this._snmp = snmpCreds;
    this._ssh = sshCreds;
  }

  getSnmpCredentials() {
    return this._snmp;
  }

  getSshCredentials() {
    return this._ssh;
  }
}


/**
 * Build a credential provider from CLI arguments.
 *
 * Supports:
 *   communities:  Array of v2c community strings
 *   v3User:       SNMPv3 username (triggers v3 mode)
 *   v3AuthPass:   SNMPv3 auth password
 *   v3PrivPass:   SNMPv3 priv password
 *   v3AuthProto:  SNMPv3 auth protocol
 *   v3PrivProto:  SNMPv3 priv protocol
 *   sshUser:      SSH username
 *   sshPass:      SSH password
 *
 * @param {object} opts - Parsed CLI options
 * @returns {SimpleCreds}
 */
function buildCredsFromArgs(opts) {
  const snmpCreds = [];
  const sshCreds = [];

  // SNMPv2c community strings
  const communities = opts.community || [];
  for (const comm of communities) {
    snmpCreds.push(snmpV2cCredential(comm));
  }

  // SNMPv3
  if (opts.v3User) {
    snmpCreds.push(snmpV3Credential({
      username: opts.v3User,
      authProtocol: opts.v3AuthProto || 'sha',
      authPassword: opts.v3AuthPass || '',
      privProtocol: opts.v3PrivProto || 'aes',
      privPassword: opts.v3PrivPass || '',
    }));
  }

  // Default: public
  if (snmpCreds.length === 0) {
    snmpCreds.push(snmpV2cCredential('public'));
  }

  // SSH
  if (opts.sshUser) {
    sshCreds.push(sshCredential({
      username: opts.sshUser,
      password: opts.sshPass || '',
    }));
  }

  return new SimpleCreds(snmpCreds, sshCreds);
}


/**
 * Convert a credential object to the auth shape expected by NetSnmpWalker.
 *
 * @param {object} cred - SNMPv2c or SNMPv3 credential
 * @returns {object} Auth object for walker constructor
 */
function credToWalkerAuth(cred) {
  if (cred.version === 3) {
    return {
      version: 3,
      user: cred.username,
      authProtocol: cred.authProtocol || 'sha',
      authKey: cred.authPassword || '',
      privProtocol: cred.privProtocol || 'aes',
      privKey: cred.privPassword || '',
    };
  }

  // v2c
  return {
    version: 2,
    community: cred.community || 'public',
  };
}


module.exports = {
  snmpV2cCredential,
  snmpV3Credential,
  sshCredential,
  SimpleCreds,
  buildCredsFromArgs,
  credToWalkerAuth,
};
