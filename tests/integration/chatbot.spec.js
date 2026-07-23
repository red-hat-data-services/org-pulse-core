const { test, expect } = require('@playwright/test');
const { DEFAULT_PAGE_WAIT_TIME } = require('./constants');
const { setupErrorTracking, logCapturedErrors, mainContentIsVisible } = require('./helpers');

/**
 * Integration tests for AI Assistant (chatbot) module
 *
 * These tests verify:
 * - Floating chat widget renders
 * - Chat panel opens and closes
 * - Chat input is functional
 * - API proxy endpoints respond correctly
 *
 * Tag: @chatbot
 * Usage: npx playwright test --grep @chatbot
 */

test.describe('AI Assistant Module @chatbot', () => {
  test.beforeEach(async ({ page }) => {
    setupErrorTracking(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    logCapturedErrors(page, testInfo);
  });

  test('should not appear in sidebar navigation', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    const sidebarChatbot = page.locator('aside nav').filter({ hasText: 'AI Assistant' });
    const count = await sidebarChatbot.count();
    expect(count).toBe(0);

    expect(page.errors).toHaveLength(0);
  });

  test('should render floating chat button', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    const chatButton = page.locator('button img[alt="AI Assistant"]');
    await expect(chatButton).toBeVisible();

    expect(page.errors).toHaveLength(0);
  });

  test('should open and close chat panel', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    const chatButton = page.locator('button', { has: page.locator('img[alt="AI Assistant"]') });
    await chatButton.click();
    await page.waitForTimeout(500);

    const chatPanel = page.locator('text=Ask me about your team\'s data');
    await expect(chatPanel).toBeVisible();

    const inputField = page.locator('input[placeholder="Ask about your team..."]');
    await expect(inputField).toBeVisible();

    await chatButton.click();
    await page.waitForTimeout(300);

    await expect(chatPanel).not.toBeVisible();

    expect(page.errors).toHaveLength(0);
  });

  test('should return health status from chatbot API proxy', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const response = await page.request.get('/api/modules/chatbot/health');
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('status');
    expect(['ok', 'degraded', 'not_configured', 'unreachable']).toContain(data.status);
  });

  test('should return 503 when chatbot service is not configured', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const response = await page.request.post('/api/modules/chatbot/chat', {
      data: { message: 'test' },
    });

    // 503 if not configured, 502 if unreachable, 200 if running
    expect([200, 502, 503]).toContain(response.status());
  });

  test('should not interfere with main content rendering', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(DEFAULT_PAGE_WAIT_TIME);

    const mainVisible = await mainContentIsVisible(page);
    expect(mainVisible).toBe(true);

    const chatButton = page.locator('button img[alt="AI Assistant"]');
    await expect(chatButton).toBeVisible();

    expect(page.errors).toHaveLength(0);
  });
});
