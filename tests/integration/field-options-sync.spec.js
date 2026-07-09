const { test, expect } = require('@playwright/test');
const { DEFAULT_PAGE_WAIT_TIME } = require('./constants');
const { setupErrorTracking, logCapturedErrors, mainContentIsVisible, pageLoadComplete } = require('./helpers');

/**
 * Integration tests for Field Options Sync (Jira linking)
 *
 * These tests verify:
 * - Field Options tab loads in the Manage view
 * - Field Options API endpoints return data in demo mode
 * - Sync preview returns demo data
 * - Migration preview endpoint works
 * - The FieldOptionsManager UI renders option sets from fixtures
 *
 * Tag: @people-teams
 * (Part of the people-teams module — runs when team-tracker changes)
 *
 * Usage: npx playwright test --grep @people-teams
 */

test.describe('Field Options Sync @people-teams', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  test('field-options API returns option sets from fixtures', async ({ page }) => {
    const response = await page.request.get('/api/modules/team-tracker/field-options');
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);

    // The fixture has a "component" option set
    const component = data.find(s => s.name === 'components' || s.name === 'component');
    expect(component).toBeDefined();
    expect(component.count).toBeGreaterThan(0);
  });

  test('field-options detail API returns values and metadata', async ({ page }) => {
    // Try both possible names (fixture may use either)
    let response = await page.request.get('/api/modules/team-tracker/field-options/component');
    if (!response.ok()) {
      response = await page.request.get('/api/modules/team-tracker/field-options/components');
    }
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.name).toBeDefined();
    expect(Array.isArray(data.values)).toBe(true);
    expect(data.values.length).toBeGreaterThan(0);
  });

  test('jira-projects endpoint returns demo project in demo mode', async ({ page }) => {
    const response = await page.request.get('/api/modules/team-tracker/field-options/sync/jira-projects');
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.projects).toBeDefined();
    expect(Array.isArray(data.projects)).toBe(true);
    // Demo mode returns a single demo project
    expect(data.projects.length).toBeGreaterThan(0);
    expect(data.projects[0].key).toBeDefined();
    expect(data.projects[0].name).toBeDefined();
  });

  test('sync preview returns demo data with diff', async ({ page }) => {
    const response = await page.request.get(
      '/api/modules/team-tracker/field-options/component/sync/preview?projectKey=DEMO&entityType=components'
    );
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.optionSet).toBeDefined();
    expect(data.projectKey).toBe('DEMO');
    expect(data.entityType).toBe('components');
    expect(Array.isArray(data.values)).toBe(true);
    expect(data.values.length).toBeGreaterThan(0);
    expect(Array.isArray(data.currentValues)).toBe(true);
  });

  test('sync preview rejects missing projectKey', async ({ page }) => {
    const response = await page.request.get(
      '/api/modules/team-tracker/field-options/component/sync/preview?entityType=components'
    );
    expect(response.ok()).toBe(false);
    expect(response.status()).toBe(400);
  });

  test('sync preview rejects invalid entityType', async ({ page }) => {
    const response = await page.request.get(
      '/api/modules/team-tracker/field-options/component/sync/preview?projectKey=DEMO&entityType=invalid'
    );
    expect(response.ok()).toBe(false);
    expect(response.status()).toBe(400);
  });

  test('migration preview returns orphan data', async ({ page }) => {
    const response = await page.request.get(
      '/api/modules/team-tracker/field-options/component/migrate/preview'
    );
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.optionSet).toBeDefined();
    expect(Array.isArray(data.currentValues)).toBe(true);
    expect(Array.isArray(data.orphanedValues)).toBe(true);
    expect(data.orphanedUsage).toBeDefined();
    expect(data.suggestions).toBeDefined();
  });

  test('migration preview returns 404 for non-existent option set', async ({ page }) => {
    const response = await page.request.get(
      '/api/modules/team-tracker/field-options/nonexistent/migrate/preview'
    );
    expect(response.status()).toBe(404);
  });

  test('sync trigger returns skipped in demo mode', async ({ page }) => {
    const response = await page.request.post(
      '/api/modules/team-tracker/field-options/component/sync/trigger'
    );
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.status).toBe('skipped');
    expect(data.reason).toContain('demo');
  });

  test('link endpoint is blocked in demo mode', async ({ page }) => {
    const response = await page.request.post(
      '/api/modules/team-tracker/field-options/component/sync/link',
      {
        data: { projectKey: 'DEMO', entityType: 'components' },
        headers: { 'Content-Type': 'application/json' }
      }
    );
    // Demo write guard returns 403
    expect(response.status()).toBe(403);
  });

  test('unlink endpoint is blocked in demo mode', async ({ page }) => {
    const response = await page.request.post(
      '/api/modules/team-tracker/field-options/component/sync/unlink'
    );
    expect(response.status()).toBe(403);
  });

  test('migration apply is blocked in demo mode', async ({ page }) => {
    const response = await page.request.post(
      '/api/modules/team-tracker/field-options/component/migrate/apply',
      {
        data: { mappings: { 'Old': 'New' } },
        headers: { 'Content-Type': 'application/json' }
      }
    );
    expect(response.status()).toBe(403);
  });
});

test.describe('Field Options Manager UI @people-teams', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  test('Manage view loads with Field Options tab', async ({ page }) => {
    await page.goto('/#/team-tracker/manage?tab=field-options');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    const mainContentVisible = await mainContentIsVisible(page);
    expect(mainContentVisible).toBe(true);

    // Verify the Field Options tab is present and active
    const fieldOptionsTab = page.locator('button').filter({ hasText: 'Field Options' });
    await expect(fieldOptionsTab).toBeVisible();

    expect(page.errors).toHaveLength(0);
  });

  test('Field Options tab shows option sets from fixtures', async ({ page }) => {
    await page.goto('/#/team-tracker/manage?tab=field-options');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    // Click the Field Options tab if not already active
    const tab = page.locator('button').filter({ hasText: 'Field Options' });
    await tab.click();
    await page.waitForTimeout(1000);

    // The fixture has a "component" option set — verify it's listed
    const bodyText = await page.locator('main, [role="main"], .min-h-screen').first().textContent();
    const hasComponentSet = bodyText.includes('Component') || bodyText.includes('component');
    expect(hasComponentSet).toBe(true);

    const pageHasFinished = await pageLoadComplete(page);
    expect(pageHasFinished).toBe(true);

    expect(page.errors).toHaveLength(0);
  });
});
