import { describe, it, expect, vi } from 'vitest'

const fieldExceptionsStore = require('../../server/field-exceptions-store')

function makeStorage(initial = {}) {
  const data = { ...initial }
  return {
    readFromStorage(key) { return data[key] ? JSON.parse(JSON.stringify(data[key])) : null },
    writeToStorage: vi.fn((key, val) => { data[key] = JSON.parse(JSON.stringify(val)) }),
    _data: data
  }
}

function storageWithAuditLog(initial = {}) {
  return makeStorage({ 'audit-log.json': { entries: [] }, ...initial })
}

describe('field-exceptions-store', () => {
  describe('readExceptions', () => {
    it('returns empty exceptions when file does not exist', () => {
      const storage = makeStorage({})
      const result = fieldExceptionsStore.readExceptions(storage)
      expect(result).toEqual({ version: 1, exceptions: [] })
    })

    it('returns stored data when file exists', () => {
      const stored = {
        version: 1,
        exceptions: [{ id: 'fex_00000001', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'test', createdAt: '2026-01-01', createdBy: 'admin@test.com' }]
      }
      const storage = makeStorage({ 'team-data/field-exceptions.json': stored })
      const result = fieldExceptionsStore.readExceptions(storage)
      expect(result.exceptions).toHaveLength(1)
      expect(result.exceptions[0].id).toBe('fex_00000001')
    })
  })

  describe('listExceptions', () => {
    const exceptions = [
      { id: 'fex_1', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'r1', createdAt: '2026-01-01', createdBy: 'admin@test.com' },
      { id: 'fex_2', entityType: 'person', entityId: 'bob', fieldId: 'field_f1', reason: 'r2', createdAt: '2026-01-01', createdBy: 'admin@test.com' },
      { id: 'fex_3', entityType: 'team', entityId: 'team_a', fieldId: 'field_g1', reason: 'r3', createdAt: '2026-01-01', createdBy: 'admin@test.com' },
      { id: 'fex_4', entityType: 'team', entityId: 'team_a', fieldId: '__boards__', reason: 'r4', createdAt: '2026-01-01', createdBy: 'admin@test.com' }
    ]

    it('returns all exceptions when no filters', () => {
      const storage = makeStorage({ 'team-data/field-exceptions.json': { version: 1, exceptions } })
      expect(fieldExceptionsStore.listExceptions(storage)).toHaveLength(4)
    })

    it('filters by entityType', () => {
      const storage = makeStorage({ 'team-data/field-exceptions.json': { version: 1, exceptions } })
      const result = fieldExceptionsStore.listExceptions(storage, { entityType: 'team' })
      expect(result).toHaveLength(2)
      expect(result.every(e => e.entityType === 'team')).toBe(true)
    })

    it('filters by entityId', () => {
      const storage = makeStorage({ 'team-data/field-exceptions.json': { version: 1, exceptions } })
      const result = fieldExceptionsStore.listExceptions(storage, { entityId: 'alice' })
      expect(result).toHaveLength(1)
      expect(result[0].entityId).toBe('alice')
    })

    it('filters by fieldId', () => {
      const storage = makeStorage({ 'team-data/field-exceptions.json': { version: 1, exceptions } })
      const result = fieldExceptionsStore.listExceptions(storage, { fieldId: '__boards__' })
      expect(result).toHaveLength(1)
      expect(result[0].fieldId).toBe('__boards__')
    })

    it('combines multiple filters', () => {
      const storage = makeStorage({ 'team-data/field-exceptions.json': { version: 1, exceptions } })
      const result = fieldExceptionsStore.listExceptions(storage, { entityType: 'person', fieldId: 'field_f1' })
      expect(result).toHaveLength(2)
    })
  })

  describe('getException', () => {
    it('returns exception by ID', () => {
      const storage = makeStorage({
        'team-data/field-exceptions.json': {
          version: 1,
          exceptions: [{ id: 'fex_abc', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'test', createdAt: '2026-01-01', createdBy: 'a@t.com' }]
        }
      })
      expect(fieldExceptionsStore.getException(storage, 'fex_abc')).toBeTruthy()
      expect(fieldExceptionsStore.getException(storage, 'fex_abc').entityId).toBe('alice')
    })

    it('returns null for non-existent ID', () => {
      const storage = makeStorage({ 'team-data/field-exceptions.json': { version: 1, exceptions: [] } })
      expect(fieldExceptionsStore.getException(storage, 'fex_nonexistent')).toBeNull()
    })
  })

  describe('findException', () => {
    it('finds by natural key tuple', () => {
      const storage = makeStorage({
        'team-data/field-exceptions.json': {
          version: 1,
          exceptions: [{ id: 'fex_abc', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'test', createdAt: '2026-01-01', createdBy: 'a@t.com' }]
        }
      })
      expect(fieldExceptionsStore.findException(storage, 'person', 'alice', 'field_f1')).toBeTruthy()
      expect(fieldExceptionsStore.findException(storage, 'person', 'alice', 'field_f2')).toBeNull()
    })
  })

  describe('createException', () => {
    it('creates a new exception with generated ID', () => {
      const storage = storageWithAuditLog()
      const { exception, created } = fieldExceptionsStore.createException(
        storage,
        { entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'test reason' },
        'admin@test.com'
      )
      expect(created).toBe(true)
      expect(exception.id).toMatch(/^fex_[0-9a-f]{8}$/)
      expect(exception.entityType).toBe('person')
      expect(exception.entityId).toBe('alice')
      expect(exception.fieldId).toBe('field_f1')
      expect(exception.reason).toBe('test reason')
      expect(exception.createdBy).toBe('admin@test.com')
      expect(exception.createdAt).toBeTruthy()

      // Verify persisted
      const saved = storage._data['team-data/field-exceptions.json']
      expect(saved.exceptions).toHaveLength(1)
    })

    it('upserts on duplicate tuple', () => {
      const storage = storageWithAuditLog({
        'team-data/field-exceptions.json': {
          version: 1,
          exceptions: [{ id: 'fex_existing', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'old reason', createdAt: '2026-01-01', createdBy: 'old@test.com' }]
        }
      })

      const { exception, created } = fieldExceptionsStore.createException(
        storage,
        { entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'new reason' },
        'admin@test.com'
      )
      expect(created).toBe(false)
      expect(exception.id).toBe('fex_existing') // Same ID
      expect(exception.reason).toBe('new reason')
      expect(exception.createdBy).toBe('admin@test.com')

      // Only one exception
      const saved = storage._data['team-data/field-exceptions.json']
      expect(saved.exceptions).toHaveLength(1)
    })

    it('logs audit entry on create', () => {
      const storage = storageWithAuditLog()
      fieldExceptionsStore.createException(
        storage,
        { entityType: 'team', entityId: 'team_a', fieldId: '__boards__', reason: 'no boards' },
        'admin@test.com'
      )
      const log = storage._data['audit-log.json']
      expect(log.entries).toHaveLength(1)
      expect(log.entries[0].action).toBe('field-exception.create')
    })

    it('logs audit entry on upsert', () => {
      const storage = storageWithAuditLog({
        'team-data/field-exceptions.json': {
          version: 1,
          exceptions: [{ id: 'fex_existing', entityType: 'team', entityId: 'team_a', fieldId: '__boards__', reason: 'old', createdAt: '2026-01-01', createdBy: 'old@t.com' }]
        }
      })
      fieldExceptionsStore.createException(
        storage,
        { entityType: 'team', entityId: 'team_a', fieldId: '__boards__', reason: 'new' },
        'admin@test.com'
      )
      const log = storage._data['audit-log.json']
      expect(log.entries).toHaveLength(1)
      expect(log.entries[0].action).toBe('field-exception.update')
    })
  })

  describe('removeException', () => {
    it('removes an existing exception', () => {
      const storage = storageWithAuditLog({
        'team-data/field-exceptions.json': {
          version: 1,
          exceptions: [{ id: 'fex_abc', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'test', createdAt: '2026-01-01', createdBy: 'a@t.com' }]
        }
      })
      const removed = fieldExceptionsStore.removeException(storage, 'fex_abc', 'admin@test.com')
      expect(removed).toBeTruthy()
      expect(removed.id).toBe('fex_abc')

      const saved = storage._data['team-data/field-exceptions.json']
      expect(saved.exceptions).toHaveLength(0)
    })

    it('returns null for non-existent ID', () => {
      const storage = storageWithAuditLog({ 'team-data/field-exceptions.json': { version: 1, exceptions: [] } })
      const removed = fieldExceptionsStore.removeException(storage, 'fex_nope', 'admin@test.com')
      expect(removed).toBeNull()
    })

    it('logs audit entry on remove', () => {
      const storage = storageWithAuditLog({
        'team-data/field-exceptions.json': {
          version: 1,
          exceptions: [{ id: 'fex_abc', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'test', createdAt: '2026-01-01', createdBy: 'a@t.com' }]
        }
      })
      fieldExceptionsStore.removeException(storage, 'fex_abc', 'admin@test.com')
      const log = storage._data['audit-log.json']
      expect(log.entries).toHaveLength(1)
      expect(log.entries[0].action).toBe('field-exception.remove')
    })
  })

  describe('getExceptionMap', () => {
    it('builds map keyed by entityType:entityId:fieldId', () => {
      const storage = makeStorage({
        'team-data/field-exceptions.json': {
          version: 1,
          exceptions: [
            { id: 'fex_1', entityType: 'person', entityId: 'alice', fieldId: 'field_f1', reason: 'r1', createdAt: '2026-01-01', createdBy: 'a@t.com' },
            { id: 'fex_2', entityType: 'team', entityId: 'team_a', fieldId: '__boards__', reason: 'r2', createdAt: '2026-01-01', createdBy: 'a@t.com' }
          ]
        }
      })
      const map = fieldExceptionsStore.getExceptionMap(storage)
      expect(map.size).toBe(2)
      expect(map.has('person:alice:field_f1')).toBe(true)
      expect(map.has('team:team_a:__boards__')).toBe(true)
      expect(map.has('person:bob:field_f1')).toBe(false)
    })

    it('returns empty map when no exceptions', () => {
      const storage = makeStorage({})
      const map = fieldExceptionsStore.getExceptionMap(storage)
      expect(map.size).toBe(0)
    })
  })
})
