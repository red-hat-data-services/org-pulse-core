import { describe, it, expect } from 'vitest'

const {
  createTeam,
  renameTeam,
  deleteTeam,
  assignMember,
  assignMembersBulk,
  unassignMember,
  getUnassigned,
  updateTeamFields,
  updateTeamBoards,
  extractBoardId
} = require('../team-store');

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
    const team = await createTeam(storage, 'Platform', 'achen', 'admin@example.com');
    expect(team.id).toMatch(/^team_[a-f0-9]{6}$/);
    expect(team.name).toBe('Platform');
    expect(team.orgKey).toBe('achen');
    expect(team.createdBy).toBe('admin@example.com');
    expect(team.metadata).toEqual({});
  });

  it('writes audit log entry', async () => {
    const storage = createMockStorage({ 'team-data/teams.json': { teams: {} } });
    await createTeam(storage, 'Platform', 'achen', 'admin@example.com');
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
    const result = await renameTeam(storage, 'team_abc123', 'New', 'admin@example.com');
    expect(result.name).toBe('New');
  });

  it('returns null for non-existent team', async () => {
    const storage = createMockStorage({ 'team-data/teams.json': { teams: {} } });
    expect(await renameTeam(storage, 'team_xxx', 'New', 'admin@example.com')).toBeNull();
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

    const result = await deleteTeam(storage, 'team_abc', 'admin@example.com');
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

    const result = await assignMember(storage, 'team_abc', 'bsmith', 'admin@example.com');
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

    const result = await assignMember(storage, 'team_abc', 'bsmith', 'admin@example.com');
    expect(result.skipped).toBe(true);
  });

  it('returns error for non-existent team', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: {} },
      'team-data/registry.json': baseRegistry
    });
    const result = await assignMember(storage, 'team_xxx', 'bsmith', 'admin@example.com');
    expect(result.error).toBeTruthy();
  });
});

describe('assignMembersBulk', () => {
  it('assigns multiple people', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } },
      'team-data/registry.json': baseRegistry
    });

    const result = await assignMembersBulk(storage, 'team_abc', ['bsmith', 'cwilliams'], 'admin@example.com');
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

    const result = await assignMembersBulk(storage, 'team_abc', ['bsmith', 'cwilliams', 'nonexistent'], 'admin@example.com');
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

    const result = await unassignMember(storage, 'team_abc', 'bsmith', 'admin@example.com');
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
    const result = getUnassigned(storage, 'all', null, true, managerMap, reg);
    expect(result.map(p => p.uid).sort()).toEqual(['achen', 'cwilliams']);
  });

  it('returns direct reports for scope=direct', () => {
    const storage = createMockStorage();
    const result = getUnassigned(storage, 'direct', 'achen', false, managerMap, reg);
    expect(result.map(p => p.uid)).toEqual(['cwilliams']);
  });

  it('returns org subtree for scope=org', () => {
    const storage = createMockStorage();
    const result = getUnassigned(storage, 'org', 'achen', false, managerMap, reg);
    expect(result.map(p => p.uid)).toEqual(['cwilliams']);
  });

  it('returns empty for non-admin with scope=all', () => {
    const storage = createMockStorage();
    const result = getUnassigned(storage, 'all', 'achen', false, managerMap, reg);
    expect(result).toHaveLength(0);
  });

  it('returns empty for invalid scope value', () => {
    const storage = createMockStorage();
    const result = getUnassigned(storage, 'invalid', 'achen', true, managerMap, reg);
    expect(result).toHaveLength(0);
  });
});

describe('updateTeamFields', () => {
  it('updates team metadata fields', async () => {
    const storage = createMockStorage({
      'team-data/teams.json': { teams: { team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} } } }
    });

    const result = await updateTeamFields(storage, 'team_abc', { field_1: 'value1' }, 'admin@example.com');
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
    const result = await updateTeamBoards(storage, 'team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'Platform' }
    ], 'admin@example.com');
    expect(result[0].boardId).toBe(123);
  });

  it('auto-extracts boardId from rapidView URL', async () => {
    const storage = createMockStorage(teamData);
    const result = await updateTeamBoards(storage, 'team_abc', [
      { url: 'https://issues.redhat.com/secure/RapidBoard.jspa?rapidView=42', name: 'Legacy' }
    ], 'admin@example.com');
    expect(result[0].boardId).toBe(42);
  });

  it('uses explicit boardId over auto-extracted', async () => {
    const storage = createMockStorage(teamData);
    const result = await updateTeamBoards(storage, 'team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'Platform', boardId: 999 }
    ], 'admin@example.com');
    expect(result[0].boardId).toBe(999);
  });

  it('sets boardId to null when URL has no recognizable pattern', async () => {
    const storage = createMockStorage(teamData);
    const result = await updateTeamBoards(storage, 'team_abc', [
      { url: 'https://example.com/some-page', name: 'Unknown' }
    ], 'admin@example.com');
    expect(result[0].boardId).toBeNull();
  });

  it('preserves sprintFilter when provided', async () => {
    const storage = createMockStorage(teamData);
    const result = await updateTeamBoards(storage, 'team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'Backend', sprintFilter: 'Backend' }
    ], 'admin@example.com');
    expect(result[0].sprintFilter).toBe('Backend');
  });

  it('omits sprintFilter when empty or whitespace', async () => {
    const storage = createMockStorage(teamData);
    const result = await updateTeamBoards(storage, 'team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'All', sprintFilter: '  ' }
    ], 'admin@example.com');
    expect(result[0].sprintFilter).toBeUndefined();
  });

  it('trims sprintFilter whitespace', async () => {
    const storage = createMockStorage(teamData);
    const result = await updateTeamBoards(storage, 'team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'FE', sprintFilter: '  Frontend  ' }
    ], 'admin@example.com');
    expect(result[0].sprintFilter).toBe('Frontend');
  });

  it('writes audit log with board details', async () => {
    const storage = createMockStorage(teamData);
    await updateTeamBoards(storage, 'team_abc', [
      { url: 'https://redhat.atlassian.net/jira/software/projects/RHOAIENG/boards/123', name: 'Platform', sprintFilter: 'Backend' }
    ], 'admin@example.com');
    const log = await storage.readFromStorage('audit-log.json');
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe('team.boards.update');
    expect(log.entries[0].newValue[0].boardId).toBe(123);
    expect(log.entries[0].newValue[0].sprintFilter).toBe('Backend');
  });
});
