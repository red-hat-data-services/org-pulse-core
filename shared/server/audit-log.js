/**
 * Audit log for team structure management.
 * Append-only JSON storage, capped at maxEntries.
 */

const crypto = require('crypto');
const { Mutex } = require('async-mutex');

const AUDIT_LOG_KEY = 'audit-log.json';
const DEFAULT_MAX_ENTRIES = 10000;

// Deliberately module-scoped, not created inside createAuditLog(). This is a
// single lock shared by every audit log instance in the process. Moving it
// inside the factory would give each instance its own lock, letting two
// instances (e.g. two createAuditLog() calls over the same storage) write
// concurrently and silently weakening the write coordination that guards
// the read-modify-write of the capped entries array.
const auditMutex = new Mutex();

function generateId() {
  return 'evt_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Escape regex metacharacters so a user-supplied substring filter is matched
 * literally. Without this, an `actor` filter containing regex syntax would
 * either change the query's meaning or (with something like `(a+)+$`) be a
 * denial-of-service vector against the database.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the full entry object from a raw entry, applying the same id
 * generation, timestamping, and `|| null` / `!== undefined` defaulting on
 * both the file and database paths, so they return identically shaped
 * objects.
 */
function buildFullEntry(entry) {
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    entityLabel: entry.entityLabel || null,
    field: entry.field || null,
    oldValue: entry.oldValue !== undefined ? entry.oldValue : null,
    newValue: entry.newValue !== undefined ? entry.newValue : null,
    detail: entry.detail || null
  };
}

// Map a Mongo document to the file-shaped entry object (no _id, no __v).
function toEntryShape(doc) {
  return {
    id: doc.id,
    timestamp: doc.timestamp,
    actor: doc.actor,
    action: doc.action,
    entityType: doc.entityType,
    entityId: doc.entityId,
    entityLabel: doc.entityLabel == null ? null : doc.entityLabel,
    field: doc.field == null ? null : doc.field,
    oldValue: doc.oldValue !== undefined ? doc.oldValue : null,
    newValue: doc.newValue !== undefined ? doc.newValue : null,
    detail: doc.detail == null ? null : doc.detail
  };
}

/**
 * Create an audit log instance bound to a storage backend.
 * @param {object} storage - Storage module with readFromStorage/writeToStorage
 * @param {object} [options={}] - Options
 * @param {object} [options.model] - Optional Mongoose AuditEntry model for the MongoDB path
 * @returns {{ appendAuditEntry: Function, queryAuditLog: Function, usesDatabase: boolean }}
 */
