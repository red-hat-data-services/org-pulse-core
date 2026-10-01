const { test, expect } = require('@playwright/test');

test.describe('Cyborg People & Teams deployment @cyborg-people-teams', () => {
  test('runs the roster API with the Cyborg source and enrichment', async ({ request }) => {
    const response = await request.get('/api/modules/team-tracker/roster');
    expect(response.ok()).toBe(true);

    const roster = await response.json();
    expect(roster.teamDataSource).toBe('cyborg');
    expect(Array.isArray(roster.orgs)).toBe(true);

    const teams = roster.orgs.flatMap(org => Object.values(org.teams || {}));
    const members = teams.flatMap(team => team.members || []);
    expect(members.length).toBeGreaterThan(0);

    const alice = members.find(member => member.uid === 'achen');
    expect(alice).toBeDefined();
    expect(Object.values(roster.orgs[0].teams).some(team =>
      team.displayName === 'Platform Core' && team.members.some(member => member.uid === 'achen')
    )).toBe(true);
    expect(alice.repositories).toContain('https://github.com/example/platform-core');
    expect(alice.jira).toEqual([{ project: 'PLAT', boardId: '1001' }]);
    expect(alice.slackChannels).toContain('team-platform-core');

    const orgListResponse = await request.get('/api/modules/team-tracker/org-list');
    expect(orgListResponse.ok()).toBe(true);
    const orgList = await orgListResponse.json();
    expect(orgList.orgs).toEqual([
      { name: 'Fleet Engineering', teamCount: 9, headcount: 10 }
    ]);

    const membersResponse = await request.get(
      `/api/modules/team-tracker/org-teams/${encodeURIComponent('Fleet Engineering::Platform Core')}/members`
    );
    expect(membersResponse.ok()).toBe(true);
    const teamMembers = await membersResponse.json();
    expect(teamMembers.members.map(member => member.uid)).toContain('achen');
  });
});
