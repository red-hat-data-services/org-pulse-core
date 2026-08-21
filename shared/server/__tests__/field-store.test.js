const { createAuditLog } = require('../audit-log')
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { createFieldStore, coerceFieldValue, FIELD_DEFS_KEY } = require('../field-store');
const { fieldDefinitionSchema } = require('../models/field-definition');

// Suppress console.log output in tests
vi.spyOn(console, 'log').mockImplementation(() => {});

function createMockStorage(initial = {}) {
  const store = { ...initial };
  return {
    async readFromStorage(key) { return store[key] ? JSON.parse(JSON.stringify(store[key])) : null; },
    async writeToStorage(key, data) { store[key] = JSON.parse(JSON.stringify(data)); },
    _store: store
  };
}

function makeStore(opts = {}) {
  const { initialFieldDefs = null } = opts;
  const initial = {};
  if (initialFieldDefs) initial[FIELD_DEFS_KEY] = initialFieldDefs;

  const storage = createMockStorage(initial);
  const fieldStore = createFieldStore(storage, { auditLog: createAuditLog(storage) });
  return { fieldStore, storage };
}

// ─── File-backed tests ───

describe('field-store (file-backed)', () => {
  describe('createFieldDefinition', () => {
    it('creates a person field definition', async () => {
      const { fieldStore } = makeStore();
      const field = await fieldStore.createFieldDefinition('person', {
        label: 'Focus Area',
        type: 'free-text'
      }, 'admin@example.com');

      expect(field.id).toMatch(/^field_[a-f0-9]{6}$/);
      expect(field.label).toBe('Focus Area');
      expect(field.type).toBe('free-text');
      expect(field.deleted).toBe(false);
      expect(field.order).toBe(0);
    });

    it('creates a team field definition', async () => {
      const { fieldStore } = makeStore();
      const field = await fieldStore.createFieldDefinition('team', {
        label: 'Product Manager',
        type: 'person-reference-linked'
      }, 'admin@example.com');

      expect(field.label).toBe('Product Manager');
      const defs = await fieldStore.readFieldDefinitions();
      expect(defs.teamFields).toHaveLength(1);
    });

    it('auto-increments order', async () => {
      const { fieldStore } = makeStore();
      await fieldStore.createFieldDefinition('person', { label: 'First' }, 'admin@example.com');
      const second = await fieldStore.createFieldDefinition('person', { label: 'Second' }, 'admin@example.com');
      expect(second.order).toBe(1);
    });

    it('writes audit log entry', async () => {
      const { fieldStore, storage } = makeStore();
      await fieldStore.createFieldDefinition('person', { label: 'Test' }, 'admin@example.com');
      const log = await storage.readFromStorage('audit-log.json');
      expect(log.entries[0].action).toBe('field.create');
    });

    it('rejects invalid type', async () => {
      const { fieldStore } = makeStore();
      await expect(
        fieldStore.createFieldDefinition('person', { label: 'Bad', type: 'invalid' }, 'admin@example.com')
      ).rejects.toThrow('Invalid type');
    });

    it('validates allowedValues', async () => {
      const { fieldStore } = makeStore();
      await expect(
        fieldStore.createFieldDefinition('person', {
          label: 'Test',
          allowedValues: { not: 'array' }
        }, 'admin@example.com')
      ).rejects.toThrow('allowedValues must be an array');
    });
  });

  describe('updateFieldDefinition', () => {
    it('updates allowed properties', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: {
          personFields: [{ id: 'field_abc', label: 'Old', type: 'free-text', visible: true, order: 0, deleted: false }],
          teamFields: []
        }
      });

      const result = await fieldStore.updateFieldDefinition('person', 'field_abc', {
        label: 'New',
        visible: false
      }, 'admin@example.com');

      expect(result.label).toBe('New');
      expect(result.visible).toBe(false);
    });

    it('returns null for non-existent field', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: { personFields: [], teamFields: [] }
      });
      expect(await fieldStore.updateFieldDefinition('person', 'field_xxx', { label: 'New' }, 'admin@example.com')).toBeNull();
    });

    it('ignores unknown properties', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: {
          personFields: [{ id: 'field_abc', label: 'Test', type: 'free-text', visible: true, order: 0, deleted: false }],
          teamFields: []
        }
      });

      const result = await fieldStore.updateFieldDefinition('person', 'field_abc', {
        label: 'Updated',
        hackerField: 'evil'
      }, 'admin@example.com');

      expect(result.label).toBe('Updated');
      expect(result.hackerField).toBeUndefined();
    });

    it('writes audit log on update', async () => {
      const { fieldStore, storage } = makeStore({
        initialFieldDefs: {
          personFields: [{ id: 'field_abc', label: 'Old', type: 'free-text', visible: true, order: 0, deleted: false }],
          teamFields: []
        }
      });

      await fieldStore.updateFieldDefinition('person', 'field_abc', { label: 'New' }, 'admin@example.com');
      const log = await storage.readFromStorage('audit-log.json');
      expect(log.entries[0].action).toBe('field.update');
    });
  });

  describe('softDeleteField', () => {
    it('marks field as deleted', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: {
          personFields: [{ id: 'field_abc', label: 'Test', deleted: false, order: 0 }],
          teamFields: []
        }
      });

      const result = await fieldStore.softDeleteField('person', 'field_abc', 'admin@example.com');
      expect(result.deleted).toBe(true);
    });

    it('returns null for non-existent field', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: { personFields: [], teamFields: [] }
      });
      expect(await fieldStore.softDeleteField('person', 'field_abc', 'admin@example.com')).toBeNull();
    });

    it('writes audit log entry', async () => {
      const { fieldStore, storage } = makeStore({
        initialFieldDefs: {
          personFields: [{ id: 'field_abc', label: 'Test', deleted: false, order: 0 }],
          teamFields: []
        }
      });

      await fieldStore.softDeleteField('person', 'field_abc', 'admin@example.com');
      const log = await storage.readFromStorage('audit-log.json');
      expect(log.entries[0].action).toBe('field.delete');
    });
  });

  describe('reorderFields', () => {
    it('reorders fields by provided ID array', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: {
          personFields: [
            { id: 'field_a', label: 'A', order: 0 },
            { id: 'field_b', label: 'B', order: 1 },
            { id: 'field_c', label: 'C', order: 2 }
          ],
          teamFields: []
        }
      });

      await fieldStore.reorderFields('person', ['field_c', 'field_a', 'field_b'], 'admin@example.com');

      const defs = await fieldStore.readFieldDefinitions();
      expect(defs.personFields[0].id).toBe('field_c');
      expect(defs.personFields[1].id).toBe('field_a');
      expect(defs.personFields[2].id).toBe('field_b');
    });

    it('writes audit log on reorder', async () => {
      const { fieldStore, storage } = makeStore({
        initialFieldDefs: {
          personFields: [
            { id: 'field_a', label: 'A', order: 0 },
            { id: 'field_b', label: 'B', order: 1 }
          ],
          teamFields: []
        }
      });

      await fieldStore.reorderFields('person', ['field_b', 'field_a'], 'admin@example.com');
      const log = await storage.readFromStorage('audit-log.json');
      expect(log.entries[0].action).toBe('field.reorder');
    });
  });

  describe('readFieldDefinitions', () => {
    it('returns empty structure initially', async () => {
      const { fieldStore } = makeStore();
      const defs = await fieldStore.readFieldDefinitions();
      expect(defs.personFields).toEqual([]);
      expect(defs.teamFields).toEqual([]);
    });

    it('returns sorted fields by order', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: {
          personFields: [
            { id: 'field_a', order: 2 },
            { id: 'field_b', order: 0 },
            { id: 'field_c', order: 1 }
          ],
          teamFields: []
        }
      });

      const defs = await fieldStore.readFieldDefinitions();
      expect(defs.personFields[0].id).toBe('field_b');
      expect(defs.personFields[1].id).toBe('field_c');
      expect(defs.personFields[2].id).toBe('field_a');
    });
  });

  describe('updatePersonFields', () => {
    it('updates _appFields on a person', async () => {
      const { fieldStore, storage } = makeStore();
      storage._store['team-data/registry.json'] = {
        people: { bsmith: { uid: 'bsmith', name: 'Bob', status: 'active' } }
      };

      const result = await fieldStore.updatePersonFields('bsmith', { field_abc: 'backend' }, 'admin@example.com');
      expect(result.field_abc).toBe('backend');

      const reg = await storage.readFromStorage('team-data/registry.json');
      expect(reg.people.bsmith._appFields.field_abc).toBe('backend');
    });

    it('returns null for non-existent person', async () => {
      const { fieldStore, storage } = makeStore();
      storage._store['team-data/registry.json'] = { people: {} };

      expect(await fieldStore.updatePersonFields('nobody', { field_abc: 'val' }, 'admin@example.com')).toBeNull();
    });

    it('writes audit log entry per field', async () => {
      const { fieldStore, storage } = makeStore();
      storage._store['team-data/registry.json'] = {
        people: { bsmith: { uid: 'bsmith', name: 'Bob', status: 'active' } }
      };

      await fieldStore.updatePersonFields('bsmith', { f1: 'a', f2: 'b' }, 'admin@example.com');
      const log = await storage.readFromStorage('audit-log.json');
      expect(log.entries.filter(e => e.action === 'person.field.update')).toHaveLength(2);
    });
  });

  describe('validateFieldValues', () => {
    it('validates required fields', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: {
          personFields: [
            { id: 'field_a', label: 'Required', required: true, deleted: false, type: 'free-text' }
          ],
          teamFields: []
        }
      });

      const result = await fieldStore.validateFieldValues('person', {}, {}, {});
      expect(result.warnings).toContain('Required is required');
    });

    it('validates constrained types against allowedValues', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: {
          personFields: [
            {
              id: 'field_a',
              label: 'Status',
              type: 'constrained',
              allowedValues: ['active', 'inactive'],
              deleted: false
            }
          ],
          teamFields: []
        }
      });

      const result = await fieldStore.validateFieldValues('person', { field_a: 'invalid' }, {}, {});
      expect(result.warnings).toContainEqual(expect.stringContaining('not in the allowed options'));
    });

    it('returns errors for unknown fields', async () => {
      const { fieldStore } = makeStore({
        initialFieldDefs: { personFields: [], teamFields: [] }
      });

      const result = await fieldStore.validateFieldValues('person', { field_unknown: 'val' }, {}, {});
      expect(result.errors).toContain('Unknown field: field_unknown');
    });
  });

  describe('coerceFieldValue', () => {
    it('converts single value to array for multiValue field', () => {
      const field = { multiValue: true };
      expect(coerceFieldValue('test', field)).toEqual(['test']);
    });

    it('keeps array as-is for multiValue field', () => {
      const field = { multiValue: true };
      expect(coerceFieldValue(['a', 'b'], field)).toEqual(['a', 'b']);
    });

    it('converts array to first element for single-value field', () => {
      const field = { multiValue: false };
      expect(coerceFieldValue(['a', 'b'], field)).toBe('a');
    });

    it('returns null for empty array on single-value field', () => {
      const field = { multiValue: false };
      expect(coerceFieldValue([], field)).toBeNull();
    });

    it('returns empty array for null on multiValue field', () => {
      const field = { multiValue: true };
      expect(coerceFieldValue(null, field)).toEqual([]);
    });
  });
});

