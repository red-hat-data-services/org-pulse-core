const { createAuditLog } = require('../audit-log')
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import mongoose from 'mongoose'

const { createTeamStore, extractBoardId } = require('../team-store');
const { teamSchema } = require('../models/team');

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

const baseRegistry = {
  people: {
    achen: { uid: 'achen', name: 'Alice Chen', email: 'achen@example.com', status: 'active', managerUid: 'demovp', orgRoot: 'achen' },
    bsmith: { uid: 'bsmith', name: 'Bob Smith', email: 'bsmith@example.com', status: 'active', managerUid: 'achen', orgRoot: 'achen' },
    cwilliams: { uid: 'cwilliams', name: 'Carol', email: 'cwilliams@example.com', status: 'active', managerUid: 'achen', orgRoot: 'achen' },
    inactive: { uid: 'inactive', name: 'Gone', email: 'gone@example.com', status: 'inactive', managerUid: 'achen', orgRoot: 'achen' }
  }
};

describe('createTeam', () => {
  it('creates a team with generated ID', async () => {
    const storage = createMockStorage({ 'team-data/teams.json': { teams: {} } });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    expect(team.id).toMatch(/^team_[a-f0-9]{6}$/);
    expect(team.name).toBe('Platform');
    expect(team.orgKey).toBe('achen');
    expect(team.createdBy).toBe('admin@example.com');
    expect(team.metadata).toEqual({});
  });

  it('writes audit log entry', async () => {
    const storage = createMockStorage({ 'team-data/teams.json': { teams: {} } });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe('team.create');
  });
});

describe('renameTeam', () => {
  it('renames an existing team', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc123: { id: 'team_abc123', name: 'Old', orgKey: 'achen', metadata: {} } } }
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.renameTeam('team_abc123', 'New', 'admin@example.com');
    expect(result.name).toBe('New');
  });

  it('returns null for non-existent team', async () => {
    const storage = createMockStorage({ 'team-data/teams.json': { teams: {} } });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    expect(await teamStore.renameTeam('team_xxx', 'New', 'admin@example.com')).toBeNull();
  });
});

describe('deleteTeam', () => {
  it('deletes a team and removes from person teamIds', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } },
      'team-data/registry.json': {
        people: {
          bsmith: { uid: 'bsmith', name: 'Bob', status: 'active', teamIds: ['team_abc', 'team_other'] }
        }
      }
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });

    const result = await teamStore.deleteTeam('team_abc', 'admin@example.com');
    expect(result.name).toBe('Platform');

    const teams = await storage.readFromStorage('team-data/teams.json');
    expect(teams.teams.team_abc).toBeUndefined();

    const reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.bsmith.teamIds).toEqual(['team_other']);
  });
});

describe('assignMember', () => {
  it('assigns a person to a team', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } },
      'team-data/registry.json': baseRegistry
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });

    const result = await teamStore.assignMember('team_abc', 'bsmith', 'admin@example.com');
    expect(result.assigned).toBe(true);

    const reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.bsmith.teamIds).toContain('team_abc');
  });

  it('skips if already assigned', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } },
      'team-data/registry.json': {
        people: { bsmith: { uid: 'bsmith', name: 'Bob', status: 'active', teamIds: ['team_abc'] } }
      }
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });

    const result = await teamStore.assignMember('team_abc', 'bsmith', 'admin@example.com');
    expect(result.skipped).toBe(true);
  });

  it('returns error for non-existent team', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: {} },
      'team-data/registry.json': baseRegistry
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.assignMember('team_xxx', 'bsmith', 'admin@example.com');
    expect(result.error).toBeTruthy();
  });
});

