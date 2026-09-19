// Plain-text usage report built from raw health-metrics events.
// Pure functions: no I/O, so the same code serves GET /report and the tests.

const isView = e => !e.action || e.action === 'view';

function newStats() {
  return { visits: 0, interactions: 0, _days: new Map() };
}

function addEvent(stats, e) {
  if (isView(e)) stats.visits++; else stats.interactions++;
  if (!stats._days.has(e.email)) stats._days.set(e.email, new Set());
  stats._days.get(e.email).add(e.ts.slice(0, 10));
}

// repeatUsers = users seen on 2+ distinct days in the range
function finish(stats) {
  let repeatUsers = 0;
  for (const days of stats._days.values()) if (days.size >= 2) repeatUsers++;
  return { visits: stats.visits, interactions: stats.interactions, distinctUsers: stats._days.size, repeatUsers };
}

function bump(map, key, e) {
  if (!map[key]) map[key] = newStats();
  addEvent(map[key], e);
}

function finishAll(map) {
  return Object.fromEntries(Object.keys(map).sort().map(k => [k, finish(map[k])]));
}

function rolesOf(e) {
  const roles = Array.isArray(e.roles) && e.roles.length ? [...e.roles] : ['user'];
  if (e.isManager) roles.push('manager');
  return roles;
}

/**
 * @param {Array} events - raw events already filtered to the date range
 * @param {Array} modules - enabled module manifests ({ slug, client: { navItems } })
 * @param {{from: string, to: string}} range
 */
function buildReport(events, modules, { from, to }) {
  const totals = newStats();
  const byPersona = {};
  const byRole = {};
  const pages = {};
  let unknownPersona = 0;

  for (const e of events) {
    if (!e.page || !e.email || !e.ts) continue;
    const persona = e.userType || 'unknown';
    if (persona === 'unknown') unknownPersona++;

    addEvent(totals, e);
    bump(byPersona, persona, e);
    for (const role of rolesOf(e)) bump(byRole, role, e);

    if (!pages[e.page]) pages[e.page] = { all: newStats(), byPersona: {}, byRole: {}, actions: {} };
    const p = pages[e.page];
    addEvent(p.all, e);
    bump(p.byPersona, persona, e);
    for (const role of rolesOf(e)) bump(p.byRole, role, e);
    if (!isView(e)) bump(p.actions, e.detail ? `${e.action}:${e.detail}` : e.action, e);
  }

  const features = Object.keys(pages).sort().map(page => ({
    page,
    ...finish(pages[page].all),
    byPersona: finishAll(pages[page].byPersona),
    byRole: finishAll(pages[page].byRole),
    actions: finishAll(pages[page].actions),
  }));

  // A module counts as instrumented once any of its views reports an interaction.
  const instrumented = new Set(features.filter(f => f.interactions > 0).map(f => f.page.split('::')[0]));
  const navPages = [];
  for (const mod of modules || []) {
    for (const item of mod.client?.navItems || []) {
      if (!item.disabled) navPages.push(`${mod.slug}::${item.id}`);
    }
  }

  return {
    from,
    to,
    generatedAt: new Date().toISOString(),
    totals: finish(totals),
    byPersona: finishAll(byPersona),
    byRole: finishAll(byRole),
    features,
    missing: {
      unknownPersonaPct: events.length ? Math.round((unknownPersona / events.length) * 100) : 0,
      viewsWithNoEvents: navPages.filter(p => !pages[p]),
      viewsWithNoInteractions: features
        .filter(f => f.interactions === 0 && instrumented.has(f.page.split('::')[0]))
        .map(f => f.page),
    },
  };
}

// ─── Text rendering ───

const COLS = ['visits', 'interactions', 'distinctUsers', 'repeatUsers'];
const HEAD = ['visits', 'interact', 'users', 'repeat'];

function row(label, s, width) {
  return label.padEnd(width) + COLS.map(c => String(s[c]).padStart(10)).join('');
}

function table(title, entries, lines) {
  const width = Math.max(24, ...entries.map(([label]) => label.length + 2));
  lines.push('', title, ''.padEnd(width) + HEAD.map(h => h.padStart(10)).join(''));
  if (!entries.length) lines.push('  (none)');
  for (const [label, s] of entries) lines.push(row(label, s, width));
}

function renderReportText(r) {
  const lines = [
    `Org Pulse usage report  ${r.from} to ${r.to}`,
    `generated ${r.generatedAt}`,
    'visits = view opens, interact = actions inside a view, repeat = users seen on 2+ days',
  ];

  table('TOTALS', [['all', r.totals]], lines);
  table('BY PERSONA (user type)', Object.entries(r.byPersona), lines);
  table('BY ROLE', Object.entries(r.byRole), lines);

  const featureRows = [];
  for (const f of r.features) {
    featureRows.push([f.page, f]);
    for (const [k, s] of Object.entries(f.byPersona)) featureRows.push([`  persona ${k}`, s]);
    for (const [k, s] of Object.entries(f.byRole)) featureRows.push([`  role ${k}`, s]);
  }
  table('BY FEATURE (module::view) x PERSONA / ROLE', featureRows, lines);

  const actionRows = [];
  for (const f of r.features) {
    if (!Object.keys(f.actions).length) continue;
    actionRows.push([f.page, f]);
    for (const [k, s] of Object.entries(f.actions)) actionRows.push([`  ${k}`, s]);
  }
  table('INTERACTION BREAKDOWN (view x action:detail)', actionRows, lines);

  lines.push('', 'MEASUREMENT MISSING');
  lines.push(`  events with persona "unknown": ${r.missing.unknownPersonaPct}%` +
    (r.missing.unknownPersonaPct === 100 ? '  (User Type Field is probably not set in Settings)' : ''));
  lines.push('  enabled views with no events in range:');
  for (const p of r.missing.viewsWithNoEvents) lines.push(`    ${p}`);
  if (!r.missing.viewsWithNoEvents.length) lines.push('    (none)');
  lines.push('  views visited but with no interactions, in modules that report interactions:');
  for (const p of r.missing.viewsWithNoInteractions) lines.push(`    ${p}`);
  if (!r.missing.viewsWithNoInteractions.length) lines.push('    (none)');

  return lines.join('\n') + '\n';
}

module.exports = { buildReport, renderReportText };
