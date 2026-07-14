/**
 * Role storage and management for RBAC.
 * Manages roles.json with admin and team-admin role assignments.
 */

const auditLog = require('./audit-log');

const ROLES_FILE = 'roles.json';
const ALLOWLIST_FILE = 'allowlist.json';
const DEMO_MODE = process.env.DEMO_MODE === 'true';

/** Guard against prototype pollution via user-controlled object keys. */
function isSafeKey(key) {
  return typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key);
}

/**
 * Normalize an email to the configured auth domain.
 * If authDomain is set, replaces the domain portion of the email.
 * Exported for testing.
 */
function normalizeEmail(email, authDomain) {
  if (!email || !authDomain) return email ? email.trim().toLowerCase() : email;
  const normalized = email.trim().toLowerCase();
  const atIdx = normalized.indexOf('@');
  if (atIdx < 0) return normalized;
  return normalized.substring(0, atIdx + 1) + authDomain;
}

function createRoleStore(readFromStorage, writeToStorage, options = {}) {
  const { Mutex } = require('async-mutex');
  const rolesMutex = new Mutex();

  const getAuthDomain = typeof options.getAuthDomain === 'function'
    ? options.getAuthDomain
    : () => null;
  const roleRegistry = options.roleRegistry || null;

  // Cache for getAuthDomain result (30s TTL)
  let _cachedDomain = undefined;
  let _cachedAt = 0;
  const CACHE_TTL_MS = 30_000;

  async function getCachedAuthDomain() {
    const now = Date.now();
    if (_cachedDomain === undefined || now - _cachedAt > CACHE_TTL_MS) {
      _cachedDomain = (await getAuthDomain()) || null;
      _cachedAt = now;
    }
    return _cachedDomain;
  }

  function invalidateCache() {
    _cachedDomain = undefined;
    _cachedAt = 0;
  }

  async function readRoles() {
    return (await readFromStorage(ROLES_FILE)) || { version: 1, assignments: {} };
  }

  async function writeRoles(data) {
    await writeToStorage(ROLES_FILE, data);
  }

  async function getRoles(email) {
    if (!email) return [];
    const authDomain = await getCachedAuthDomain();
    const key = normalizeEmail(email, authDomain);
    if (!isSafeKey(key)) return [];
    const data = await readRoles();
    const entry = data.assignments[key];
    return entry ? entry.roles : [];
  }

  async function hasRole(email, role) {
    return (await getRoles(email)).includes(role);
  }

  async function assignRole(email, role, actor) {
    if (!email || !role) throw new Error('email and role are required');
    if (roleRegistry && !roleRegistry.isValid(role)) {
      throw new Error(`Invalid role: ${role}. Must be one of: ${roleRegistry.getAll().map(r => r.id).join(', ')}`);
    }

    if (DEMO_MODE) {
      return { demo: true, message: 'Demo mode -- changes are not saved' };
    }

    const release = await rolesMutex.acquire();
    try {
      const authDomain = await getCachedAuthDomain();
      const normalized = normalizeEmail(email, authDomain);
      if (!isSafeKey(normalized)) throw new Error('Invalid email');
      const data = await readRoles();

      if (!Object.hasOwn(data.assignments, normalized)) {
        data.assignments[normalized] = {
          roles: [],
          assignedBy: actor,
          assignedAt: new Date().toISOString()
        };
      }

      const entry = data.assignments[normalized];
      if (!entry.roles.includes(role)) {
        entry.roles.push(role);
        entry.assignedBy = actor;
        entry.assignedAt = new Date().toISOString();
        await writeRoles(data);

        await auditLog.appendAuditEntry({ readFromStorage, writeToStorage }, {
          action: 'role.assign',
          actor,
          entityType: 'user',
          entityId: normalized,
          newValue: role,
          detail: `Assigned role "${role}" to ${normalized}`
        });
      }

      return { email: normalized, roles: entry.roles };
    } finally {
      release();
    }
  }

  async function revokeRole(email, role, actor) {
    if (!email || !role) throw new Error('email and role are required');
    if (roleRegistry && !roleRegistry.isValid(role)) {
      throw new Error(`Invalid role: ${role}. Must be one of: ${roleRegistry.getAll().map(r => r.id).join(', ')}`);
    }

    if (DEMO_MODE) {
      return { demo: true, message: 'Demo mode -- changes are not saved' };
    }

    const release = await rolesMutex.acquire();
    try {
      const authDomain = await getCachedAuthDomain();
      const normalized = normalizeEmail(email, authDomain);
      if (!isSafeKey(normalized)) throw new Error('Invalid email');
      const data = await readRoles();
      const entry = Object.hasOwn(data.assignments, normalized) ? data.assignments[normalized] : null;

      if (!entry || !entry.roles.includes(role)) {
        throw new Error(`User ${normalized} does not have role "${role}"`);
      }

      // Guard: cannot remove the last admin
      if (role === 'admin') {
        const adminEmails = await getAdminEmails();
        if (adminEmails.length <= 1 && adminEmails.includes(normalized)) {
          throw new Error('Cannot remove the last admin');
        }
      }

      entry.roles = entry.roles.filter(r => r !== role);

      // Clean up entry if no roles remain
      if (entry.roles.length === 0) {
        delete data.assignments[normalized];
      }

      await writeRoles(data);

      await auditLog.appendAuditEntry({ readFromStorage, writeToStorage }, {
        action: 'role.revoke',
        actor,
        entityType: 'user',
        entityId: normalized,
        oldValue: role,
        detail: `Revoked role "${role}" from ${normalized}`
      });

      return { email: normalized, roles: entry.roles || [] };
    } finally {
      release();
    }
  }

  async function listAssignments() {
    const data = await readRoles();
    return data.assignments;
  }

  async function getAdminEmails() {
    const data = await readRoles();
    return Object.entries(data.assignments)
      .filter(([, entry]) => entry.roles.includes('admin'))
      .map(([email]) => email);
  }

  async function migrateFromAllowlist() {
    const release = await rolesMutex.acquire();
    try {
      const rolesData = await readRoles();
      if (Object.keys(rolesData.assignments).length > 0) {
        return false; // Already has data, skip migration
      }

      const allowlist = await readFromStorage(ALLOWLIST_FILE);
      if (!allowlist || !allowlist.emails || allowlist.emails.length === 0) {
        return false; // Nothing to migrate
      }

      // Inline the role assignment logic to avoid deadlock with assignRole's mutex
      const authDomain = await getCachedAuthDomain();
      for (const email of allowlist.emails) {
        const normalized = normalizeEmail(email, authDomain);
        if (!isSafeKey(normalized)) continue;

        if (!Object.hasOwn(rolesData.assignments, normalized)) {
          rolesData.assignments[normalized] = {
            roles: [],
            assignedBy: 'migration',
            assignedAt: new Date().toISOString()
          };
        }
        const entry = rolesData.assignments[normalized];
        if (!entry.roles.includes('admin')) {
          entry.roles.push('admin');
          entry.assignedBy = 'migration';
          entry.assignedAt = new Date().toISOString();
        }
      }
      await writeRoles(rolesData);

      // Mark allowlist as migrated
      const now = new Date().toISOString();
      await writeToStorage(ALLOWLIST_FILE, {
        _migrated: 'roles.json',
        _migratedAt: now,
        emails: allowlist.emails
      });

      console.log(`Roles: migrated ${allowlist.emails.length} admin(s) from allowlist.json to roles.json`);
      return true;
    } finally {
      release();
    }
  }

  async function migrateEmailDomains() {
    const authDomain = await getAuthDomain();
    if (!authDomain) return 0;

    const release = await rolesMutex.acquire();
    try {
      const data = await readRoles();
      const oldKeys = Object.keys(data.assignments);
      const needsMigration = oldKeys.some(email => normalizeEmail(email, authDomain) !== email);

      if (!needsMigration) return 0;

      // Backup before migration
      const backupKey = `roles-backup-${Date.now()}.json`;
      await writeToStorage(backupKey, JSON.parse(JSON.stringify(data)));
      console.log(`Roles: backup saved to ${backupKey}`);

      let migrated = 0;

      for (const oldEmail of oldKeys) {
        const newEmail = normalizeEmail(oldEmail, authDomain);
        if (newEmail === oldEmail) continue;

        const oldEntry = data.assignments[oldEmail];
        const existingEntry = data.assignments[newEmail];

        if (existingEntry) {
          // Merge roles from both entries
          const mergedRoles = [...new Set([...existingEntry.roles, ...oldEntry.roles])];
          existingEntry.roles = mergedRoles;
          // Keep the newer assignedAt
          if (oldEntry.assignedAt > existingEntry.assignedAt) {
            existingEntry.assignedBy = oldEntry.assignedBy;
            existingEntry.assignedAt = oldEntry.assignedAt;
          }
        } else {
          data.assignments[newEmail] = oldEntry;
        }

        delete data.assignments[oldEmail];
        migrated++;
      }

      if (migrated > 0) {
        await writeRoles(data);
        console.log(`Roles: migrated ${migrated} email(s) to @${authDomain} (backup: ${backupKey})`);
      }

      return migrated;
    } finally {
      release();
    }
  }

  return {
    getRoles,
    hasRole,
    assignRole,
    revokeRole,
    listAssignments,
    getAdminEmails,
    migrateFromAllowlist,
    migrateEmailDomains,
    invalidateCache
  };
}

module.exports = { createRoleStore, normalizeEmail };