describe('assignMembersBulk', () => {
  it('assigns multiple people', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } },
      'team-data/registry.json': baseRegistry
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });

    const result = await teamStore.assignMembersBulk('team_abc', ['bsmith', 'cwilliams'], 'admin@example.com');
    expect(result.assigned).toEqual(['bsmith', 'cwilliams']);
    expect(result.skipped).toEqual([]);
  });

  it('skips already-assigned and non-existent', async () => {
    const reg = JSON.parse(JSON.stringify(baseRegistry));
    reg.people.bsmith.teamIds = ['team_abc'];
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } },
      'team-data/registry.json': reg
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });

    const result = await teamStore.assignMembersBulk('team_abc', ['bsmith', 'cwilliams', 'nonexistent'], 'admin@example.com');
    expect(result.assigned).toEqual(['cwilliams']);
    expect(result.skipped).toEqual(['bsmith', 'nonexistent']);
  });
});

describe('unassignMember', () => {
  it('removes team from person teamIds', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } },
      'team-data/registry.json': {
        people: { bsmith: { uid: 'bsmith', name: 'Bob', status: 'active', teamIds: ['team_abc'] } }
      }
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });

    const result = await teamStore.unassignMember('team_abc', 'bsmith', 'admin@example.com');
    expect(result.unassigned).toBe(true);

    const reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.bsmith.teamIds).toEqual([]);
  });
});

describe('getUnassigned', () => {
  const { buildManagerMap } = require('../permissions');
  const reg = JSON.parse(JSON.stringify(baseRegistry));
  reg.people.bsmith.teamIds = ['team_abc'];
  const managerMap = buildManagerMap(reg);

  it('returns all unassigned for admin with scope=all', () => {
    const storage = createMockStorage();
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = teamStore.getUnassigned('all', null, true, managerMap, reg);
    expect(result.map(p => p.uid).sort()).toEqual(['achen', 'cwilliams']);
  });

  it('returns direct reports for scope=direct', () => {
    const storage = createMockStorage();
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = teamStore.getUnassigned('direct', 'achen', false, managerMap, reg);
    expect(result.map(p => p.uid)).toEqual(['cwilliams']);
  });

  it('returns org subtree for scope=org', () => {
    const storage = createMockStorage();
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = teamStore.getUnassigned('org', 'achen', false, managerMap, reg);
    expect(result.map(p => p.uid)).toEqual(['cwilliams']);
  });

  it('returns empty for non-admin with scope=all', () => {
    const storage = createMockStorage();
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = teamStore.getUnassigned('all', 'achen', false, managerMap, reg);
    expect(result).toHaveLength(0);
  });

  it('returns empty for invalid scope value', () => {
    const storage = createMockStorage();
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = teamStore.getUnassigned('invalid', 'achen', true, managerMap, reg);
    expect(result).toHaveLength(0);
  });
});

describe('updateTeamFields', () => {
  it('updates team metadata fields', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } }
    });
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });

    const result = await teamStore.updateTeamFields('team_abc', { field_1: 'value1' }, 'admin@example.com');
    expect(result.metadata.field_1).toBe('value1');
  });
});

