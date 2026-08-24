/**
 * Role storage and management for RBAC.
 * Supports both MongoDB (via Mongoose model) and file-based storage.
 */

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
  const getAuthDomain = typeof options.getAuthDomain === 'function'
    ? options.getAuthDomain
    : () => null;
  const roleRegistry = options.roleRegistry || null;
  const RoleModel = options.model || null;
  if (!options.auditLog) {
    throw new Error('createRoleStore requires options.auditLog (from the module context) — there is no fallback');
  }
  const { appendAuditEntry } = options.auditLog;

  // Mutex for file-based path only — MongoDB uses atomic operations
  const filesMutex = RoleModel ? null : (() => {
    const { Mutex } = require('async-mutex');
    return new Mutex();
  })();

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

  // ─── File-based fallback (used when no model is provided) ───

  async function readRolesFile() {
    return (await readFromStorage(ROLES_FILE)) || { version: 1, assignments: {} };
  }

  async function writeRolesFile(data) {
    await writeToStorage(ROLES_FILE, data);
  }

  // ─── Core operations ───

  async function getRoles(email) {
    if (!email) return [];
    const authDomain = await getCachedAuthDomain();
    const key = normalizeEmail(email, authDomain);
    if (!isSafeKey(key)) return [];

    if (RoleModel) {
      const doc = await RoleModel.findOne({ email: key }).lean();
      return doc ? doc.roles : [];
    }

    const data = await readRolesFile();
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

    const authDomain = await getCachedAuthDomain();
    const normalized = normalizeEmail(email, authDomain);
    if (!isSafeKey(normalized)) throw new Error('Invalid email');

    if (RoleModel) {
      const before = await RoleModel.findOne({ email: normalized }).lean();
      if (before && before.roles.includes(role)) {
        return { email: normalized, roles: before.roles };
      }

      const assignUpdate = {
        $addToSet: { roles: role },
        $set: { assignedBy: actor, assignedAt: new Date().toISOString() }
      };
      let doc;
      try {
        doc = await RoleModel.findOneAndUpdate(
          { email: normalized },
          assignUpdate,
          { upsert: true, returnDocument: 'after', lean: true }
        );
      } catch (err) {
        // Concurrent upsert race on the unique email index: another assignRole
        // inserted this email first. Surface nothing to the caller — instead
        // re-check idempotently, matching the serialized file-based path.
        if (err && err.code === 11000) {
          // If the winner already added this exact role, it's a no-op: return
          // without overwriting assignment metadata or logging a duplicate audit.
          const raced = await RoleModel.findOne({ email: normalized }).lean();
          if (raced && raced.roles.includes(role)) {
            return { email: normalized, roles: raced.roles };
          }
          // The email exists but without this role — add it (no insert -> no
          // conflict). Metadata update + audit below are correct for a new role.
          doc = await RoleModel.findOneAndUpdate(
            { email: normalized },
            assignUpdate,
            { returnDocument: 'after', lean: true }
          );
        } else {
          throw err;
        }
      }

      await appendAuditEntry({
        action: 'role.assign',
        actor,
        entityType: 'user',
        entityId: normalized,
        newValue: role,
        detail: `Assigned role "${role}" to ${normalized}`
      });

      return { email: normalized, roles: doc.roles };
    }

    // File-based path (mutex-protected)
    return filesMutex.runExclusive(async () => {
      const data = await readRolesFile();

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
        await writeRolesFile(data);

        await appendAuditEntry({
          action: 'role.assign',
          actor,
          entityType: 'user',
          entityId: normalized,
          newValue: role,
          detail: `Assigned role "${role}" to ${normalized}`
        });
      }

      return { email: normalized, roles: entry.roles };
    });
  }

  async function revokeRole(email, role, actor) {
    if (!email || !role) throw new Error('email and role are required');
    if (roleRegistry && !roleRegistry.isValid(role)) {
      throw new Error(`Invalid role: ${role}. Must be one of: ${roleRegistry.getAll().map(r => r.id).join(', ')}`);
    }

    if (DEMO_MODE) {
      return { demo: true, message: 'Demo mode -- changes are not saved' };
    }

    const authDomain = await getCachedAuthDomain();
    const normalized = normalizeEmail(email, authDomain);
    if (!isSafeKey(normalized)) throw new Error('Invalid email');

    if (RoleModel) {
      const existing = await RoleModel.findOne({ email: normalized }).lean();
      if (!existing || !existing.roles.includes(role)) {
        throw new Error(`User ${normalized} does not have role "${role}"`);
      }

      if (role === 'admin') {
        // Optimistic last-admin guard (not a single atomic op): check the admin
        // count, pull the role, then re-check. If two concurrent revocations
        // both passed the count check and drove admins to zero, the post-pull
        // re-check below rolls this one back so at least one admin always remains.
        const adminCount = await RoleModel.countDocuments({ roles: 'admin' });
        if (adminCount <= 1) {
          throw new Error('Cannot remove the last admin');
        }
        const guarded = await RoleModel.findOneAndUpdate(
          { email: normalized, roles: role },
          { $pull: { roles: role } },
          { returnDocument: 'after', lean: true }
        );
        if (!guarded) {
          // The filter no longer matched: a concurrent revoke already pulled this
          // role between our existence check and the $pull. Report the accurate
          // reason (role gone), not a spurious last-admin error.
          throw new Error(`User ${normalized} does not have role "${role}"`);
        }
        // Re-check: if we just created a zero-admin state, roll back
        const postCount = await RoleModel.countDocuments({ roles: 'admin' });
        if (postCount === 0) {
          await RoleModel.updateOne({ email: normalized }, { $addToSet: { roles: 'admin' } });
          throw new Error('Cannot remove the last admin');
        }
        if (guarded.roles.length === 0) {
          await RoleModel.deleteOne({ email: normalized });
        }

        await appendAuditEntry({
          action: 'role.revoke',
          actor,
          entityType: 'user',
          entityId: normalized,
          oldValue: role,
          detail: `Revoked role "${role}" from ${normalized}`
        });

        return { email: normalized, roles: guarded.roles };
      }

      const updated = await RoleModel.findOneAndUpdate(
        { email: normalized, roles: role },
        { $pull: { roles: role } },
        { returnDocument: 'after', lean: true }
      );

      // A concurrent revoke removed the role between our existence check and
      // this $pull, so nothing matched. Match the serialized file path, which
      // throws when the role is absent — don't log a revoke that didn't happen.
      if (!updated) {
        throw new Error(`User ${normalized} does not have role "${role}"`);
      }

      if (updated.roles.length === 0) {
        await RoleModel.deleteOne({ email: normalized });
      }

      await appendAuditEntry({
        action: 'role.revoke',
        actor,
        entityType: 'user',
        entityId: normalized,
        oldValue: role,
        detail: `Revoked role "${role}" from ${normalized}`
      });

      return { email: normalized, roles: updated.roles };
    }

    // File-based path (mutex-protected)
    return filesMutex.runExclusive(async () => {
      const data = await readRolesFile();
      const entry = Object.hasOwn(data.assignments, normalized) ? data.assignments[normalized] : null;

      if (!entry || !entry.roles.includes(role)) {
        throw new Error(`User ${normalized} does not have role "${role}"`);
      }

      if (role === 'admin') {
        const adminEmails = await getAdminEmails();
        if (adminEmails.length <= 1 && adminEmails.includes(normalized)) {
          throw new Error('Cannot remove the last admin');
        }
      }

      entry.roles = entry.roles.filter(r => r !== role);

      if (entry.roles.length === 0) {
        delete data.assignments[normalized];
      }

      await writeRolesFile(data);

      await appendAuditEntry({
        action: 'role.revoke',
        actor,
        entityType: 'user',
        entityId: normalized,
        oldValue: role,
        detail: `Revoked role "${role}" from ${normalized}`
      });

      return { email: normalized, roles: entry.roles || [] };
    });
  }

  async function listAssignments() {
    if (RoleModel) {
      const docs = await RoleModel.find().lean();
      const assignments = {};
      for (const doc of docs) {
        assignments[doc.email] = {
          roles: doc.roles,
          assignedBy: doc.assignedBy,
          assignedAt: doc.assignedAt
        };
      }
      return assignments;
    }

    const data = await readRolesFile();
    return data.assignments;
  }

  async function getAdminEmails() {
    if (RoleModel) {
      const docs = await RoleModel.find({ roles: 'admin' }, { email: 1 }).lean();
      return docs.map(d => d.email);
    }

    const data = await readRolesFile();
    return Object.entries(data.assignments)
      .filter(([, entry]) => entry.roles.includes('admin'))
      .map(([email]) => email);
  }

  async function getUsersByRole(role) {
    if (!role) return [];
    if (RoleModel) {
      const docs = await RoleModel.find({ roles: role }, { email: 1 }).lean();
      return docs.map(d => d.email);
    }

    const data = await readRolesFile();
    return Object.entries(data.assignments)
      .filter(([, entry]) => entry.roles.includes(role))
      .map(([email]) => email);
  }

  async function migrateFromAllowlist() {
    if (RoleModel) {
      const count = await RoleModel.countDocuments();
      if (count > 0) return false;

      const allowlist = await readFromStorage(ALLOWLIST_FILE);
      if (!allowlist || !allowlist.emails || allowlist.emails.length === 0) {
        return false;
      }

      const authDomain = await getCachedAuthDomain();
      const ops = [];
      for (const email of allowlist.emails) {
        const normalized = normalizeEmail(email, authDomain);
        if (!isSafeKey(normalized)) continue;
        ops.push({
          updateOne: {
            filter: { email: normalized },
            update: {
              $addToSet: { roles: 'admin' },
              $set: { assignedBy: 'migration', assignedAt: new Date().toISOString() }
            },
            upsert: true
          }
        });
      }
      if (ops.length > 0) await RoleModel.bulkWrite(ops);

      await writeToStorage(ALLOWLIST_FILE, {
        _migrated: 'roles',
        _migratedAt: new Date().toISOString(),
        emails: allowlist.emails
      });

      console.log(`Roles: migrated ${allowlist.emails.length} admin(s) from allowlist.json`);
      return true;
    }

    // File-based path (mutex-protected)
    return filesMutex.runExclusive(async () => {
      const rolesData = await readRolesFile();
      if (Object.keys(rolesData.assignments).length > 0) {
        return false;
      }

      const allowlist = await readFromStorage(ALLOWLIST_FILE);
      if (!allowlist || !allowlist.emails || allowlist.emails.length === 0) {
        return false;
      }

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
      await writeRolesFile(rolesData);

      const now = new Date().toISOString();
      await writeToStorage(ALLOWLIST_FILE, {
        _migrated: 'roles.json',
        _migratedAt: now,
        emails: allowlist.emails
      });

      console.log(`Roles: migrated ${allowlist.emails.length} admin(s) from allowlist.json to roles.json`);
      return true;
    });
  }

  async function migrateEmailDomains() {
    const authDomain = await getAuthDomain();
    if (!authDomain) return 0;

    if (RoleModel) {
      const docs = await RoleModel.find().lean();
      const needsMigration = docs.some(d => normalizeEmail(d.email, authDomain) !== d.email);
      if (!needsMigration) return 0;

      let migrated = 0;
      for (const doc of docs) {
        const newEmail = normalizeEmail(doc.email, authDomain);
        if (newEmail === doc.email) continue;

        const existing = await RoleModel.findOne({ email: newEmail }).lean();
        if (existing) {
          const mergedRoles = [...new Set([...existing.roles, ...doc.roles])];
          const update = { roles: mergedRoles };
          // Keep the newer entry's assignment metadata, matching the file path.
          if (doc.assignedAt > existing.assignedAt) {
            update.assignedBy = doc.assignedBy;
            update.assignedAt = doc.assignedAt;
          }
          await RoleModel.updateOne({ email: newEmail }, { $set: update });
        } else {
          await RoleModel.updateOne({ email: doc.email }, { $set: { email: newEmail } });
          migrated++;
          continue;
        }

        await RoleModel.deleteOne({ email: doc.email });
        migrated++;
      }

      if (migrated > 0) {
        console.log(`Roles: migrated ${migrated} email(s) to @${authDomain}`);
      }
      return migrated;
    }

    // File-based path (mutex-protected)
    return filesMutex.runExclusive(async () => {
      const data = await readRolesFile();
      const oldKeys = Object.keys(data.assignments);
      const needsMigration = oldKeys.some(email => normalizeEmail(email, authDomain) !== email);

      if (!needsMigration) return 0;

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
          const mergedRoles = [...new Set([...existingEntry.roles, ...oldEntry.roles])];
          existingEntry.roles = mergedRoles;
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
        await writeRolesFile(data);
        console.log(`Roles: migrated ${migrated} email(s) to @${authDomain} (backup: ${backupKey})`);
      }

      return migrated;
    });
  }

  return {
    getRoles,
    hasRole,
    assignRole,
    revokeRole,
    listAssignments,
    getAdminEmails,
    getUsersByRole,
    migrateFromAllowlist,
    migrateEmailDomains,
    invalidateCache
  };
}

module.exports = { createRoleStore, normalizeEmail };
