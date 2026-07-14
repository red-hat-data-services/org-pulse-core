import { describe, it, expect } from 'vitest'

const {
  readFieldDefinitions,
  createFieldDefinition,
  updateFieldDefinition,
  softDeleteField,
  reorderFields,
  updatePersonFields
} = require('../field-store');

function createMockStorage(initialData = {}) {
  const store = {};
  for (const [key, val] of Object.entries(initialData)) {
    store[key] = JSON.parse(JSON.stringify(val));
  }
  return {
    async readFromStorage(key) { return store[key] ? JSON.parse(JSON.stringify(store[key])) : null; },
    async writeToStorage(key, data) { store[key] = JSON.parse(JSON.stringify(data)); },
    _store: store
  };
}

describe('createFieldDefinition', () => {
  it('creates a person field definition', async () => {
    const storage = createMockStorage();
    const field = await createFieldDefinition(storage, 'person', {
      label: 'Focus Area',
      type: 'free-text'
    }, 'admin@example.com');

    expect(field.id).toMatch(/^field_[a-f0-9]{6}$/);
    expect(field.label).toBe('Focus Area');
    expect(field.type).toBe('free-text');
    expect(field.deleted).toBe(false);
    expect(field.order).toBe(0);

    const defs = await readFieldDefinitions(storage);
    expect(defs.personFields).toHaveLength(1);
    expect(defs.teamFields).toHaveLength(0);
  });

  it('creates a team field definition', async () => {
    const storage = createMockStorage();
    const field = await createFieldDefinition(storage, 'team', {
      label: 'Product Manager',
      type: 'person-reference-linked'
    }, 'admin@example.com');

    expect(field.label).toBe('Product Manager');
    const defs = await readFieldDefinitions(storage);
    expect(defs.teamFields).toHaveLength(1);
  });

  it('auto-increments order', async () => {
    const storage = createMockStorage();
    await createFieldDefinition(storage, 'person', { label: 'First' }, 'admin@example.com');
    const second = await createFieldDefinition(storage, 'person', { label: 'Second' }, 'admin@example.com');
    expect(second.order).toBe(1);
  });

  it('writes audit log entry', async () => {
    const storage = createMockStorage();
    await createFieldDefinition(storage, 'person', { label: 'Test' }, 'admin@example.com');
    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries[0].action).toBe('field.create');
  });
});

describe('updateFieldDefinition', () => {
  it('updates allowed properties', async () => {
    const storage = createMockStorage({
      'team-data/field-definitions.json': {
        personFields: [{ id: 'field_abc', label: 'Old', type: 'free-text', visible: true, order: 0, deleted: false }],
        teamFields: []
      }
    });

    const result = await updateFieldDefinition(storage, 'person', 'field_abc', {
      label: 'New',
      visible: false
    }, 'admin@example.com');

    expect(result.label).toBe('New');
    expect(result.visible).toBe(false);
  });

  it('returns null for non-existent field', async () => {
    const storage = createMockStorage({
      'team-data/field-definitions.json': { personFields: [], teamFields: [] }
    });
    expect(await updateFieldDefinition(storage, 'person', 'field_xxx', { label: 'New' }, 'admin@example.com')).toBeNull();
  });

  it('ignores unknown properties', async () => {
    const storage = createMockStorage({
      'team-data/field-definitions.json': {
        personFields: [{ id: 'field_abc', label: 'Test', type: 'free-text', visible: true, order: 0, deleted: false }],
        teamFields: []
      }
    });

    const result = await updateFieldDefinition(storage, 'person', 'field_abc', {
      label: 'Updated',
      hackerField: 'evil'
    }, 'admin@example.com');

    expect(result.label).toBe('Updated');
    expect(result.hackerField).toBeUndefined();
  });
});

describe('softDeleteField', () => {
  it('marks field as deleted', async () => {
    const storage = createMockStorage({
      'team-data/field-definitions.json': {
        personFields: [{ id: 'field_abc', label: 'Test', deleted: false }],
        teamFields: []
      }
    });

    const result = await softDeleteField(storage, 'person', 'field_abc', 'admin@example.com');
    expect(result.deleted).toBe(true);
  });
});

describe('reorderFields', () => {
  it('reorders fields by provided ID array', async () => {
    const storage = createMockStorage({
      'team-data/field-definitions.json': {
        personFields: [
          { id: 'field_a', label: 'A', order: 0 },
          { id: 'field_b', label: 'B', order: 1 },
          { id: 'field_c', label: 'C', order: 2 }
        ],
        teamFields: []
      }
    });

    await reorderFields(storage, 'person', ['field_c', 'field_a', 'field_b'], 'admin@example.com');

    const defs = await readFieldDefinitions(storage);
    expect(defs.personFields[0].id).toBe('field_c');
    expect(defs.personFields[1].id).toBe('field_a');
    expect(defs.personFields[2].id).toBe('field_b');
  });
});

describe('updatePersonFields', () => {
  it('updates _appFields on a person', async () => {
    const storage = createMockStorage({
      'team-data/registry.json': {
        people: { bsmith: { uid: 'bsmith', name: 'Bob', status: 'active' } }
      }
    });

    const result = await updatePersonFields(storage, 'bsmith', { field_abc: 'backend' }, 'admin@example.com');
    expect(result.field_abc).toBe('backend');

    const reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.bsmith._appFields.field_abc).toBe('backend');
  });

  it('returns null for non-existent person', async () => {
    const storage = createMockStorage({
      'team-data/registry.json': { people: {} }
    });
    expect(await updatePersonFields(storage, 'nobody', { field_abc: 'val' }, 'admin@example.com')).toBeNull();
  });

  it('writes audit log entry per field', async () => {
    const storage = createMockStorage({
      'team-data/registry.json': {
        people: { bsmith: { uid: 'bsmith', name: 'Bob', status: 'active' } }
      }
    });

    await updatePersonFields(storage, 'bsmith', { f1: 'a', f2: 'b' }, 'admin@example.com');
    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries.filter(e => e.action === 'person.field.update')).toHaveLength(2);
  });
});