describe('extractBoardId', () => {
  it('extracts from Jira Cloud /boards/ URL', () => {
    expect(extractBoardId('https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123')).toBe(123);
  });

  it('extracts from Jira Cloud /board/ URL (singular)', () => {
    expect(extractBoardId('https://redhat.atlassian.net/jira/software/projects/RHOAIENG/board/456')).toBe(456);
  });

  it('extracts from company-managed project URL with /c/ prefix', () => {
    expect(extractBoardId('https://redhat.atlassian.net/jira/software/c/projects/AIPCC/boards/789')).toBe(789);
  });

  it('extracts from Jira Server/DC rapidView URL', () => {
    expect(extractBoardId('https://issues.redhat.com/secure/RapidBoard.jspa?rapidView=42')).toBe(42);
  });

  it('extracts rapidView with other query params', () => {
    expect(extractBoardId('https://issues.redhat.com/secure/RapidBoard.jspa?projectKey=FOO&rapidView=99&view=detail')).toBe(99);
  });

  it('returns null for non-Jira URLs', () => {
    expect(extractBoardId('https://example.com/some-page')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(extractBoardId(null)).toBeNull();
    expect(extractBoardId(undefined)).toBeNull();
    expect(extractBoardId(123)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractBoardId('')).toBeNull();
  });
});

describe('updateTeamBoards', () => {
  const teamData = {
    'team-data/teams.json': {
      teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {}, boards: [] } }
    }
  };

  it('auto-extracts boardId from Jira Cloud URL', async () => {
    const storage = createMockStorage(teamData);
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.updateTeamBoards('team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'Platform' }
    ], 'admin@example.com');
    expect(result[0].boardId).toBe(123);
  });

  it('auto-extracts boardId from rapidView URL', async () => {
    const storage = createMockStorage(teamData);
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.updateTeamBoards('team_abc', [
      { url: 'https://issues.redhat.com/secure/RapidBoard.jspa?rapidView=42', name: 'Legacy' }
    ], 'admin@example.com');
    expect(result[0].boardId).toBe(42);
  });

  it('uses explicit boardId over auto-extracted', async () => {
    const storage = createMockStorage(teamData);
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.updateTeamBoards('team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'Platform', boardId: 999 }
    ], 'admin@example.com');
    expect(result[0].boardId).toBe(999);
  });

  it('sets boardId to null when URL has no recognizable pattern', async () => {
    const storage = createMockStorage(teamData);
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.updateTeamBoards('team_abc', [
      { url: 'https://example.com/some-page', name: 'Unknown' }
    ], 'admin@example.com');
    expect(result[0].boardId).toBeNull();
  });

  it('preserves sprintFilter when provided', async () => {
    const storage = createMockStorage(teamData);
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.updateTeamBoards('team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'Backend', sprintFilter: 'Backend' }
    ], 'admin@example.com');
    expect(result[0].sprintFilter).toBe('Backend');
  });

  it('omits sprintFilter when empty or whitespace', async () => {
    const storage = createMockStorage(teamData);
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.updateTeamBoards('team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'All', sprintFilter: '  ' }
    ], 'admin@example.com');
    expect(result[0].sprintFilter).toBeUndefined();
  });

  it('trims sprintFilter whitespace', async () => {
    const storage = createMockStorage(teamData);
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    const result = await teamStore.updateTeamBoards('team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'FE', sprintFilter: '  Frontend  ' }
    ], 'admin@example.com');
    expect(result[0].sprintFilter).toBe('Frontend');
  });

  it('writes audit log with board details', async () => {
    const storage = createMockStorage(teamData);
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    await teamStore.updateTeamBoards('team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'Platform', sprintFilter: 'Backend' }
    ], 'admin@example.com');
    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe('team.boards.update');
    expect(log.entries[0].newValue[0].boardId).toBe(123);
    expect(log.entries[0].newValue[0].sprintFilter).toBe('Backend');
  });
});

describe('usesDatabase', () => {
  it('is false when no model is provided', () => {
    const storage = createMockStorage({});
    const teamStore = createTeamStore(storage, { auditLog: createAuditLog(storage) });
    expect(teamStore.usesDatabase).toBe(false);
  });
});

describe('createTeamStore auditLog requirement', () => {
  it('throws immediately when options.auditLog is missing', () => {
    const storage = createMockStorage({});
    expect(() => createTeamStore(storage)).toThrow(/requires options\.auditLog/);
    expect(() => createTeamStore(storage, {})).toThrow(/requires options\.auditLog/);
  });
});

// ─── MongoDB-backed tests ───

