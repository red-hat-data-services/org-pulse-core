import { describe, it, expect, vi } from 'vitest';
const { enrichPerson, resolveFieldDefinitions, buildReferencedPeopleMap, buildAllPeopleList } = require('../../server/field-payload');

describe('field-payload utility', () => {
  describe('enrichPerson', () => {
    const fieldDefs = [
      { id: 'f1', label: 'Focus', type: 'free-text' },
      { id: 'f2', label: 'Component', type: 'constrained', multiValue: true }
    ];

    it('populates customFields from _appFields', () => {
      const person = {
        uid: 'alice',
        name: 'Alice',
        email: 'alice@example.com',
        title: 'Engineer',
        teamIds: ['team_a'],
        _appFields: { f1: 'backend', f2: ['ui', 'api'] }
      };
      const result = enrichPerson(person, fieldDefs);
      expect(result.customFields).toEqual({ f1: 'backend', f2: ['ui', 'api'] });
      expect(result.uid).toBe('alice');
      expect(result.name).toBe('Alice');
    });

    it('returns null for missing _appFields values', () => {
      const person = { uid: 'bob', name: 'Bob', email: 'bob@x.com', title: 'PM', teamIds: [] };
      const result = enrichPerson(person, fieldDefs);
      expect(result.customFields).toEqual({ f1: null, f2: null });
    });

    it('returns null for null person', () => {
      expect(enrichPerson(null, fieldDefs)).toBeNull();
    });

    it('includes managerUid when option is set', () => {
      const person = { uid: 'alice', name: 'Alice', managerUid: 'mgr1' };
      const result = enrichPerson(person, fieldDefs, { includeManagerUid: true });
      expect(result.managerUid).toBe('mgr1');
    });

    it('omits managerUid by default', () => {
      const person = { uid: 'alice', name: 'Alice', managerUid: 'mgr1' };
      const result = enrichPerson(person, fieldDefs);
      expect(result.managerUid).toBeUndefined();
    });
  });

  describe('resolveFieldDefinitions', () => {
    it('resolves optionsRef to allowedValues', () => {
      const storage = {};
      const mockFieldStore = require('../../../../shared/server/field-store');
      vi.spyOn(mockFieldStore, 'readFieldDefinitions').mockReturnValue({
        personFields: [
          { id: 'f1', label: 'Component', type: 'constrained', optionsRef: 'component', deleted: false }
        ],
        teamFields: [
          { id: 'f2', label: 'Status', type: 'free-text', deleted: false }
        ]
      });

      const resolver = (ref) => ref === 'component' ? ['a', 'b', 'c'] : null;
      const { personFieldDefs, teamFieldDefs } = resolveFieldDefinitions(storage, resolver);

      expect(personFieldDefs[0].allowedValues).toEqual(['a', 'b', 'c']);
      expect(personFieldDefs[0]._resolvedFromOptions).toBe(true);
      expect(teamFieldDefs).toHaveLength(1);

      mockFieldStore.readFieldDefinitions.mockRestore();
    });

    it('filters out deleted fields', () => {
      const storage = {};
      const mockFieldStore = require('../../../../shared/server/field-store');
      vi.spyOn(mockFieldStore, 'readFieldDefinitions').mockReturnValue({
        personFields: [
          { id: 'f1', label: 'Active', deleted: false },
          { id: 'f2', label: 'Deleted', deleted: true }
        ],
        teamFields: []
      });

      const { personFieldDefs } = resolveFieldDefinitions(storage, () => null);
      expect(personFieldDefs).toHaveLength(1);
      expect(personFieldDefs[0].id).toBe('f1');

      mockFieldStore.readFieldDefinitions.mockRestore();
    });
  });

  describe('buildReferencedPeopleMap', () => {
    const teamFieldDefs = [
      { id: 'f1', type: 'person-reference-linked', label: 'PM' },
      { id: 'f2', type: 'free-text', label: 'Notes' }
    ];

    it('builds uid->name map from team metadata person-ref fields', () => {
      const teams = [
        { id: 't1', metadata: { f1: ['uid1', 'uid2'], f2: 'notes' } }
      ];
      const people = {
        uid1: { name: 'Alice' },
        uid2: { name: 'Bob' }
      };
      const result = buildReferencedPeopleMap(teams, teamFieldDefs, people);
      expect(result).toEqual({ uid1: 'Alice', uid2: 'Bob' });
    });

    it('falls back to uid when person not in registry', () => {
      const teams = [{ id: 't1', metadata: { f1: 'unknown_uid' } }];
      const result = buildReferencedPeopleMap(teams, teamFieldDefs, {});
      expect(result).toEqual({ unknown_uid: 'unknown_uid' });
    });

    it('returns empty map when no person-ref fields', () => {
      const teams = [{ id: 't1', metadata: { f2: 'notes' } }];
      const nonRefDefs = [{ id: 'f2', type: 'free-text', label: 'Notes' }];
      const result = buildReferencedPeopleMap(teams, nonRefDefs, {});
      expect(result).toEqual({});
    });

    it('handles null metadata gracefully', () => {
      const teams = [{ id: 't1', metadata: null }];
      const result = buildReferencedPeopleMap(teams, teamFieldDefs, {});
      expect(result).toEqual({});
    });
  });

  describe('buildAllPeopleList', () => {
    it('includes only active people', () => {
      const people = {
        alice: { uid: 'alice', name: 'Alice', title: 'Eng', status: 'active' },
        bob: { uid: 'bob', name: 'Bob', title: 'PM', status: 'inactive' }
      };
      const result = buildAllPeopleList(people);
      expect(result).toHaveLength(1);
      expect(result[0].uid).toBe('alice');
    });

    it('uses uid as fallback name', () => {
      const people = {
        alice: { uid: 'alice', status: 'active' }
      };
      const result = buildAllPeopleList(people);
      expect(result[0].name).toBe('alice');
    });
  });
});
