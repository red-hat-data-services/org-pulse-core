/**
 * Jira account-ID resolution cache. Supports both MongoDB (via a Mongoose
 * model) and file-based storage. See models/jira-name-map.js for the schema.
 *
 * @param {object} storage - Storage module with readFromStorage/writeToStorage
 * @param {object} [options={}] - Options
 * @param {object} [options.model] - Optional Mongoose JiraNameMapEntry model for the MongoDB path
 * @returns {object} Jira name-map store API
 */
const FILE_KEY = 'jira-name-map.json';

function createJiraNameMapStore(storage, options = {}) {
  const Model = options.model || null;

  /**
   * Read the whole cache as a plain { name: resolved } object, matching the
   * file format exactly — callers mutate this object in place during a
   * refresh, then call writeAll() once at the end.
   */
  async function readAll() {
    if (Model) {
      const docs = await Model.find({}).lean();
      const cache = {};
      for (const doc of docs) cache[doc.name] = doc.data;
      return cache;
    }
    return (await storage.readFromStorage(FILE_KEY)) || {};
  }

  /**
   * Persist the whole cache. On the MongoDB path each entry is a separate
   * upsert rather than a whole-collection replace, so it's safe to call
   * again after a partial failure without losing entries already resolved.
   */
  async function writeAll(cache) {
    if (Model) {
      for (const [name, data] of Object.entries(cache || {})) {
        await Model.updateOne({ name }, { $set: { name, data } }, { upsert: true });
      }
      return;
    }
    await storage.writeToStorage(FILE_KEY, cache || {});
  }

  /**
   * Clear the whole cache.
   */
  async function clear() {
    if (Model) {
      await Model.deleteMany({});
      return;
    }
    await storage.writeToStorage(FILE_KEY, {});
  }

  return {
    readAll,
    writeAll,
    clear,
    usesDatabase: !!Model
  };
}

module.exports = { createJiraNameMapStore };
