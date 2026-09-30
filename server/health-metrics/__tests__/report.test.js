import { describe, it, expect } from 'vitest';
const { buildReport, renderReportText } = require('../report');
const { aggregateEvents, mergeDailyBreakdown } = require('../aggregator');
const { validateTrackBody, resolveReportRange } = require('../routes');

const ev = (day, email, page, extra = {}) => ({
  ts: `2026-09-${day}T10:00:00.000Z`, email, page, userType: 'unknown', roles: [], ...extra,
});

const EVENTS = [
  ev('01', 'a@x.com', 'ai-impact::rfe-review', { userType: 'PM' }),
  ev('01', 'a@x.com', 'ai-impact::rfe-review', { userType: 'PM', action: 'filter', detail: 'status' }),
  ev('02', 'a@x.com', 'ai-impact::rfe-review', { userType: 'PM', action: 'link', detail: 'jira' }),
  ev('02', 'b@x.com', 'ai-impact::rfe-review', { roles: ['admin'], isManager: true, action: 'view' }),
  ev('02', 'b@x.com', 'ai-impact::autofix', { roles: ['admin'], isManager: true }),
  ev('03', 'c@x.com', 'releases::home'), // legacy event: no action field
];

const MODULES = [
  { slug: 'ai-impact', client: { navItems: [{ id: 'rfe-review' }, { id: 'autofix' }, { id: 'documentation' }, { id: 'security', disabled: true }] } },
  { slug: 'releases', client: { navItems: [{ id: 'home' }] } },
];

describe('buildReport', () => {
  const r = buildReport(EVENTS, MODULES, { from: '2026-09-01', to: '2026-09-07' });

  it('splits visits from interactions and counts repeat users by distinct days', () => {
    expect(r.totals).toEqual({ visits: 4, interactions: 2, distinctUsers: 3, repeatUsers: 1 });
  });

  it('breaks down by persona and by role (manager is a role)', () => {
    expect(r.byPersona.PM).toMatchObject({ visits: 1, interactions: 2, distinctUsers: 1, repeatUsers: 1 });
    expect(r.byRole.manager.distinctUsers).toBe(1);
    expect(r.byRole.user.distinctUsers).toBe(2);
    const rfe = r.features.find(f => f.page === 'ai-impact::rfe-review');
    expect(rfe.byPersona.PM.interactions).toBe(2);
    expect(rfe.actions).toHaveProperty('filter:status');
    expect(rfe.actions['link:jira'].distinctUsers).toBe(1);
  });

  it('reports where measurement is missing', () => {
    expect(r.missing.viewsWithNoEvents).toEqual(['ai-impact::documentation']);
    // autofix is in an instrumented module but saw no interactions; releases is not instrumented
    expect(r.missing.viewsWithNoInteractions).toEqual(['ai-impact::autofix']);
    expect(r.missing.unknownPersonaPct).toBe(50);
  });

  it('renders every section as text', () => {
    const text = renderReportText(r);
    for (const s of ['TOTALS', 'BY PERSONA', 'BY ROLE', 'BY FEATURE', 'INTERACTION BREAKDOWN', 'MEASUREMENT MISSING', 'filter:status']) {
      expect(text).toContain(s);
    }
    expect(renderReportText(buildReport([], [], { from: 'a', to: 'b' }))).toContain('(none)');
  });
});

describe('aggregator with actions', () => {
  it('keeps interactions out of view counts', () => {
    const page = aggregateEvents(EVENTS, '2026-09').pages['ai-impact::rfe-review'];
    expect(page.views).toBe(2);
    expect(page.interactions).toBe(2);
    expect(page.byAction).toEqual({ 'filter:status': 1, 'link:jira': 1 });
    expect(mergeDailyBreakdown(EVENTS)['2026-09-02'].views).toBe(2);
  });
});

describe('validateTrackBody', () => {
  it('defaults to a view when action is absent', () => {
    expect(validateTrackBody({ page: 'm::v' })).toEqual({ page: 'm::v', action: 'view', detail: '' });
  });

  it('accepts a stable action and detail', () => {
    expect(validateTrackBody({ page: 'm::v', action: 'filter', detail: 'ai-involvement' }).error).toBeUndefined();
  });

  it('rejects free text, non-strings and oversize values', () => {
    expect(validateTrackBody({ page: 'm::v', action: 'search', detail: 'my query text' }).error).toBeTruthy();
    expect(validateTrackBody({ page: 'm::v', action: '' }).error).toBeTruthy();
    expect(validateTrackBody({ page: 'm::v', action: { a: 1 } }).error).toBeTruthy();
    expect(validateTrackBody({ page: 'm::v', action: 'a'.repeat(65) }).error).toBeTruthy();
    expect(validateTrackBody({ page: 'no-separator' }).error).toBeTruthy();
    expect(validateTrackBody(undefined).error).toBeTruthy();
  });
});

describe('resolveReportRange', () => {
  it('defaults to the 7 days ending today', () => {
    expect(resolveReportRange({}, '2026-09-19')).toEqual({ from: '2026-09-13', to: '2026-09-19' });
  });

  it('rejects malformed, impossible and inverted dates without throwing', () => {
    expect(resolveReportRange({ to: '9999-99-99' })).toBeNull();
    expect(resolveReportRange({ from: '2026-13-40', to: '2026-09-19' })).toBeNull();
    expect(resolveReportRange({ to: 'yesterday' })).toBeNull();
    expect(resolveReportRange({ from: '2026-09-20', to: '2026-09-19' })).toBeNull();
  });
});
