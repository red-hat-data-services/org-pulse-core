/**
 * Per-person Jira metrics cache. Supports both MongoDB (via a Mongoose
 * model) and file-based storage. See models/person.js for the schema and
 * the reasoning behind storing the metrics blob as-is.
 *
 * @param {object} storage - Storage module with readFromStorage/writeToStorage/listStorageFiles
 * @param {object} [options={}] - Options
 * @param {object} [options.model] - Optional Mongoose PersonMetrics model for the MongoDB path
 * @returns {object} Person store API
 */
function createPersonStore(storage, options = {}) {
  const Model = options.model || null;

  function fileKey(key) {
    return `people/${key}.json`;
  }

  /**
   * Read one person's metrics blob by their sanitized key.
   * @returns {object|null}
   */
  async function readPerson(key) {
    if (Model) {
      const doc = await Model.findOne({ key }).lean();
      return doc ? doc.data : null;
    }
    return (await storage.readFromStorage(fileKey(key))) || null;
  }

  /**
   * Write one person's metrics blob.
   */
  async function writePerson(key, data) {
    if (Model) {
      await Model.updateOne(
        { key },
        { $set: { key, jiraDisplayName: (data && data.jiraDisplayName) || null, data } },
        { upsert: true }
      );
      return;
    }
    await storage.writeToStorage(fileKey(key), data);
  }

  /**
   * List every person's metrics blob, along with the key it was stored under.
   * @returns {Array<{ key: string, data: object }>}
   */
  async function listPeople() {
    if (Model) {
      const docs = await Model.find({}).lean();
      return docs.map(doc => ({ key: doc.key, data: doc.data }));
    }
    const files = await storage.listStorageFiles('people');
    const results = [];
    for (const file of files) {
      const data = await storage.readFromStorage(`people/${file}`);
      if (data) {
        results.push({ key: file.endsWith('.json') ? file.slice(0, -'.json'.length) : file, data });
      }
    }
    return results;
  }

  return {
    readPerson,
    writePerson,
    listPeople,
    usesDatabase: !!Model
  };
}

module.exports = { createPersonStore };
