/**
 * Singleton config storage (site-config, modules-state, messages).
 * Supports both MongoDB (via Mongoose model) and file-based storage.
 *
 * Exposes the same `readFromStorage(key)` / `writeToStorage(key, value)`
 * shape as the plain storage module, so it's a drop-in replacement at call
 * sites that read/write one of these singleton config files — including
 * `module-loader.js`'s `loadModuleState`/`saveModuleState`, which accept any
 * object with that shape.
 */

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

  return {
    readFromStorage,
    writeToStorage,
    usesDatabase: !!Model
  };
}

module.exports = { createConfigStore };