function createAuditLog(storage, options = {}) {
  const Model = options.model || null;
  // Configurable per-deployment on the database path too, mirroring the file
  // path's `log.maxEntries`. Also lets tests exercise the cap without
  // inserting DEFAULT_MAX_ENTRIES documents.
  const dbMaxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;

  /**
   * Append an audit entry.
   * @param {{ action: string, actor: string, entityType: string, entityId: string, entityLabel?: string, field?: string, oldValue?: *, newValue?: *, detail?: string }} entry
   */
  async function appendAuditEntry(entry) {
    if (Model) {
      // No mutex here: an insert is atomic, unlike the file path's
      // read-modify-write of the whole entries array. Taking the
      // module-scoped mutex would serialize every audit write across the
      // process for no reason.
      const fullEntry = buildFullEntry(entry);
      await Model.create(fullEntry);

      // Enforce the cap with an idempotent boundary delete rather than
      // count-then-delete. The old approach (countDocuments, then find the
      // oldest `excess` docs and deleteMany them) over-deletes under
      // concurrency: two appends racing at the cap can each count the same
      // over-cap total, then run their `find` at different times and each
      // delete a different oldest slice, so more documents get dropped than
      // were inserted. Reachable whenever two writers overlap at the cap —
      // e.g. a migration loop writing in quick succession alongside normal
      // admin traffic.
      //
      // Instead, find the document at the cap boundary (the dbMaxEntries-th
      // newest, using the exact same sort/tiebreak queryAuditLog uses) and
      // delete everything strictly older than it. Two concurrent appends
      // compute the same boundary and delete the same set, so running this
      // twice is safe — that's the property the old code lacked.
      //
      // Cost: one indexed find with a skip (the skip walks the compound
      // { timestamp: -1, _id: -1 } index declared on the model, so it's an
      // index walk rather than a collection scan) plus, only when over cap,
      // a deleteMany matched by that same index. No count of the whole
      // collection is needed. If this ever shows up in profiling, the
      // obvious lever is running the trim only every Nth append rather than
      // on every write.
      //
      // The trim runs in its own try/catch: by this point Model.create()
      // above has already succeeded and the caller's own write (in
      // team-store.js etc.) is already durable, so a trim failure loses
      // nothing except a temporarily-uncapped collection. It must never
      // surface as a failed request — that would tell the caller its
      // already-committed action failed, inviting a retry that duplicates
      // it. This mirrors the treatment the secrets.update route gives its
      // own audit-append failure in server/routes/admin.js. Deliberately
      // NOT extended to wrap Model.create() itself: if the insert fails,
      // that's the same failure shape the file path already had (a failed
      // writeToStorage also threw and propagated), so swallowing it here
      // would be a behaviour change relative to the file path, not a fix.
      // Leave that asymmetry alone.
      try {
        const boundary = await Model.find({}, { timestamp: 1, _id: 1 })
          .sort({ timestamp: -1, _id: -1 })
          .skip(dbMaxEntries - 1)
          .limit(1)
          .lean();

        if (boundary.length > 0) {
          const b = boundary[0];
          await Model.deleteMany({
            $or: [
              { timestamp: { $lt: b.timestamp } },
              { timestamp: b.timestamp, _id: { $lt: b._id } }
            ]
          });
        }
      } catch (trimErr) {
        console.error('Failed to trim audit log to cap:', trimErr);
      }

      return fullEntry;
    }

    const release = await auditMutex.acquire();
    try {
      const log = (await storage.readFromStorage(AUDIT_LOG_KEY)) || { entries: [], maxEntries: DEFAULT_MAX_ENTRIES };
      const maxEntries = log.maxEntries || DEFAULT_MAX_ENTRIES;

      const fullEntry = buildFullEntry(entry);

      log.entries.unshift(fullEntry);

      // Enforce cap
      if (log.entries.length > maxEntries) {
        log.entries = log.entries.slice(0, maxEntries);
      }

      await storage.writeToStorage(AUDIT_LOG_KEY, log);
      return fullEntry;
    } finally {
      release();
    }
  }

  /**
   * Query audit log with filters and pagination.
   * @param {{ from?: string, to?: string, action?: string, actor?: string, entityId?: string, limit?: number, offset?: number }} filters
   * @returns {{ entries: object[], total: number }}
   */
  async function queryAuditLog(filters = {}) {
    const offset = filters.offset || 0;
    const limit = filters.limit || 50;

    if (Model) {
      // Express parses a repeated query param (`?action=a&action=b`) into an
      // array, and `?from[a]=1` into an object; `req.query.*` is passed
      // straight through from the route with no type check. The file path
      // tolerates all of that for free — `===` against an array is always
      // false, and the `>=` / `<=` string comparisons coerce — so it just
      // filters or returns nothing. The MongoDB path would instead hand
      // Mongoose a non-string against a String-typed path and get a
      // CastError, i.e. an unhandled 500 where the file path returns rows.
      // Every filter below therefore has to be defended, not just some.

      // MATCH_NOTHING is `$in: []`, which matches no document unconditionally.
      // Deliberately not `$exists: false`: that only matches nothing while
      // every document carries the field, which is true of documents this
      // code writes but not guaranteed of documents the future data migration
      // will bulk-import from audit-log.json. If one lacked the field, an
      // array-valued filter would silently return rows that do not match it —
      // worse than the CastError this replaced.
      const MATCH_NOTHING = { $in: [] };

      const query = {};
      if (filters.from || filters.to) {
        // The range is a lexicographic comparison on ISO strings. A non-string
        // bound cannot be compared meaningfully, and on the file path such a
        // filter matches nothing useful, so treat it as matching nothing here.
        if ((filters.from && typeof filters.from !== 'string') ||
            (filters.to && typeof filters.to !== 'string')) {
          query.timestamp = MATCH_NOTHING;
        } else {
          query.timestamp = {};
          if (filters.from) query.timestamp.$gte = filters.from;
          if (filters.to) query.timestamp.$lte = filters.to;
        }
      }
      if (filters.action) {
        query.action = typeof filters.action === 'string' ? filters.action : MATCH_NOTHING;
      }
      if (filters.entityId) {
        query.entityId = typeof filters.entityId === 'string' ? filters.entityId : MATCH_NOTHING;
      }
      if (filters.actor) {
        // Substring match, matching the file path's `e.actor.includes(...)`.
        // String.prototype.includes coerces its argument with String(...),
        // so an array like ['a','b'] becomes the literal string 'a,b' and is
        // matched (or not) as that string rather than throwing. Mirror that
        // coercion before escaping, rather than assuming a string, so the
        // MongoDB path agrees with the file path instead of calling
        // .replace on an array and throwing a TypeError.
        query.actor = new RegExp(escapeRegex(String(filters.actor)));
      }

      const total = await Model.countDocuments(query);
      // Sort newest-first by timestamp, matching the file path's unshift
      // ordering. Timestamps are ISO strings with millisecond precision, so
      // two entries written in the same millisecond can tie (this happens in
      // practice — migration code paths write several entries in quick
      // succession) — tiebreak on _id descending, since ObjectIds are
      // monotonically increasing, to keep ordering stable and matching
      // insertion order.
      const docs = await Model.find(query)
        .sort({ timestamp: -1, _id: -1 })
        .skip(offset)
        .limit(limit)
        .lean();

      return { entries: docs.map(toEntryShape), total };
    }

    const log = (await storage.readFromStorage(AUDIT_LOG_KEY)) || { entries: [] };
    let entries = log.entries;

    if (filters.from) {
      entries = entries.filter(e => e.timestamp >= filters.from);
    }
    if (filters.to) {
      entries = entries.filter(e => e.timestamp <= filters.to);
    }
    if (filters.action) {
      entries = entries.filter(e => e.action === filters.action);
    }
    if (filters.actor) {
      entries = entries.filter(e => e.actor.includes(filters.actor));
    }
    if (filters.entityId) {
      entries = entries.filter(e => e.entityId === filters.entityId);
    }

    const total = entries.length;
    entries = entries.slice(offset, offset + limit);

    return { entries, total };
  }

  return {
    appendAuditEntry,
    queryAuditLog,
    usesDatabase: !!Model
  };
}

module.exports = {
  createAuditLog,
  AUDIT_LOG_KEY
};
