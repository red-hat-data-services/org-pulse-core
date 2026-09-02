/** Dual-path CRUD for named field option sets. */
const { getStorageMutex } = require('../../../shared/server/storage-mutex')

const FIELD_OPTIONS_DIR = 'team-data/field-options'

async function acquireMultiLock(keys) {
  const releases = []
  for (const key of [...keys].sort()) releases.push(await getStorageMutex(key).acquire())
  return () => releases.forEach(release => release())
}

function optionsKey(name) {
  const safe = name.replace(/[^a-z0-9_-]/gi, '')
  if (!safe) throw new Error('Invalid field option set name: empty after sanitization')
  return `${FIELD_OPTIONS_DIR}/${safe}.json`
}

function createFieldOptionsStore(storage, options = {}) {
  const Model = options.model || null
  const { auditLog, registryStore, fieldStore, teamStore } = options
  if (!auditLog || !registryStore || !fieldStore || !teamStore) {
    throw new Error('createFieldOptionsStore requires auditLog, registryStore, fieldStore and teamStore from the module context')
  }

  function toShape(doc) {
    const result = {
      name: doc.name,
      label: doc.label,
      values: doc.values || []
    }
    for (const key of ['source', 'sourceProject', 'sourceConfig', 'richValues', 'orphanedValues', 'syncedAt', 'updatedAt', 'updatedBy', 'migrationDone', 'migratedAt', 'migratedBy']) {
      if (doc[key] !== undefined) result[key] = doc[key]
    }
    return result
  }

  async function readFieldOptions(name) {
    optionsKey(name)
    if (Model) {
      const doc = await Model.findOne({ optionId: name }).lean()
      return doc ? toShape(doc) : null
    }
    return (await storage.readFromStorage(optionsKey(name))) || null
  }

  async function writeFieldOptions(name, data) {
    optionsKey(name)
    if (Model) {
      await Model.replaceOne({ optionId: name }, { ...data, optionId: name }, { upsert: true })
      return
    }
    await storage.writeToStorage(optionsKey(name), data)
  }

  async function updateFieldOptions(name, updates, unsetKeys = []) {
    optionsKey(name)
    if (Model) {
      const update = { $set: updates }
      if (unsetKeys.length) update.$unset = Object.fromEntries(unsetKeys.map(key => [key, '']))
      const doc = await Model.findOneAndUpdate({ optionId: name }, update, { returnDocument: 'after', lean: true })
      return doc ? toShape(doc) : null
    }
    return getStorageMutex(optionsKey(name)).runExclusive(async () => {
      const data = await readFieldOptions(name)
      if (!data) return null
      Object.assign(data, updates)
      for (const key of unsetKeys) delete data[key]
      await writeFieldOptions(name, data)
      return data
    })
  }

  async function listFieldOptions() {
    if (Model) {
      const docs = await Model.find({}).sort({ _id: 1 }).lean()
      return docs.map(doc => {
        const summary = { name: doc.name, label: doc.label, count: (doc.values || []).length }
        if (doc.source) summary.source = doc.source
        return summary
      })
    }
    const files = await storage.listStorageFiles(FIELD_OPTIONS_DIR)
    const results = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const data = await storage.readFromStorage(`${FIELD_OPTIONS_DIR}/${file}`)
      if (!data) continue
      const summary = { name: data.name, label: data.label, count: (data.values || []).length }
      if (data.source) summary.source = data.source
      results.push(summary)
    }
    return results
  }

  async function getValues(name) {
    const data = await readFieldOptions(name)
    return data ? data.values || [] : null
  }

  async function auditAdd(name, added, actorEmail) {
    await auditLog.appendAuditEntry({
      action: 'field-options.add', actor: actorEmail, entityType: 'field-options', entityId: name,
      detail: `Added ${added.length} values to "${name}": ${added.join(', ')}`
    })
  }

  async function addValues(name, values, actorEmail) {
    if (!Model) {
      return getStorageMutex(optionsKey(name)).runExclusive(async () => {
        let data = await readFieldOptions(name)
        assertManual(data, name, 'modified')
        if (!data) data = { name, label: defaultLabel(name), values: [] }
        const added = addUniqueValues(data.values, values)
        if (added.length) {
          data.values.sort()
          stamp(data, actorEmail)
          await writeFieldOptions(name, data)
          await auditAdd(name, added, actorEmail)
        }
        return { added, total: data.values.length }
      })
    }

    for (;;) {
      const current = await readFieldOptions(name)
      assertManual(current, name, 'modified')
      const next = current || { name, label: defaultLabel(name), values: [] }
      const added = addUniqueValues(next.values, values)
      if (!added.length) return { added, total: next.values.length }
      next.values.sort()
      stamp(next, actorEmail)
      if (!current) {
        try {
          await Model.create({ ...next, optionId: name })
          await auditAdd(name, added, actorEmail)
          return { added, total: next.values.length }
        } catch (error) {
          if (error.code === 11000) continue
          throw error
        }
      }
      const before = await Model.findOneAndUpdate(
        { optionId: name, $or: [{ source: { $exists: false } }, { source: null }] },
        [{ $set: {
          values: { $sortArray: { input: { $setUnion: ['$values', added] }, sortBy: 1 } },
          updatedAt: next.updatedAt,
          updatedBy: actorEmail
        } }],
        { returnDocument: 'before', lean: true, updatePipeline: true }
      )
      if (!before) continue
      const actualAdded = added.filter(value => !(before.values || []).includes(value))
      if (actualAdded.length) await auditAdd(name, actualAdded, actorEmail)
      return { added: actualAdded, total: new Set([...(before.values || []), ...added]).size }
    }
  }

  async function replaceValues(name, values, label, actorEmail) {
    const run = async () => {
      const existing = await readFieldOptions(name)
      assertManual(existing, name, 'replaced')
      const data = {
        name,
        label: label || defaultLabel(name),
        values: normalizeValues(values),
        updatedAt: new Date().toISOString(),
        updatedBy: actorEmail
      }
      if (Model) {
        try {
          await Model.updateOne(
            { optionId: name, $or: [{ source: { $exists: false } }, { source: null }] },
            { $set: { ...data, optionId: name } },
            { upsert: true }
          )
        } catch (error) {
          if (error.code === 11000) assertManual(await readFieldOptions(name), name, 'replaced')
          throw error
        }
      } else {
        await writeFieldOptions(name, data)
      }
      await auditLog.appendAuditEntry({
        action: 'field-options.replace', actor: actorEmail, entityType: 'field-options', entityId: name,
        detail: `Replaced "${name}" field options with ${data.values.length} values`
      })
      return data
    }
    return Model ? run() : getStorageMutex(optionsKey(name)).runExclusive(run)
  }

  async function removeValues(name, valuesToRemove, actorEmail) {
    const run = async () => {
      const data = await readFieldOptions(name)
      if (!data) return null
      assertManual(data, name, 'modified')
      const remove = new Set(valuesToRemove)
      const nextValues = data.values.filter(value => !remove.has(value))
      let removed = data.values.length - nextValues.length
      if (!removed) return { removed: 0, total: data.values.length }
      data.values = nextValues
      stamp(data, actorEmail)
      if (Model) {
        const before = await Model.findOneAndUpdate(
          { optionId: name, $or: [{ source: { $exists: false } }, { source: null }] },
          { $pull: { values: { $in: [...remove] } }, $set: { updatedAt: data.updatedAt, updatedBy: actorEmail } },
          { returnDocument: 'before', lean: true }
        )
        if (!before) return run()
        const actualRemoved = (before.values || []).filter(value => remove.has(value)).length
        if (!actualRemoved) return { removed: 0, total: before.values.length }
        removed = actualRemoved
        data.values = before.values.filter(value => !remove.has(value))
      } else {
        await writeFieldOptions(name, data)
      }
      await auditLog.appendAuditEntry({
        action: 'field-options.remove', actor: actorEmail, entityType: 'field-options', entityId: name,
        detail: `Removed ${removed} values from "${name}"`
      })
      return { removed, total: data.values.length }
    }
    return Model ? run() : getStorageMutex(optionsKey(name)).runExclusive(run)
  }

  async function syncFromExternal(name, syncOptions) {
    const run = async () => {
      const { source, expectedSource, sourceProject, values, label, richValues } = syncOptions
      const existing = await readFieldOptions(name)
      const previousValues = existing?.values || []
      const normalized = normalizeValues(values)
      const oldSet = new Set(previousValues)
      const newSet = new Set(normalized)
      const added = normalized.filter(value => !oldSet.has(value))
      const removed = previousValues.filter(value => !newSet.has(value))
      const orphanedValues = removed.length ? await findReferencedValues(name, removed) : []
      const now = new Date().toISOString()
      const data = {
        name,
        label: label || existing?.label || defaultLabel(name),
        values: normalized,
        source,
        sourceProject: sourceProject || null,
        syncedAt: now,
        updatedAt: now,
        updatedBy: source + '-sync'
      }
      if (richValues) data.richValues = richValues
      if (orphanedValues.length) data.orphanedValues = orphanedValues
      if (existing?.sourceConfig) data.sourceConfig = existing.sourceConfig
      if (Model && expectedSource !== undefined) {
        const result = await Model.replaceOne(
          { optionId: name, source: expectedSource },
          { ...data, optionId: name }
        )
        if (!result.matchedCount) return { orphanedValues: [], added: [], removed: [], skipped: true }
      } else {
        await writeFieldOptions(name, data)
      }
      if (added.length || removed.length) {
        await auditLog.appendAuditEntry({
          action: 'field-options.external-sync', actor: source + '-sync', entityType: 'field-options', entityId: name,
          detail: `Synced from ${source} (project: ${sourceProject || 'unknown'}): ${normalized.length} values (${added.length} added, ${removed.length} removed, ${orphanedValues.length} orphaned)`
        })
      }
      return { orphanedValues, added, removed }
    }
    return Model ? run() : getStorageMutex(optionsKey(name)).runExclusive(run)
  }

  async function findReferencedValues(optionSetName, candidates) {
    if (!candidates?.length) return []
    const candidateSet = new Set(candidates)
    const referenced = new Set()
    const fieldDefs = await fieldStore.readFieldDefinitions()
    const personFieldIds = activeOptionFields(fieldDefs.personFields, optionSetName)
    const teamFieldIds = activeOptionFields(fieldDefs.teamFields, optionSetName)
    if (personFieldIds.length) scanRecords((await registryStore.readRegistry())?.people, '_appFields', personFieldIds, candidateSet, referenced)
    if (teamFieldIds.length) scanRecords((await teamStore.readTeams())?.teams, 'metadata', teamFieldIds, candidateSet, referenced)
    return [...referenced].sort()
  }

  async function renameValue(name, oldValue, newValue, actorEmail) {
    const run = async () => {
      const data = await readFieldOptions(name)
      if (!data) return null
      assertManual(data, name, 'modified')
      const index = data.values.indexOf(oldValue)
      if (index === -1) throw new Error(`Value "${oldValue}" not found in option set "${name}"`)
      if (data.values.includes(newValue)) throw new Error(`Value "${newValue}" already exists in option set "${name}"`)
      data.values[index] = newValue
      data.values.sort()
      stamp(data, actorEmail)
      if (Model) {
        const doc = await Model.findOneAndUpdate(
          {
            optionId: name,
            values: oldValue,
            $and: [{ values: { $ne: newValue } }],
            $or: [{ source: { $exists: false } }, { source: null }]
          },
          [{ $set: {
            values: { $sortArray: { input: { $map: { input: '$values', as: 'value', in: { $cond: [{ $eq: ['$$value', oldValue] }, newValue, '$$value'] } } }, sortBy: 1 } },
            updatedAt: data.updatedAt,
            updatedBy: actorEmail
          } }],
          { returnDocument: 'after', lean: true, updatePipeline: true }
        )
        if (!doc) return run()
      } else {
        await writeFieldOptions(name, data)
      }

      const fieldDefs = await fieldStore.readFieldDefinitions()
      const personFieldIds = activeOptionFields(fieldDefs.personFields, name)
      const teamFieldIds = activeOptionFields(fieldDefs.teamFields, name)
      let updated = 0
      const registry = personFieldIds.length ? await registryStore.readRegistry() : null
      const changedPeople = []
      for (const [uid, person] of Object.entries(registry?.people || {})) {
        const changes = renameFields(person._appFields, personFieldIds, oldValue, newValue)
        updated += changes.count
        if (changes.count) {
          if (registryStore.usesDatabase) await registryStore.updatePersonFields(uid, changes.values)
          else {
            Object.assign(person._appFields, changes.values)
            changedPeople.push(uid)
          }
        }
      }
      if (changedPeople.length) await storage.writeToStorage('team-data/registry.json', registry)
      const teams = teamFieldIds.length ? await teamStore.readTeams() : null
      let teamsChanged = false
      for (const [teamId, team] of Object.entries(teams?.teams || {})) {
        const changes = renameFields(team.metadata, teamFieldIds, oldValue, newValue)
        updated += changes.count
        if (changes.count) {
          if (teamStore.usesDatabase) await teamStore.updateTeamFields(teamId, changes.values, actorEmail)
          else {
            Object.assign(team.metadata, changes.values)
            teamsChanged = true
          }
        }
      }
      if (teamsChanged) await storage.writeToStorage('team-data/teams.json', teams)
      await auditLog.appendAuditEntry({
        action: 'field-options.rename', actor: actorEmail, entityType: 'field-options', entityId: name,
        oldValue, newValue, detail: `Renamed "${oldValue}" to "${newValue}" in "${name}" (${updated} records updated)`
      })
      return { updated }
    }
    if (Model) return run()
    const release = await acquireMultiLock([
      optionsKey(name),
      'team-data/registry.json',
      'team-data/teams.json'
    ])
    try {
      return await run()
    } finally {
      release()
    }
  }

  return {
    listFieldOptions, getValues, addValues, replaceValues, removeValues, renameValue,
    syncFromExternal, findReferencedValues, readFieldOptions, writeFieldOptions, updateFieldOptions,
    usesDatabase: !!Model
  }
}

