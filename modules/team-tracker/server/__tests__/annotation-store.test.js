import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'

const { createAnnotationStore } = require('../annotation-store')
const { sprintAnnotationSchema } = require('../models/sprint-annotation')

function createStorage(initial = {}) {
  const data = structuredClone(initial)
  return {
    async readFromStorage(key) { return data[key] ? structuredClone(data[key]) : null },
    async writeToStorage(key, value) { data[key] = structuredClone(value) },
    data
  }
}

function annotation(id = 'ann-1') {
  return {
    id,
    text: 'On PTO',
    author: 'manager@example.com',
    createdAt: '2026-03-10T12:00:00.000Z'
  }
}

async function exercisePersistence(first, second) {
  await first.addAnnotation('123', 'Alice B. Smith', annotation())
  await first.addAnnotation('123', 'Alice B. Smith', annotation('ann-2'))
  expect(await second.readAnnotations('123')).toEqual({
    annotations: { 'Alice B. Smith': [annotation(), annotation('ann-2')] }
  })
  expect(await second.deleteAnnotation('123', 'Alice B. Smith', 'ann-1')).toBe(true)
  expect(await first.readAnnotations('123')).toEqual({
    annotations: { 'Alice B. Smith': [annotation('ann-2')] }
  })
  expect(await second.deleteAnnotation('123', 'Alice B. Smith', 'missing')).toBe(false)
}

describe('annotation store file path', () => {
  it('persists, reads, and deletes annotations with the existing key and shape', async () => {
    const storage = createStorage()
    const first = createAnnotationStore(storage)
    await exercisePersistence(first, createAnnotationStore(storage))
    expect(storage.data['annotations/123.json']).toEqual({
      annotations: { 'Alice B. Smith': [annotation('ann-2')] }
    })
    expect(first.usesDatabase).toBe(false)
  })

  it('returns an empty annotation map when no data exists', async () => {
    expect(await createAnnotationStore(createStorage()).readAnnotations('missing'))
      .toEqual({ annotations: {} })
  })
})

describe('annotation store MongoDB path', () => {
  let connection
  let Model

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: `test_team_tracker_annotations_${process.pid}`
    }).asPromise()
    Model = connection.model('annotation', sprintAnnotationSchema, 'team_tracker__annotation_test')
  })

  beforeEach(async () => Model.deleteMany({}))

  afterAll(async () => {
    await connection.db.dropDatabase()
    await connection.close()
  })

  it('persists and reads annotations across store instances', async () => {
    const first = createAnnotationStore(createStorage(), { model: Model })
    await exercisePersistence(first, createAnnotationStore(createStorage(), { model: Model }))
    expect(first.usesDatabase).toBe(true)
  })

  it('returns an empty annotation map when no document exists', async () => {
    const store = createAnnotationStore(createStorage(), { model: Model })
    expect(await store.readAnnotations('missing')).toEqual({ annotations: {} })
  })
})
