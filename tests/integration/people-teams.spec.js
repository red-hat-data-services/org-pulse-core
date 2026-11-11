const { test, expect } = require('@playwright/test');
const { DEFAULT_PAGE_WAIT_TIME } = require('./constants');
const { setupErrorTracking, logCapturedErrors, pageHasContent, pageLoadComplete, mainContentIsVisible, countDisabledNavItems } = require('./helpers');

/**
 * Integration tests for People & Teams module
 *
 * These tests verify:
 * - Module loads and renders correctly
 * - Data fetching and display works
 * - Navigation within the module functions
 * - API integration is functional
 *
 * Tag: @people-teams
 * Usage: npx playwright test --grep @people-teams
 */

test.describe('People & Teams Module @people-teams', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  test('should be visible in sidebar navigation', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // Find the People & Teams module in the sidebar
    const moduleNav = page.locator('aside nav').filter({ hasText: 'People & Teams' });
    const count = await moduleNav.count();
    expect(count).toBeGreaterThan(0);

    // Verify the module link is visible and clickable
    const moduleLink = moduleNav.first();
    await expect(moduleLink).toBeVisible();

    expect(page.errors).toHaveLength(0);
  });

  test('should navigate to People & Teams module when clicked', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // Expand the People & Teams module section if it's collapsed
    const moduleHeader = page.locator('aside nav button').filter({ hasText: 'People & Teams' }).first();
    await moduleHeader.click();
    await page.waitForTimeout(500);

    // Click on the "Team Directory" view (default view)
    const viewLink = page.locator('aside nav button').filter({ hasText: 'Team Directory' }).first();
    await viewLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // Verify URL changed to team-tracker module (default view is home)
    expect(page.url()).toMatch(/team-tracker\/home/);

    // Verify main content is visible
    const mainContentVisible = await mainContentIsVisible(page);
    expect(mainContentVisible).toBe(true);

    expect(page.errors).toHaveLength(0);
  });

  test('should fetch data from People & Teams API endpoints', async ({ page }) => {
    // Monitor network requests
    const apiRequests = [];
    page.on('request', request => {
      if (request.url().includes('/api/modules/team-tracker')) {
        apiRequests.push({
          url: request.url(),
          method: request.method()
        });
      }
    });

    // Navigate to Team Directory (makes API calls for teams and people)
    await page.goto('/#/team-tracker/home');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // Verify that API requests were made to the team-tracker endpoints
    // In demo mode, these should still be called and return fixture data
    expect(apiRequests.length).toBeGreaterThan(0);
    console.log(`People & Teams API requests: ${apiRequests.length}`);
    apiRequests.forEach(req => {
      console.log(`  ${req.method} ${req.url}`);
    });

    expect(page.errors).toHaveLength(0);
  });

  test('roster API identifies the configured team data source', async ({ request }) => {
    const response = await request.get('/api/modules/team-tracker/roster');
    expect(response.ok()).toBe(true);

    const roster = await response.json();
    expect(['sheets', 'in-app', 'cyborg']).toContain(roster.teamDataSource);
    expect(Array.isArray(roster.orgs)).toBe(true);
  });

  test('roster API returns the complete people and teams data shape', async ({ request }) => {
    const response = await request.get('/api/modules/team-tracker/roster');
    expect(response.ok()).toBe(true);

    const roster = await response.json();
    const orgs = roster.orgs || [];
    const teams = orgs.flatMap(org => Object.values(org.teams || {}));
    const members = teams.flatMap(team => team.members || []);

    expect(orgs.length).toBeGreaterThan(0);
    expect(teams.length).toBeGreaterThan(0);
    expect(members.length).toBeGreaterThan(0);

    // These are the fields consumed by the Team Directory and People views.
    for (const org of orgs) {
      expect(typeof org.key).toBe('string');
      expect(typeof org.displayName).toBe('string');
      expect(org.teams).toBeDefined();
    }
    for (const team of teams) {
      expect(typeof team.displayName).toBe('string');
      expect(Array.isArray(team.members)).toBe(true);
    }
    for (const member of members) {
      expect(typeof member.uid).toBe('string');
      expect(typeof member.name).toBe('string');
      expect(member).toHaveProperty('email');
      expect(member).toHaveProperty('title');
      expect(member).toHaveProperty('customFields');
    }

    // Cyborg supplies these optional source fields; validate them in a
    // running Cyborg-configured container without constraining other modes.
    if (roster.teamDataSource === 'cyborg') {
      for (const member of members) {
        expect(Array.isArray(member.repositories)).toBe(true);
        expect(Array.isArray(member.jira)).toBe(true);
        expect(Array.isArray(member.slackChannels)).toBe(true);
      }
    }
  });

  test('roster API reflects manually-assigned org members from fixtures', async ({ request }) => {
    const response = await request.get('/api/modules/team-tracker/roster');
    expect(response.ok()).toBe(true);

    const roster = await response.json();
    // gkim is a pillar whose members are pinned via orgRoots[].manualMembers
    // (hwilson reports to fjohnson in LDAP but belongs to gkim's pillar)
    const manualOrg = (roster.orgs || []).find(o => o.key === 'gkim');
    expect(manualOrg).toBeDefined();

    const manualOrgMembers = Object.values(manualOrg.teams || {})
      .flatMap(team => team.members || []);
    expect(manualOrgMembers.some(m => m.uid === 'gkim')).toBe(true);
    expect(manualOrgMembers.some(m => m.uid === 'hwilson')).toBe(true);

    // Manual assignment is exclusive — hwilson no longer appears under the
    // org root they report to
    const ldapOrg = (roster.orgs || []).find(o => o.key === 'fjohnson');
    expect(ldapOrg).toBeDefined();
    const ldapOrgMembers = Object.values(ldapOrg.teams || {})
      .flatMap(team => team.members || []);
    expect(ldapOrgMembers.some(m => m.uid === 'hwilson')).toBe(false);
  });

  test('admin roster-sync config endpoint requires authentication', async ({ page }) => {
    // In CI containers with DEMO_MODE=true there is no OAuth proxy, so
    // requireAdmin returns 403 for admin-gated endpoints. Validation of
    // manualMembers payloads is covered by unit tests
    // (roster-sync-config.test.js).
    const res = await page.evaluate(async () => {
      const response = await fetch('/api/modules/team-tracker/admin/roster-sync/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgRoots: [
            { uid: 'orga', displayName: 'Org A' },
            { uid: 'orgb', displayName: 'Org B', manualMembers: ['jbloggs'] }
          ]
        })
      });
      return { status: response.status };
    });
    expect(res.status).toBe(403);
  });
});

