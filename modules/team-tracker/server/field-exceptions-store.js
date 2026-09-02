/** Dual-path field exceptions store. */
const crypto = require('crypto')
const { getStorageMutex } = require('../../../shared/server/storage-mutex')

const STORAGE_KEY = 'team-data/field-exceptions.json'

function generateId() {
  return 'fex_' + crypto.randomBytes(4).toString('hex')
}

function createFieldExceptionsStore(storage, options = {}) {
  const Model = options.model || null
  const auditLog = options.auditLog
  if (!auditLog) throw new Error('createFieldExceptionsStore requires options.auditLog (from the module context)')

  function toShape(doc) {
    return {
      id: doc.exceptionId,
      entityType: doc.entityType,
      entityId: doc.entityId,
      fieldId: doc.fieldId,
      reason: doc.reason,
      createdAt: doc.createdAt,
      createdBy: doc.createdBy
    }
  }

  async function readExceptions() {
    if (Model) {
      const docs = await Model.find({}).sort({ _id: 1 }).lean()
      return { version: 1, exceptions: docs.map(toShape) }
    }
    return (await storage.readFromStorage(STORAGE_KEY)) || { version: 1, exceptions: [] }
  }

  async function writeExceptions(data) {
    if (Model) throw new Error('writeExceptions is not supported on the MongoDB path; use targeted operations')
    await storage.writeToStorage(STORAGE_KEY, data)
  }

  async function listExceptions(filters = {}) {
    if (Model) {
      const query = {}
      for (const key of ['entityType', 'entityId', 'fieldId']) {
        if (filters[key]) query[key] = filters[key]
      }
      return (await Model.find(query).sort({ _id: 1 }).lean()).map(toShape)
    }
    let results = (await readExceptions()).exceptions
    for (const key of ['entityType', 'entityId', 'fieldId']) {
      if (filters[key]) results = results.filter(exception => exception[key] === filters[key])
    }
    return results
  }

  async function getException(id) {
    if (Model) {
      const doc = await Model.findOne({ exceptionId: id }).lean()
      return doc ? toShape(doc) : null
    }
    return (await readExceptions()).exceptions.find(exception => exception.id === id) || null
  }

  async function findException(entityType, entityId, fieldId) {
    if (Model) {
      const doc = await Model.findOne({ entityType, entityId, fieldId }).lean()
      return doc ? toShape(doc) : null
    }
    return (await readExceptions()).exceptions.find(exception =>
      exception.entityType === entityType && exception.entityId === entityId && exception.fieldId === fieldId
    ) || null
  }

  async function createException({ entityType, entityId, fieldId, reason }, actorEmail) {
    let exception
    let created
    if (Model) {
      const now = new Date().toISOString()
      const result = await Model.updateOne(
        { entityType, entityId, fieldId },
        {
          $set: { reason, createdAt: now, createdBy: actorEmail },
          $setOnInsert: { exceptionId: generateId(), entityType, entityId, fieldId }
        },
        { upsert: true }
      )
      created = result.upsertedCount === 1
      exception = toShape(await Model.findOne({ entityType, entityId, fieldId }).lean())
    } else {
      return getStorageMutex(STORAGE_KEY).runExclusive(async () => {
        const data = await readExceptions()
        const existing = data.exceptions.find(item =>
          item.entityType === entityType && item.entityId === entityId && item.fieldId === fieldId
        )
        created = !existing
        exception = existing || { id: generateId(), entityType, entityId, fieldId }
        Object.assign(exception, { reason, createdAt: new Date().toISOString(), createdBy: actorEmail })
        if (created) data.exceptions.push(exception)
        await writeExceptions(data)
        await appendAudit(exception, created, actorEmail)
        return { exception, created }
      })
    }
    await appendAudit(exception, created, actorEmail)
    return { exception, created }
  }

  async function appendAudit(exception, created, actorEmail) {
    await auditLog.appendAuditEntry({
      action: created ? 'field-exception.create' : 'field-exception.update',
      actor: actorEmail,
      entityType: 'field-exception',
      entityId: exception.id,
      detail: `${created ? 'Created exception for' : 'Updated exception reason for'} ${exception.entityType} "${exception.entityId}" on field "${exception.fieldId}"${created ? `: ${exception.reason}` : ''}`
    })
  }

  async function removeException(id, actorEmail) {
    let removed
    if (Model) {
      const doc = await Model.findOneAndDelete({ exceptionId: id }).lean()
      removed = doc ? toShape(doc) : null
    } else {
      return getStorageMutex(STORAGE_KEY).runExclusive(async () => {
        const data = await readExceptions()
        const index = data.exceptions.findIndex(exception => exception.id === id)
        if (index === -1) return null
        const [fileRemoved] = data.exceptions.splice(index, 1)
        await writeExceptions(data)
        await appendRemoveAudit(fileRemoved, actorEmail)
        return fileRemoved
      })
    }
    if (!removed) return null
    await appendRemoveAudit(removed, actorEmail)
    return removed
  }

  async function appendRemoveAudit(removed, actorEmail) {
    await auditLog.appendAuditEntry({
      action: 'field-exception.remove',
      actor: actorEmail,
      entityType: 'field-exception',
      entityId: removed.id,
      detail: `Removed exception for ${removed.entityType} "${removed.entityId}" on field "${removed.fieldId}"`
    })
  }

  async function getExceptionMap() {
    const map = new Map()
    for (const exception of await listExceptions()) {
      map.set(`${exception.entityType}:${exception.entityId}:${exception.fieldId}`, exception)
    }
    return map
  }

  return {
    readExceptions,
    writeExceptions,
    listExceptions,
    getException,
    findException,
    createException,
    removeException,
    getExceptionMap,
    usesDatabase: !!Model
  }
}

module.exports = { createFieldExceptionsStore, STORAGE_KEY }
