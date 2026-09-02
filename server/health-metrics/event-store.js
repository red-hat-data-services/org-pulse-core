const fs = require('fs');
const path = require('path');

function createEventStore(eventsDir, options = {}) {

  const Model = options.model || null;
  const monthSnapshots = new Map();
  const eventIds = new WeakMap();

  let isPruning = false;
  let pruneBuffer = [];

  function ensureEventsDir() {
    if (!fs.existsSync(eventsDir)) {
      fs.mkdirSync(eventsDir, { recursive: true });
    }
  }

  function getMonthKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function getFilePath(monthKey) {
    return path.join(eventsDir, `${monthKey}.jsonl`);
  }

  async function append(event) {
    if (isPruning) {
      pruneBuffer.push(event);
      return;
    }
    if (Model) {
      const monthKey = getMonthKey(event.ts);
      await Model.create({ month: monthKey, event });
      return;
    }
    ensureEventsDir();
    const monthKey = getMonthKey(event.ts);
    const filePath = getFilePath(monthKey);
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }

  async function readMonth(monthKey) {
    if (Model) {
      await migrateLegacyDocuments({ month: monthKey });
      const rows = await readRows(monthKey);
      if (isPruning) monthSnapshots.set(monthKey, rows);
      return rows.map(row => {
        const event = row.event;
        if (event && typeof event === 'object') eventIds.set(event, String(row._id));
        return event;
      });
    }
    const filePath = getFilePath(monthKey);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line); }
          catch { return null; }
        })
        .filter(Boolean);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async function listMonthFiles() {
    if (Model) {
      await migrateLegacyDocuments({});
      return (await Model.distinct('month')).sort();
    }
    try {
      return fs.readdirSync(eventsDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''))
        .sort();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async function deleteMonthFile(monthKey) {
    if (Model) {
      const rows = await getSnapshot(monthKey);
      if (rows.length > 0) {
        await Model.deleteMany({ _id: { $in: rows.map(row => row._id) } });
      }
      monthSnapshots.delete(monthKey);
      return;
    }
    const filePath = getFilePath(monthKey);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async function rewriteMonth(monthKey, events) {
    if (Model) {
      const rows = await getSnapshot(monthKey);
      const rowsById = new Map(rows.map(row => [String(row._id), row]));
      const unmatchedRows = new Map();
      for (const row of rows) {
        const key = JSON.stringify(row.event);
        const matches = unmatchedRows.get(key) || [];
        matches.push(row);
        unmatchedRows.set(key, matches);
      }

      const keptIds = new Set();
      const additions = [];
      for (const event of events) {
        const knownId = event && typeof event === 'object' ? eventIds.get(event) : null;
        if (knownId && rowsById.has(knownId) && !keptIds.has(knownId)) {
          keptIds.add(knownId);
          continue;
        }
        const matches = unmatchedRows.get(JSON.stringify(event));
        const match = matches?.find(row => !keptIds.has(String(row._id)));
        if (match) keptIds.add(String(match._id));
        else additions.push({ month: monthKey, event });
      }

      if (additions.length > 0) await Model.insertMany(additions);
      const removedIds = rows
        .filter(row => !keptIds.has(String(row._id)))
        .map(row => row._id);
      if (removedIds.length > 0) {
        await Model.deleteMany({ _id: { $in: removedIds } });
      }
      monthSnapshots.delete(monthKey);
      return;
    }
    ensureEventsDir();
    const filePath = getFilePath(monthKey);
    if (events.length === 0) {
      try { fs.unlinkSync(filePath); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return;
    }
    const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(filePath, content);
  }

  function startPruning() {
    isPruning = true;
    pruneBuffer = [];
  }

  async function finishPruning() {
    isPruning = false;
    if (pruneBuffer.length > 0) {
      if (Model) {
        const buffered = pruneBuffer;
        pruneBuffer = [];
        await Promise.all(buffered.map(event => append(event)));
        return;
      }
      ensureEventsDir();
      for (const event of pruneBuffer) {
        const monthKey = getMonthKey(event.ts);
        const filePath = getFilePath(monthKey);
        fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
      }
      pruneBuffer = [];
    }
  }

  async function deleteAllEvents() {
    if (Model) {
      await Model.deleteMany({});
      monthSnapshots.clear();
      return;
    }
    try {
      const files = fs.readdirSync(eventsDir);
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          fs.unlinkSync(path.join(eventsDir, f));
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async function readRows(monthKey) {
    return Model.find(
      { month: monthKey, event: { $exists: true } },
      { event: 1, recordedAt: 1 }
    ).sort({ recordedAt: 1, _id: 1 }).lean();
  }

  async function getSnapshot(monthKey) {
    if (isPruning && monthSnapshots.has(monthKey)) return monthSnapshots.get(monthKey);
    await migrateLegacyDocuments({ month: monthKey });
    const rows = await readRows(monthKey);
    if (isPruning) monthSnapshots.set(monthKey, rows);
    return rows;
  }

  async function migrateLegacyDocuments(filter) {
    const legacyDocuments = await Model.find({
      ...filter,
      events: { $exists: true }
    }, { month: 1, events: 1 }).lean();

    for (const legacy of legacyDocuments) {
      if (legacy.events.length > 0) {
        await Model.bulkWrite(legacy.events.map((event, index) => ({
          updateOne: {
            filter: { sourceLegacyId: legacy._id, sourceLegacyIndex: index },
            update: {
              $setOnInsert: {
                month: legacy.month,
                event,
                recordedAt: legacy._id.getTimestamp(),
                sourceLegacyId: legacy._id,
                sourceLegacyIndex: index
              }
            },
            upsert: true
          }
        })), { ordered: true });
      }
      await Model.deleteOne({ _id: legacy._id, events: { $exists: true } });
    }
  }

  return {
    append,
    readMonth,
    listMonthFiles,
    deleteMonthFile,
    rewriteMonth,
    startPruning,
    finishPruning,
    deleteAllEvents,
    getMonthKey,
    usesDatabase: !!Model,
  };
}

module.exports = { createEventStore };