/**
 * Disabled Menu Items
 *
 * Verify that People & Teams has no disabled menu items in the
 * publicly visible navigation (excluding role-gated items).
 */
test.describe('People & Teams Disabled Menu Items @people-teams', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  test('should have no disabled menu items', async ({ page }) => {
    await page.goto('/#/team-tracker/home');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // Count disabled navigation items within the People & Teams section only
    const disabledCount = await countDisabledNavItems(page, 'People & Teams');

    // People & Teams module should have no disabled menu items
    expect(disabledCount).toBe(0);
    expect(page.errors).toHaveLength(0);
  });
});

/**
 * Active Components
 *
 * Verify each major view (aka menu item) in the People & Teams module loads
 * with meaningful content.
 *
 * Note: "My Teams" and "Manage" views require specific roles (manager,
 * team-admin) and are not tested here since demo mode runs unauthenticated.
 */
test.describe('People & Teams Views @people-teams', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  // Helper to navigate and verify a view loads with content
  async function testView(page, viewId, viewName) {
    await page.goto(`/#/team-tracker/${viewId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // Before we verify content, we need to verify the overall view loads
    const mainContentVisible = await mainContentIsVisible(page);
    expect(mainContentVisible).toBe(true);

    // Verify the view has rendered some meaningful content by checking for
    // data-bearing elements (not just empty containers or placeholders)
    const hasContent = await pageHasContent(page);
    expect(hasContent).toBe(true);

    // Verify we're not stuck in an infinite loading state
    const pageHasFinishedLoading = await pageLoadComplete(page);
    expect(pageHasFinishedLoading).toBe(true);
    if (page.errors.length > 0) {
      console.error(`${viewName} errors:`, page.errors);
    }

    expect(page.errors).toHaveLength(0);
  }

  test('should load Team Directory view', async ({ page }) => {
    await testView(page, 'home', 'Team Directory');
  });

  test('should load People view', async ({ page }) => {
    await testView(page, 'people', 'People');
  });

  test('should load Reports view', async ({ page }) => {
    await testView(page, 'reports', 'Reports');
  });

  test('should load Org Dashboard view', async ({ page }) => {
    await testView(page, 'org-dashboard', 'Org Dashboard');
  });
});

/**
 * Team Detail — Autofix Tab
 *
 * Verify the Autofix tab on a team detail page loads without errors.
 * In demo mode, the tab shows an empty state (fixture components don't
 * overlap with autofix fixture data), which is the expected behavior.
 */
test.describe('People & Teams Autofix Tab @people-teams', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  test('should load Autofix tab on team detail page', async ({ page }) => {
    // Navigate to a team detail page (Platform team from fixtures)
    await page.goto('/#/team-tracker/team-detail?teamKey=achen::Platform');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // Click the Autofix tab
    const autofixTab = page.locator('nav button').filter({ hasText: 'Autofix' });
    await expect(autofixTab).toBeVisible();
    await autofixTab.click();
    await page.waitForTimeout(1000);

    // Verify the tab loaded — expect an empty state in demo mode
    // (team components don't overlap with autofix fixture components)
    const mainContentVisible = await mainContentIsVisible(page);
    expect(mainContentVisible).toBe(true);

    // Verify no JavaScript errors occurred
    expect(page.errors).toHaveLength(0);
  });
});

/**
 * Team Detail — Delivery Tab
 *
 * Verify the team-level cycle-time tile reports the median.
 */
test.describe('People & Teams Delivery Tab @people-teams', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  test('should show median cycle time on team delivery', async ({ page }) => {
    await page.goto('/#/team-tracker/team-detail?teamKey=achen::Platform');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    const deliveryTab = page.locator('nav button').filter({ hasText: 'Delivery' });
    await expect(deliveryTab).toBeVisible();
    await deliveryTab.click();

    await expect(page.getByText('Median Cycle Time', { exact: true })).toBeVisible();
    await expect(page.getByText('Avg Cycle Time', { exact: true })).toHaveCount(0);
    expect(page.errors).toHaveLength(0);
  });
});

/**
 * People Directory
 *
 * Verify the People Directory view shows roster data from fixtures
 */
test.describe('People & Teams People Directory @people-teams', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  test('should display people from registry', async ({ page }) => {
    await page.goto('/#/team-tracker/people');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // The people directory should render a list or table of people
    // from the fixture registry (which has 13 people)
    const mainContentVisible = await mainContentIsVisible(page);
    expect(mainContentVisible).toBe(true);

    // Look for name-bearing elements — the fixture data includes
    // names like "Alice Chen", "Bob Smith", etc.
    const bodyText = await page.locator('main, [role="main"], .min-h-screen').first().textContent();
    const hasNames = bodyText.includes('Alice Chen') || bodyText.includes('Bob Smith');
    expect(hasNames).toBe(true);

    expect(page.errors).toHaveLength(0);
  });
});
