/**
 * GitHub/GitLab contribution + monthly-history cache. Supports both MongoDB
 * (via a Mongoose model) and file-based storage. See models/contribution.js
 * for the schema and the partial-failure-safety reasoning behind per-user
 * upserts on the MongoDB path.
 *
 * @param {object} storage - Storage module with readFromStorage/writeToStorage
 * @param {object} [options={}] - Options
 * @param {object} [options.model] - Optional Mongoose Contribution model for the MongoDB path
 * @returns {object} Contribution store API
 */
const META_USERNAME = '__meta__';

function createContributionStore(storage, options = {}) {
  const Model = options.model || null;

  function cacheKey(provider) {
    return `${provider}-contributions.json`;
  }

  function historyKey(provider) {
    return `${provider}-history.json`;
  }

  /**
   * Read the running-totals cache for a provider ('github'|'gitlab').
   * @returns {{ users: object, fetchedAt: string|null }}
   */
  async function readCache(provider) {
    if (Model) {
      const [docs, meta] = await Promise.all([
        Model.find({ provider, username: { $ne: META_USERNAME } }).lean(),
        Model.findOne({ provider, username: META_USERNAME }).lean()
      ]);
      const users = {};
      for (const doc of docs) {
        const user = {
          username: doc.username,
          totalContributions: doc.totalContributions || 0,
          months: doc.months || {},
          fetchedAt: doc.contributionsFetchedAt || null
        };
        if (doc.instances !== undefined) user.instances = doc.instances;
        if (doc.source !== undefined) user.source = doc.source;
        users[doc.username] = user;
      }
      return { users, fetchedAt: meta ? meta.batchFetchedAt : null };
    }
    return (await storage.readFromStorage(cacheKey(provider))) || { users: {}, fetchedAt: null };
  }

  /**
   * Read the monthly-history cache for a provider ('github'|'gitlab').
   * @returns {{ users: object, fetchedAt: string|null }}
   */
  async function readHistory(provider) {
    if (Model) {
      const [docs, meta] = await Promise.all([
        Model.find({ provider, username: { $ne: META_USERNAME } }).lean(),
        Model.findOne({ provider, username: META_USERNAME }).lean()
      ]);
      const users = {};
      for (const doc of docs) {
        users[doc.username] = {
          months: doc.months || {},
          fetchedAt: doc.historyFetchedAt || null
        };
      }
      return { users, fetchedAt: meta ? meta.batchFetchedAt : null };
    }
    return (await storage.readFromStorage(historyKey(provider))) || { users: {}, fetchedAt: null };
  }

  /**
   * Merge freshly-fetched per-user results into both the contributions
   * cache and the history cache. Mirrors the file path's whole-blob
   * semantics for callers, but on the MongoDB path each user is a separate
   * upsert, so a crash partway through a refresh loses only the users not
   * yet written — the same partial-failure exposure the file path already
   * has (a crash before the single whole-file write loses the whole batch;
   * a crash after loses nothing new).
   *
   * @param {'github'|'gitlab'} provider
   * @param {object} results - Map of username -> { totalContributions, months, fetchedAt } | null
   */
  async function writeResults(provider, results) {
    if (!Object.values(results).some(Boolean)) return;

    const now = new Date().toISOString();

    if (Model) {
      for (const [username, data] of Object.entries(results)) {
        if (!data) continue;
        const $set = {
          provider,
          username,
          totalContributions: data.totalContributions || 0,
          contributionsFetchedAt: data.fetchedAt || now
        };
        if (Object.prototype.hasOwnProperty.call(data, 'months')) {
          $set.months = data.months;
          $set.historyFetchedAt = data.fetchedAt || now;
        }
        if (Object.prototype.hasOwnProperty.call(data, 'instances')) $set.instances = data.instances;
        if (Object.prototype.hasOwnProperty.call(data, 'source')) $set.source = data.source;
        await Model.updateOne(
          { provider, username },
          { $set },
          { upsert: true }
        );
      }
      await Model.updateOne(
        { provider, username: META_USERNAME },
        { $set: { provider, username: META_USERNAME, batchFetchedAt: now } },
        { upsert: true }
      );
      return;
    }

    const contribCache = (await storage.readFromStorage(cacheKey(provider))) || { users: {}, fetchedAt: null };
    const historyCache = (await storage.readFromStorage(historyKey(provider))) || { users: {}, fetchedAt: null };

    for (const [username, data] of Object.entries(results)) {
      if (data) {
        contribCache.users[username] = { ...(contribCache.users[username] || {}), ...data };
        if (Object.prototype.hasOwnProperty.call(data, 'months')) {
          historyCache.users[username] = { months: data.months, fetchedAt: data.fetchedAt };
        }
      }
    }

    contribCache.fetchedAt = now;
    historyCache.fetchedAt = now;
    await storage.writeToStorage(cacheKey(provider), contribCache);
    await storage.writeToStorage(historyKey(provider), historyCache);
  }

  return {
    readCache,
    readHistory,
    writeResults,
    usesDatabase: !!Model
  };
}

module.exports = { createContributionStore };