function defaultLabel(name) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function normalizeValues(values) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort()
}

function addUniqueValues(target, values) {
  const existing = new Set(target)
  const added = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed && !existing.has(trimmed)) {
      target.push(trimmed)
      existing.add(trimmed)
      added.push(trimmed)
    }
  }
  return added
}

function stamp(data, actorEmail) {
  data.updatedAt = new Date().toISOString()
  data.updatedBy = actorEmail
}

function assertManual(data, name, action) {
  if (data?.source) throw new Error(`Option set "${name}" is managed by external source "${data.source}" and cannot be manually ${action}`)
}

function activeOptionFields(fields = [], name) {
  return fields.filter(field => !field.deleted && field.optionsRef === name).map(field => field.id)
}

function scanRecords(records, property, fieldIds, candidates, referenced) {
  for (const record of Object.values(records || {})) {
    const values = record[property]
    if (!values) continue
    for (const fieldId of fieldIds) {
      const value = values[fieldId]
      for (const item of Array.isArray(value) ? value : [value]) {
        if (candidates.has(item)) referenced.add(item)
      }
    }
  }
}

function renameFields(fields, fieldIds, oldValue, newValue) {
  const values = {}
  let count = 0
  for (const fieldId of fieldIds) {
    const value = fields?.[fieldId]
    if (value === oldValue) {
      values[fieldId] = newValue
      count++
    } else if (Array.isArray(value) && value.includes(oldValue)) {
      values[fieldId] = value.map(item => item === oldValue ? newValue : item)
      count++
    }
  }
  return { values, count }
}

module.exports = { createFieldOptionsStore, FIELD_OPTIONS_DIR }
