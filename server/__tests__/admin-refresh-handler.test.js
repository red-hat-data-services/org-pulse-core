/**
 * Regression test for running a single refresh handler by ID.
 *
 * Platform-extension refresh handlers are keyed with a disambiguated slug that
 * contains a "/" (e.g. "team-tracker/allocation:allocation"). Passing that ID as
 * a URL path segment breaks routing (encoded "/"), so the endpoint accepts the
 * ID in the request body. These tests exercise that handler in isolation.
 */

const registerAdminRoutes = require('../routes/admin')

// Capture route handlers registered on a fake Express app.
function makeFakeApp() {
  const routes = { get: {}, post: {}, use: [], options: {} }
  const record = (method) => (pathOrPaths, ...handlers) => {
    const handler = handlers[handlers.length - 1]
    const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths]
    for (const p of paths) routes[method][p] = handler
  }
  return {
    get: record('get'),
    post: record('post'),
    options: record('options'),
    use: (...args) => routes.use.push(args),
    _routes: routes,
  }
}

function makeRes() {
  const res = {}
  res.statusCode = 200
  res.body = undefined
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (payload) => { res.body = payload; return res }
  res.end = () => res
  return res
}

const passThrough = (req, res, next) => next && next()

function buildContext(registryOverrides = {}) {
  const registered = new Map()
  const runOne = vi.fn(() => Promise.resolve())
  const refreshRegistry = {
    register: (id, config) => registered.set(id, config),
    get: (id) => registered.get(id) || null,
    runOne,
    isRunning: () => false,
    getAll: () => Object.fromEntries(registered),
    getStatus: async () => ({ handlers: {} }),
    runAll: async () => ({ counts: {} }),
    runModule: async () => ({}),
    getCadenceOverrides: () => ({}),
    setCadenceOverride: async () => {},
    ...registryOverrides,
  }
  const context = {
    storage: {},
    requireAuth: passThrough,
    requireAdmin: passThrough,
    requireScope: () => passThrough,
    blockDuringImpersonation: passThrough,
    secretRegistry: { getStatus: () => ({}) },
    refreshRegistry,
    builtInModules: [],
    enabledSlugs: new Set(),
    collectModuleDiagnostics: async () => ({}),
    diagnosticsRegistry: { getAll: () => ({}) },
    gitSync: {},
    exportRegistry: { getAll: () => [] },
    messageRegistry: { registerProvider: () => {} },
  }
  return { context, refreshRegistry, runOne }
}

function getHandler() {
  const app = makeFakeApp()
  const { context, refreshRegistry, runOne } = buildContext()
  registerAdminRoutes(app, context)
  const handler = app._routes.post['/api/admin/refresh/handler']
  return { handler, refreshRegistry, runOne }
}

describe('POST /api/admin/refresh/handler', () => {
  it('runs a handler whose ID contains "/" when passed in the body', async () => {
    const { handler, refreshRegistry, runOne } = getHandler()
    const id = 'team-tracker/allocation:allocation'
    refreshRegistry.register(id, { handler: async () => {} })

    const res = makeRes()
    await handler({ body: { handlerId: id }, params: {} }, res)

    expect(res.statusCode).toBe(202)
    expect(res.body).toEqual({ status: 'started', handler: id })
    expect(runOne).toHaveBeenCalledWith(id, { skipCooldown: true })
  })

  it('falls back to the legacy path parameter', async () => {
    const { handler, refreshRegistry, runOne } = getHandler()
    refreshRegistry.register('team-tracker:roster-sync', { handler: async () => {} })

    const res = makeRes()
    await handler({ body: {}, params: { handlerId: 'team-tracker:roster-sync' } }, res)

    expect(res.statusCode).toBe(202)
    expect(runOne).toHaveBeenCalledWith('team-tracker:roster-sync', { skipCooldown: true })
  })

  it('returns 400 when no handlerId is provided', async () => {
    const { handler } = getHandler()
    const res = makeRes()
    await handler({ body: {}, params: {} }, res)
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for an unknown handler ID', async () => {
    const { handler } = getHandler()
    const res = makeRes()
    await handler({ body: { handlerId: 'nope:nope' }, params: {} }, res)
    expect(res.statusCode).toBe(404)
  })
})
