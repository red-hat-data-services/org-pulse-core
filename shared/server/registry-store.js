/**
 * Person registry store. Reads/writes data/team-data/registry.json.
 * Supports both MongoDB (via a Mongoose model, see models/registry-entry.js)
 * and file-based storage.
 *
 * One document per person, uid-keyed, plus a sentinel document at
 * uid: '__meta__' for the registry's top-level `meta` object (generatedAt,
 * provider, orgRoots, vp). readRegistry() assembles both shapes back into
 * the same { meta, people } object the file path has always returned, so
 * callers that only read the registry need no changes beyond swapping the
 * storage call for this store.
 *
 * Write API is split by shape of the caller's intent:
 *   - upsertPerson/deletePerson: targeted, single-person operations. Safe
 *     for concurrent callers touching different people — each person lives
 *     in its own document on the MongoDB path.
 *   - writeRegistry: whole-registry replace. Reserved for genuine full-roster
 *     rebuilds (consolidated-sync). On MongoDB this is translated into one
 *     bulkWrite of per-person upserts plus deletes for uids that disappeared
 *     — every operation is idempotent, so it is safe to re-run after a
 *     partial failure, and it never does a destructive collection-wide
 *     delete before writing the replacements. Do not call this for a write
 *     that only intends to touch a handful of people; use upsertPerson in a
 *     loop instead, or two concurrent callers computing a full snapshot from
 *     a stale read will clobber each other exactly like a whole-blob file
 *     write would.
 *
 * @param {object} storage - Storage module with readFromStorage/writeToStorage
 * @param {object} [options={}] - Options
 * @param {object} [options.model] - Optional Mongoose RegistryEntry model for the MongoDB path
 * @returns {object} Registry store API
 */
const { getStorageMutex } = require('./storage-mutex');

const REGISTRY_KEY = 'team-data/registry.json';
const META_UID = '__meta__';

/** Guard against prototype pollution and the reserved meta sentinel via user-controlled uids. */
function isSafeUid(uid) {
  return typeof uid === 'string' && uid.length > 0 &&
    !['__proto__', 'constructor', 'prototype', META_UID].includes(uid);
}