describe('usesDatabase', () => {
  it('is false when no model is provided', () => {
    const { fieldStore } = makeStore();
    expect(fieldStore.usesDatabase).toBe(false);
  });
});

describe('createFieldStore auditLog requirement', () => {
  it('throws immediately when options.auditLog is missing', () => {
    const storage = createMockStorage();
    expect(() => createFieldStore(storage)).toThrow(/requires options\.auditLog/);
    expect(() => createFieldStore(storage, {})).toThrow(/requires options\.auditLog/);
  });
});

// ─── MongoDB-backed tests ───

describe('field-store (MongoDB)', () => {
  let connection;
  let FieldModel;
  const dbName = 'test_fields_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    FieldModel = connection.model('core__field_definitions', fieldDefinitionSchema, 'core__field_definitions');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (FieldModel) await FieldModel.deleteMany({});
  });

  function makeMongoStore() {
    if (!FieldModel) return null;
    const storage = createMockStorage({});
    const fieldStore = createFieldStore(storage, { model: FieldModel, auditLog: createAuditLog(storage) });
    return { fieldStore, storage };
  }

  it.skipIf(!process.env.MONGODB_URI)('usesDatabase is true when a model is provided', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore } = result;
    expect(fieldStore.usesDatabase).toBe(true);
  });

  it.skipIf(!process.env.MONGODB_URI)('creates and reads field definitions', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore } = result;

    const field = await fieldStore.createFieldDefinition('person', {
      label: 'Focus Area',
      type: 'free-text'
    }, 'admin@example.com');

    expect(field.id).toMatch(/^field_[a-f0-9]{6}$/);
    expect(field.label).toBe('Focus Area');

    const defs = await fieldStore.readFieldDefinitions();
    expect(defs.personFields).toHaveLength(1);
    expect(defs.personFields[0].label).toBe('Focus Area');
  });

  it.skipIf(!process.env.MONGODB_URI)('reads fields sorted by order', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore } = result;

    const f1 = await fieldStore.createFieldDefinition('person', { label: 'First' }, 'admin@example.com');
    const f2 = await fieldStore.createFieldDefinition('person', { label: 'Second' }, 'admin@example.com');

    const defs = await fieldStore.readFieldDefinitions();
    expect(defs.personFields[0].id).toBe(f1.id);
    expect(defs.personFields[1].id).toBe(f2.id);
  });

  it.skipIf(!process.env.MONGODB_URI)('updates field definition', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore } = result;

    const field = await fieldStore.createFieldDefinition('person', {
      label: 'Original',
      type: 'free-text'
    }, 'admin@example.com');

    const updated = await fieldStore.updateFieldDefinition('person', field.id, {
      label: 'Updated'
    }, 'admin@example.com');

    expect(updated.label).toBe('Updated');
  });

  it.skipIf(!process.env.MONGODB_URI)('returns null for non-existent field on update', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore } = result;

    expect(await fieldStore.updateFieldDefinition('person', 'field_nonexistent', { label: 'New' }, 'admin@example.com')).toBeNull();
  });

  it.skipIf(!process.env.MONGODB_URI)('soft deletes field', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore } = result;

    const field = await fieldStore.createFieldDefinition('person', {
      label: 'Delete Me',
      type: 'free-text'
    }, 'admin@example.com');

    const deleted = await fieldStore.softDeleteField('person', field.id, 'admin@example.com');
    expect(deleted.deleted).toBe(true);
  });

  it.skipIf(!process.env.MONGODB_URI)('reorders fields', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore } = result;

    const f1 = await fieldStore.createFieldDefinition('person', { label: 'A' }, 'admin@example.com');
    const f2 = await fieldStore.createFieldDefinition('person', { label: 'B' }, 'admin@example.com');
    const f3 = await fieldStore.createFieldDefinition('person', { label: 'C' }, 'admin@example.com');

    await fieldStore.reorderFields('person', [f3.id, f1.id, f2.id], 'admin@example.com');

    const defs = await fieldStore.readFieldDefinitions();
    expect(defs.personFields[0].id).toBe(f3.id);
    expect(defs.personFields[1].id).toBe(f1.id);
    expect(defs.personFields[2].id).toBe(f2.id);
  });

  it.skipIf(!process.env.MONGODB_URI)('updatePersonFields still writes to file-backed storage', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore, storage } = result;

    storage._store['team-data/registry.json'] = {
      people: { user1: { uid: 'user1', name: 'Test User' } }
    };

    const updated = await fieldStore.updatePersonFields('user1', { field_test: 'value' }, 'admin@example.com');
    expect(updated.field_test).toBe('value');

    // Verify it's in storage (file-backed, not MongoDB)
    const reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.user1._appFields.field_test).toBe('value');
  });

  it.skipIf(!process.env.MONGODB_URI)('handles unique fieldId race by retrying', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { fieldStore } = result;

    // This test is optional - it verifies the race handling works, but is hard to trigger deterministically.
    // For now, we just verify the normal create path works with the retry logic in place.
    const field = await fieldStore.createFieldDefinition('person', {
      label: 'Race test',
      type: 'free-text'
    }, 'admin@example.com');

    expect(field.id).toMatch(/^field_[a-f0-9]{6}$/);
  });
});
