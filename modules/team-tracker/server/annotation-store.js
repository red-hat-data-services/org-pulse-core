const { getStorageMutex } = require('../../../shared/server/storage-mutex')

function annotationKey(sprintId) {
  return `annotations/${sprintId}.json`
}

function groupEntries(entries) {
  const annotations = {}
  for (const entry of entries || []) {
    if (!annotations[entry.assignee]) annotations[entry.assignee] = []
    annotations[entry.assignee].push({
      id: entry.id,
      text: entry.text,
      author: entry.author,
      createdAt: entry.createdAt
    })
  }
  return { annotations }
}

function createAnnotationStore(storage, options = {}) {
  const Model = options.model || null

  async function readAnnotations(sprintId) {
    if (Model) {
      const doc = await Model.findOne({ sprintId: String(sprintId) }).lean()
      return doc ? groupEntries(doc.entries) : { annotations: {} }
    }
    return (await storage.readFromStorage(annotationKey(sprintId))) || { annotations: {} }
  }

  async function addAnnotation(sprintId, assignee, annotation) {
    if (Model) {
      await Model.updateOne(
        { sprintId: String(sprintId) },
        { $push: { entries: { ...annotation, assignee } } },
        { upsert: true }
      )
      return annotation
    }

    const mutex = getStorageMutex(annotationKey(sprintId))
    return mutex.runExclusive(async () => {
      const data = (await storage.readFromStorage(annotationKey(sprintId))) || { annotations: {} }
      if (!data.annotations[assignee]) data.annotations[assignee] = []
      data.annotations[assignee].push(annotation)
      await storage.writeToStorage(annotationKey(sprintId), data)
      return annotation
    })
  }

  async function deleteAnnotation(sprintId, assignee, annotationId) {
    if (Model) {
      const doc = await Model.findOne({ sprintId: String(sprintId) }).lean()
      const exists = !!doc && (doc.entries || []).some(
        entry => entry.assignee === assignee && entry.id === annotationId
      )
      if (!exists) return false
      await Model.updateOne(
        { sprintId: String(sprintId) },
        { $pull: { entries: { assignee, id: annotationId } } }
      )
      return true
    }

    const mutex = getStorageMutex(annotationKey(sprintId))
    return mutex.runExclusive(async () => {
      const data = await storage.readFromStorage(annotationKey(sprintId))
      if (!data?.annotations?.[assignee]) return false

      const previousLength = data.annotations[assignee].length
      data.annotations[assignee] = data.annotations[assignee].filter(
        annotation => annotation.id !== annotationId
      )
      if (data.annotations[assignee].length === previousLength) return false
      if (data.annotations[assignee].length === 0) delete data.annotations[assignee]
      await storage.writeToStorage(annotationKey(sprintId), data)
      return true
    })
  }

  return {
    readAnnotations,
    addAnnotation,
    deleteAnnotation,
    usesDatabase: !!Model
  }
}

module.exports = { createAnnotationStore }