describe('team-store (MongoDB)', () => {
  let connection;
  let TeamModel;
  const dbName = 'test_teams_' + process.pid;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return;
    connection = await mongoose.createConnection(uri, { dbName });
    TeamModel = connection.model('core__teams', teamSchema, 'core__teams');
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase();
      await connection.close();
    }
  });

  beforeEach(async () => {
    if (TeamModel) await TeamModel.deleteMany({});
  });

  function makeMongoStore() {
    if (!TeamModel) return null;
    const storage = createMockStorage({});
    const teamStore = createTeamStore(storage, { model: TeamModel, auditLog: createAuditLog(storage) });
    return { teamStore, storage };
  }

  it.skipIf(!process.env.MONGODB_URI)('creates and reads a team', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    expect(team.id).toMatch(/^team_[a-f0-9]{6}$/);
    expect(team.name).toBe('Platform');
    expect(team.orgKey).toBe('achen');
    expect(team.metadata).toEqual({});
    expect(team.boards).toEqual([]);

    const data = await teamStore.readTeams();
    expect(data.teams[team.id]).toBeTruthy();
    expect(data.teams[team.id].name).toBe('Platform');
  });

  it.skipIf(!process.env.MONGODB_URI)('renames a team', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;

    const team = await teamStore.createTeam('Old', 'achen', 'admin@example.com');
    const renamed = await teamStore.renameTeam(team.id, 'New', 'admin@example.com');
    expect(renamed.name).toBe('New');

    const data = await teamStore.readTeams();
    expect(data.teams[team.id].name).toBe('New');
  });

  it.skipIf(!process.env.MONGODB_URI)('returns null renaming a non-existent team', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;
    expect(await teamStore.renameTeam('team_missing', 'New', 'admin@example.com')).toBeNull();
  });

  it.skipIf(!process.env.MONGODB_URI)('updates a team description', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    const updated = await teamStore.updateTeamDescription(team.id, 'Backend services', 'admin@example.com');
    expect(updated.description).toBe('Backend services');

    const data = await teamStore.readTeams();
    expect(data.teams[team.id].description).toBe('Backend services');
  });

  it.skipIf(!process.env.MONGODB_URI)('deletes a team', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    const deleted = await teamStore.deleteTeam(team.id, 'admin@example.com');
    expect(deleted).toEqual({ id: team.id, name: 'Platform' });

    const data = await teamStore.readTeams();
    expect(data.teams[team.id]).toBeUndefined();
  });

  it.skipIf(!process.env.MONGODB_URI)('writeTeams throws on the MongoDB path', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;
    await expect(teamStore.writeTeams({ teams: {} })).rejects.toThrow(/not supported/);
  });

  it.skipIf(!process.env.MONGODB_URI)('usesDatabase is true when a model is provided', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;
    expect(teamStore.usesDatabase).toBe(true);
  });

  it.skipIf(!process.env.MONGODB_URI)('regenerates the team ID and retries on a duplicate key error', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;

    // Force the first generated id to collide with a pre-existing team.
    await TeamModel.create({
      teamId: 'team_aaaaaa',
      name: 'Existing',
      orgKey: 'achen',
      metadata: {},
      boards: []
    });

    const crypto = require('crypto');
    const spy = vi.spyOn(crypto, 'randomBytes')
      .mockReturnValueOnce(Buffer.from('aaaaaa', 'hex')) // initial id -> collides
      .mockReturnValueOnce(Buffer.from('bbbbbb', 'hex')); // retry -> succeeds

    try {
      const team = await teamStore.createTeam('New Team', 'achen', 'admin@example.com');
      expect(team.id).toBe('team_bbbbbb');
    } finally {
      spy.mockRestore();
    }

    const count = await TeamModel.countDocuments({});
    expect(count).toBe(2);
  });

  it.skipIf(!process.env.MONGODB_URI)('assignMember reads the team from MongoDB and writes the registry file', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore, storage } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    storage._store['team-data/registry.json'] = {
      people: { achen: { uid: 'achen', name: 'Alice Chen', teamIds: [] } }
    };

    const res = await teamStore.assignMember(team.id, 'achen', 'admin@example.com');
    expect(res).toEqual({ assigned: true });

    const reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.achen.teamIds).toEqual([team.id]);
  });

  it.skipIf(!process.env.MONGODB_URI)('assignMember returns an error when the team is not in MongoDB', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore, storage } = result;
    storage._store['team-data/registry.json'] = {
      people: { achen: { uid: 'achen', name: 'Alice Chen', teamIds: [] } }
    };

    const res = await teamStore.assignMember('team_missing', 'achen', 'admin@example.com');
    expect(res).toEqual({ error: 'Team not found' });
  });

  it.skipIf(!process.env.MONGODB_URI)('unassignMember reads the team from MongoDB and writes the registry file', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore, storage } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    storage._store['team-data/registry.json'] = {
      people: { achen: { uid: 'achen', name: 'Alice Chen', teamIds: [team.id] } }
    };

    const res = await teamStore.unassignMember(team.id, 'achen', 'admin@example.com');
    expect(res).toEqual({ unassigned: true });

    const reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.achen.teamIds).toEqual([]);
  });

  it.skipIf(!process.env.MONGODB_URI)('only one of two concurrent deleteTeam calls reports success', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore, storage } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    storage._store['team-data/registry.json'] = { people: {} };

    const [a, b] = await Promise.all([
      teamStore.deleteTeam(team.id, 'admin@example.com'),
      teamStore.deleteTeam(team.id, 'admin@example.com')
    ]);

    // Exactly one caller removed the document; the other must report null,
    // as the file path does for a team that is already gone.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect([a, b].filter(Boolean)[0]).toEqual({ id: team.id, name: 'Platform' });
  });

  it.skipIf(!process.env.MONGODB_URI)('concurrent updateTeamFields calls on different fields do not clobber each other', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');

    // Both calls read the team, then write. If the write replaced the whole
    // metadata object, the slower writer would drop the other one's field.
    await Promise.all([
      teamStore.updateTeamFields(team.id, { field_a: 'A' }, 'admin@example.com'),
      teamStore.updateTeamFields(team.id, { field_b: 'B' }, 'admin@example.com')
    ]);

    const data = await teamStore.readTeams();
    expect(data.teams[team.id].metadata).toEqual({ field_a: 'A', field_b: 'B' });
  });

  it.skipIf(!process.env.MONGODB_URI)('updateTeamFields with no fields leaves the team unchanged', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    await teamStore.updateTeamFields(team.id, { field_a: 'A' }, 'admin@example.com');

    const unchanged = await teamStore.updateTeamFields(team.id, {}, 'admin@example.com');
    expect(unchanged.metadata).toEqual({ field_a: 'A' });
  });

  it.skipIf(!process.env.MONGODB_URI)('deleteTeam cleans registry references before deleting the team document', async () => {
    const result = makeMongoStore();
    if (!result) return;
    const { teamStore, storage } = result;

    const team = await teamStore.createTeam('Platform', 'achen', 'admin@example.com');
    storage._store['team-data/registry.json'] = {
      people: { achen: { uid: 'achen', name: 'Alice Chen', teamIds: [team.id] } }
    };

    const callOrder = [];
    const originalWrite = storage.writeToStorage.bind(storage);
    storage.writeToStorage = async (key, data) => {
      if (key === 'team-data/registry.json') callOrder.push('registry-write');
      return originalWrite(key, data);
    };
    const originalDeleteOne = TeamModel.deleteOne.bind(TeamModel);
    const deleteOneSpy = vi.spyOn(TeamModel, 'deleteOne').mockImplementation(async (...args) => {
      callOrder.push('team-delete');
      return originalDeleteOne(...args);
    });

    try {
      await teamStore.deleteTeam(team.id, 'admin@example.com');
    } finally {
      deleteOneSpy.mockRestore();
    }

    expect(callOrder).toEqual(['registry-write', 'team-delete']);

    const reg = await storage.readFromStorage('team-data/registry.json');
    expect(reg.people.achen.teamIds).toEqual([]);

    const data = await teamStore.readTeams();
    expect(data.teams[team.id]).toBeUndefined();
  });
});