function createRegistryStore(storage, options = {}) {
  const Model = options.model || null;

  async function readRegistryFile() {
    return (await storage.readFromStorage(REGISTRY_KEY)) || { meta: null, people: {} };
  }

  async function writeRegistryFile(data) {
    await storage.writeToStorage(REGISTRY_KEY, data);
  }

  /**
   * Read the full registry. On the file path this returns exactly what
   * storage.readFromStorage returns — including null when the file is
   * missing — matching every pre-existing call site's raw storage call
   * byte-for-byte. On the MongoDB path there is no "file missing" concept,
   * so an empty/never-synced registry comes back as { meta: null, people: {} }
   * rather than null; callers already null-check with `|| {}`-style guards
   * on `.people`, so this is compatible.
   */
  async function readRegistry() {
    if (Model) {
      const docs = await Model.find({}).lean();
      const people = {};
      let meta = null;
      for (const doc of docs) {
        if (doc.uid === META_UID) meta = doc.data;
        else people[doc.uid] = doc.data;
      }
      return { meta, people };
    }
    return storage.readFromStorage(REGISTRY_KEY);
  }

  /**
   * Read a single person's record by uid, or null if not found.
   */
  async function getPerson(uid) {
    if (!isSafeUid(uid)) return null;
    if (Model) {
      const doc = await Model.findOne({ uid }).lean();
      return doc ? doc.data : null;
    }
    const registry = await readRegistryFile();
    return (registry.people && registry.people[uid]) || null;
  }

  /**
   * Create or fully replace one person's record. The caller is expected to
   * pass the complete desired person object (as every existing call site
   * already builds when mutating a registry entry in memory).
   */
  async function upsertPerson(uid, person) {
    if (!isSafeUid(uid)) throw new Error(`Invalid person UID: ${uid}`);
    if (Model) {
      await Model.updateOne({ uid }, { $set: { uid, data: person } }, { upsert: true });
      return person;
    }
    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await readRegistryFile();
      if (!registry.people) registry.people = {};
      registry.people[uid] = person;
      await writeRegistryFile(registry);
      return person;
    });
  }

  /** Atomically update selected custom fields without replacing the person document. */
  async function updatePersonFields(uid, fieldValues) {
    if (!isSafeUid(uid)) throw new Error(`Invalid person UID: ${uid}`);
    if (Model) {
      const $set = {};
      for (const [fieldId, value] of Object.entries(fieldValues)) {
        if (!isSafeUid(fieldId) || fieldId.includes('.') || fieldId.startsWith('$')) {
          throw new Error(`Invalid field key: ${fieldId}`);
        }
        $set[`data._appFields.${fieldId}`] = value;
      }
      if (Object.keys($set).length === 0) {
        const person = await getPerson(uid);
        return person ? { before: person, fields: person._appFields || {} } : null;
      }
      const before = await Model.findOneAndUpdate(
        { uid },
        { $set },
        { returnDocument: 'before', lean: true }
      );
      if (!before) return null;
      return {
        before: before.data,
        fields: { ...(before.data._appFields || {}), ...fieldValues }
      };
    }

    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await readRegistryFile();
      const person = registry.people && registry.people[uid];
      if (!person) return null;
      const before = structuredClone(person);
      person._appFields = { ...(person._appFields || {}), ...fieldValues };
      await writeRegistryFile(registry);
      return { before, fields: person._appFields };
    });
  }

  /** Atomically remove selected custom fields. */
  async function deletePersonFields(uid, fieldIds) {
    if (!isSafeUid(uid)) throw new Error(`Invalid person UID: ${uid}`);
    if (Model) {
      const $unset = {};
      for (const fieldId of fieldIds) {
        if (!isSafeUid(fieldId) || fieldId.includes('.') || fieldId.startsWith('$')) {
          throw new Error(`Invalid field key: ${fieldId}`);
        }
        $unset[`data._appFields.${fieldId}`] = '';
      }
      if (Object.keys($unset).length === 0) return getPerson(uid);
      const doc = await Model.findOneAndUpdate({ uid }, { $unset }, { returnDocument: 'after', lean: true });
      return doc ? doc.data : null;
    }
    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await readRegistryFile();
      const person = registry.people && registry.people[uid];
      if (!person) return null;
      for (const fieldId of fieldIds) delete person._appFields?.[fieldId];
      await writeRegistryFile(registry);
      return person;
    });
  }

  /** Atomically add a team membership. */
  async function addTeamToPerson(uid, teamId) {
    if (!isSafeUid(uid)) throw new Error(`Invalid person UID: ${uid}`);
    if (Model) {
      const before = await Model.findOneAndUpdate(
        { uid, 'data.teamIds': { $ne: teamId } },
        { $addToSet: { 'data.teamIds': teamId } },
        { returnDocument: 'before', lean: true }
      );
      if (before) return { changed: true, person: before.data };
      return { changed: false, person: await getPerson(uid) };
    }

    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await readRegistryFile();
      const person = registry.people && registry.people[uid];
      if (!person) return { changed: false, person: null };
      if (!Array.isArray(person.teamIds)) person.teamIds = [];
      if (person.teamIds.includes(teamId)) return { changed: false, person };
      const before = structuredClone(person);
      person.teamIds.push(teamId);
      await writeRegistryFile(registry);
      return { changed: true, person: before };
    });
  }

  /** Atomically remove a team membership. */
  async function removeTeamFromPerson(uid, teamId) {
    if (!isSafeUid(uid)) throw new Error(`Invalid person UID: ${uid}`);
    if (Model) {
      const before = await Model.findOneAndUpdate(
        { uid, 'data.teamIds': teamId },
        { $pull: { 'data.teamIds': teamId } },
        { returnDocument: 'before', lean: true }
      );
      if (before) return { changed: true, person: before.data };
      return { changed: false, person: await getPerson(uid) };
    }

    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await readRegistryFile();
      const person = registry.people && registry.people[uid];
      if (!person || !Array.isArray(person.teamIds) || !person.teamIds.includes(teamId)) {
        return { changed: false, person: person || null };
      }
      const before = structuredClone(person);
      person.teamIds = person.teamIds.filter(id => id !== teamId);
      await writeRegistryFile(registry);
      return { changed: true, person: before };
    });
  }

  /** Remove a team membership from every person without replacing any person document. */
  async function removeTeamFromAllPeople(teamId) {
    if (Model) {
      const result = await Model.updateMany(
        { uid: { $ne: META_UID }, 'data.teamIds': teamId },
        { $pull: { 'data.teamIds': teamId } }
      );
      return result.modifiedCount || 0;
    }

    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await readRegistryFile();
      let changed = 0;
      for (const person of Object.values(registry.people || {})) {
        if (Array.isArray(person.teamIds) && person.teamIds.includes(teamId)) {
          person.teamIds = person.teamIds.filter(id => id !== teamId);
          changed++;
        }
      }
      if (changed) await writeRegistryFile(registry);
      return changed;
    });
  }

  /**
   * Permanently remove one person's record. No-op (returns false) if absent.
   */
  async function deletePerson(uid) {
    if (!isSafeUid(uid)) return false;
    if (Model) {
      const { deletedCount } = await Model.deleteOne({ uid });
      return deletedCount > 0;
    }
    const mutex = getStorageMutex(REGISTRY_KEY);
    return mutex.runExclusive(async () => {
      const registry = await readRegistryFile();
      if (!registry.people || !Object.prototype.hasOwnProperty.call(registry.people, uid)) {
        return false;
      }
      delete registry.people[uid];
      await writeRegistryFile(registry);
      return true;
    });
  }

  /**
   * Replace the entire registry (meta + all people). See the module doc
   * comment above for when this is (and isn't) the right primitive.
   */
  async function writeRegistry(data) {
    const people = (data && data.people) || {};
    const meta = (data && data.meta) || null;

    if (Model) {
      const existingUids = (await Model.find({}, { uid: 1 }).lean()).map(d => d.uid);
      const nextUids = new Set(Object.keys(people));
      nextUids.add(META_UID);

      const ops = [];
      for (const [uid, person] of Object.entries(people)) {
        ops.push({
          updateOne: {
            filter: { uid },
            update: { $set: { uid, data: person } },
            upsert: true
          }
        });
      }
      ops.push({
        updateOne: {
          filter: { uid: META_UID },
          update: { $set: { uid: META_UID, data: meta } },
          upsert: true
        }
      });
      for (const uid of existingUids) {
        if (!nextUids.has(uid)) {
          ops.push({ deleteOne: { filter: { uid } } });
        }
      }
      if (ops.length > 0) {
        await Model.bulkWrite(ops, { ordered: false });
      }
      return;
    }

    return writeRegistryFile(data);
  }

  return {
    readRegistry,
    getPerson,
    upsertPerson,
    updatePersonFields,
    deletePersonFields,
    addTeamToPerson,
    removeTeamFromPerson,
    removeTeamFromAllPeople,
    deletePerson,
    writeRegistry,
    usesDatabase: !!Model
  };
}

module.exports = {
  createRegistryStore,
  REGISTRY_KEY
};
