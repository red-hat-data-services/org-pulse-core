const { getStorageMutex } = require('../../shared/server/storage-mutex');

const CONFIG_KEY = 'health-metrics/config.json';
const OPTED_OUT_KEY = 'health-metrics/opted-out.json';
const AGGREGATES_DIR = 'health-metrics/aggregates';
const DEFAULT_CONFIG = { userTypeFieldId: null, retentionDays: 90 };

function aggregateKey(month) {
  return `${AGGREGATES_DIR}/${month}.json`;
}

function createHealthMetricsStore(storage, options = {}) {
  const Model = options.model || null;

  async function readConfig() {
    if (Model) {
      const doc = await Model.findOne({ key: CONFIG_KEY }).lean();
      return doc ? doc.data : null;
    }
    return storage.readFromStorage(CONFIG_KEY);
  }

  async function updateConfig(patch) {
    if (Model) {
      const doc = await Model.findOneAndUpdate(
        { key: CONFIG_KEY },
        [{
          $set: {
            key: CONFIG_KEY,
            kind: 'config',
            data: {
              $mergeObjects: [
                DEFAULT_CONFIG,
                { $ifNull: ['$data', {}] },
                { $literal: patch }
              ]
            }
          }
        }],
        { upsert: true, returnDocument: 'after', lean: true, updatePipeline: true }
      );
      return doc.data;
    }

    return getStorageMutex(CONFIG_KEY).runExclusive(async () => {
      const config = (await storage.readFromStorage(CONFIG_KEY)) || { ...DEFAULT_CONFIG };
      Object.assign(config, patch);
      await storage.writeToStorage(CONFIG_KEY, config);
      return config;
    });
  }

  async function readOptedOut() {
    if (Model) {
      const doc = await Model.findOne({ key: OPTED_OUT_KEY }).lean();
      return doc ? doc.data : null;
    }
    return storage.readFromStorage(OPTED_OUT_KEY);
  }

  async function isOptedOut(email) {
    if (Model) {
      return !!(await Model.exists({ key: OPTED_OUT_KEY, 'data.emails': email }));
    }
    const data = (await storage.readFromStorage(OPTED_OUT_KEY)) || { emails: [] };
    return data.emails.includes(email);
  }

  async function addOptOut(email) {
    if (Model) {
      await Model.findOneAndUpdate(
        { key: OPTED_OUT_KEY },
        {
          $setOnInsert: { key: OPTED_OUT_KEY, kind: 'opted-out' },
          $addToSet: { 'data.emails': email }
        },
        { upsert: true, setDefaultsOnInsert: false }
      );
      return;
    }

    await getStorageMutex(OPTED_OUT_KEY).runExclusive(async () => {
      const data = (await storage.readFromStorage(OPTED_OUT_KEY)) || { emails: [] };
      if (!data.emails.includes(email)) {
        data.emails.push(email);
        await storage.writeToStorage(OPTED_OUT_KEY, data);
      }
    });
  }

  async function removeOptOut(email) {
    if (Model) {
      await Model.updateOne(
        { key: OPTED_OUT_KEY },
        { $pull: { 'data.emails': email } }
      );
      return;
    }

    await getStorageMutex(OPTED_OUT_KEY).runExclusive(async () => {
      const data = (await storage.readFromStorage(OPTED_OUT_KEY)) || { emails: [] };
      const nextEmails = data.emails.filter(candidate => candidate !== email);
      if (nextEmails.length !== data.emails.length) {
        data.emails = nextEmails;
        await storage.writeToStorage(OPTED_OUT_KEY, data);
      }
    });
  }

  async function readAggregate(month) {
    if (Model) {
      const doc = await Model.findOne({ key: aggregateKey(month) }).lean();
      return doc ? doc.data : null;
    }
    return storage.readFromStorage(aggregateKey(month));
  }

  async function writeAggregate(month, aggregate) {
    if (Model) {
      await Model.findOneAndUpdate(
        { key: aggregateKey(month) },
        { $set: { kind: 'aggregate', month, data: aggregate } },
        { upsert: true }
      );
      return;
    }
    await storage.writeToStorage(aggregateKey(month), aggregate);
  }

  async function listAggregateMonths() {
    if (Model) {
      const docs = await Model.find({ kind: 'aggregate' }, { month: 1, _id: 0 }).lean();
      return docs.map(doc => doc.month).filter(Boolean).sort();
    }
    const files = ((storage.listStorageFiles
      ? await storage.listStorageFiles(AGGREGATES_DIR)
      : null) || []);
    return files.filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort();
  }

  return {
    readConfig,
    updateConfig,
    readOptedOut,
    isOptedOut,
    addOptOut,
    removeOptOut,
    readAggregate,
    writeAggregate,
    listAggregateMonths,
    usesDatabase: !!Model
  };
}

module.exports = {
  createHealthMetricsStore,
  CONFIG_KEY,
  OPTED_OUT_KEY,
  AGGREGATES_DIR,
  DEFAULT_CONFIG
};
