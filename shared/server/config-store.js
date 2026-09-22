/**
 * Singleton config storage (site config, module state, messages,
 * team-tracker config/status, and org-roster singleton blobs).
 * Supports both MongoDB (via Mongoose model) and file-based storage.
 *
 * Exposes the same `readFromStorage(key)` / `writeToStorage(key, value)`
 * shape as the plain storage module, so it's a drop-in replacement at call
 * sites that read/write one of these singleton config files — including
 * `module-loader.js`'s `loadModuleState`/`saveModuleState`, which accept any
 * object with that shape.
 */

const { getStorageMutex } = require('./storage-mutex');

/**
 * Create a config store with optional MongoDB backing.
 * @param {object} storage - Storage module with readFromStorage/writeToStorage
 * @param {object} [options={}] - Options
 * @param {object} [options.model] - Optional Mongoose Config model for the MongoDB path
 * @returns {{ readFromStorage: Function, writeToStorage: Function, usesDatabase: boolean }}
 */
function createConfigStore(storage, options = {}) {
  const Model = options.model || null;

  async function readFromStorage(key) {
    if (Model) {
      const doc = await Model.findOne({ key }).lean();
      return doc ? doc.value : null;
    }
    return storage.readFromStorage(key);
  }

  async function writeToStorage(key, value) {
    if (Model) {
      await Model.findOneAndUpdate(
        { key },
        { $set: { value } },
        { upsert: true }
      );
      return;
    }
    await storage.writeToStorage(key, value);
  }

  async function updateFromStorage(key, updater) {
    if (typeof updater !== 'function') throw new TypeError('updater must be a function');

    if (!Model) {
      return getStorageMutex(key).runExclusive(async () => {
        const current = await storage.readFromStorage(key);
        const next = updater(current);
        await storage.writeToStorage(key, next);
        return next;
      });
    }

    for (;;) {
      const current = await Model.findOne({ key }).lean();
      const next = updater(current ? current.value : null);
      if (!current) {
        try {
          await Model.create({ key, value: next, revision: 0 });
          return next;
        } catch (error) {
          if (error?.code === 11000) continue;
          throw error;
        }
      }

      const revisionFilter = current.revision == null
        ? { _id: current._id, $or: [{ revision: 0 }, { revision: { $exists: false } }] }
        : { _id: current._id, revision: current.revision };
      const result = await Model.updateOne(
        revisionFilter,
        { $set: { value: next }, $inc: { revision: 1 } }
      );
      if (result.modifiedCount === 1) return next;
    }
  }

  return {
    readFromStorage,
    writeToStorage,
    updateFromStorage,
    usesDatabase: !!Model
  };
}

module.exports = { createConfigStore };
