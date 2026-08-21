/**
 * Regression test for auditing on POST /api/admin/secrets/update.
 *
 * The handler used to call auditLog.log(), a method the audit-log module has
 * never exported. Updating secrets therefore wrote the .env file, threw a
 * TypeError, threw a second time inside its own catch block, and returned an
 * opaque 500 telling the admin the update had failed. Nothing was audited.
 */

const fs = require('fs')

const registerAdminRoutes = require('../routes/admin')

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

function buildContext(auditLog) {
  return {
    storage: {},
    requireAuth: passThrough,
    requireAdmin: passThrough,
    requireScope: () => passThrough,
    blockDuringImpersonation: passThrough,
    secretRegistry: { getStatus: () => ({}) },
    refreshRegistry: {
      register: () => {},
      get: () => null,
      isRunning: () => false,
      getAll: () => ({}),
      getStatus: async () => ({ handlers: {} }),
      getCadenceOverrides: () => ({}),
    },
    builtInModules: [],
    enabledSlugs: new Set(),
    collectModuleDiagnostics: async () => ({}),
    diagnosticsRegistry: { getAll: () => ({}) },
    gitSync: {},
    exportRegistry: { getAll: () => [] },
    messageRegistry: { registerProvider: () => {} },
    auditLog,
  }
}

function getSecretsHandler(auditLog) {
  const app = makeFakeApp()
  registerAdminRoutes(app, buildContext(auditLog))
  return app._routes.post['/api/admin/secrets/update']
}

describe('registerAdminRoutes', () => {
  it('refuses to register without an injected audit log', () => {
    const app = makeFakeApp()
    const context = buildContext(undefined)
    expect(() => registerAdminRoutes(app, context)).toThrow(/requires context\.auditLog/)
  })
})

describe('POST /api/admin/secrets/update', () => {
  // The handler resolves .env from __dirname, i.e. the repo root — NOT the
  // process working directory. Mocking process.cwd() does nothing, so the fs
  // calls themselves must be stubbed or the suite writes a stray .env into
  // the working copy.
  let writeSpy
  let existsSpy
  let readSpy
  let written

  let savedEnv

  beforeEach(() => {
    // The handler assigns into process.env for allowlisted keys.
    savedEnv = process.env.GITLAB_TOKEN
    written = []
    existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('')
    writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((p, contents) => {
      written.push({ path: p, contents })
    })
  })

  afterEach(() => {
    existsSpy.mockRestore()
    readSpy.mockRestore()
    writeSpy.mockRestore()
    // The handler assigns process.env[key] = value for allowlisted keys, so
    // GITLAB_TOKEN is left set to 'abc' after tests that exercise the
    // success path. Restore rather than leave it — process.env is per-worker
    // and another test file on the same worker could observe the leftover.
    if (savedEnv === undefined) {
      delete process.env.GITLAB_TOKEN
    } else {
      process.env.GITLAB_TOKEN = savedEnv
    }
  })

  it('writes an audit entry and succeeds', async () => {
    const appendAuditEntry = vi.fn(async () => {})
    const handler = getSecretsHandler({ appendAuditEntry })

    const res = makeRes()
    await handler(
      { body: { secrets: { GITLAB_TOKEN: 'abc' } }, user: { email: 'admin@example.com' } },
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)

    expect(appendAuditEntry).toHaveBeenCalledTimes(1)
    const entry = appendAuditEntry.mock.calls[0][0]
    expect(entry.action).toBe('secrets.update')
    expect(entry.actor).toBe('admin@example.com')
    expect(entry.entityType).toBe('secret')
    expect(entry.entityId).toBe('GITLAB_TOKEN')
  })

  it('rejects an empty secrets object with 400 and writes nothing', async () => {
    const appendAuditEntry = vi.fn(async () => {})
    const handler = getSecretsHandler({ appendAuditEntry })

    const res = makeRes()
    await handler(
      { body: { secrets: {} }, user: { email: 'admin@example.com' } },
      res
    )

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/empty/i)
    expect(appendAuditEntry).not.toHaveBeenCalled()
    expect(written).toHaveLength(0)
  })

  it('still reports success when the success-path audit append throws', async () => {
    // The .env write has already happened by the time the audit append
    // runs. If auditing fails here, the caller must still see success —
    // otherwise a working secrets update is reported as a failure.
    const appendAuditEntry = vi.fn(async () => { throw new Error('audit backend down') })
    const handler = getSecretsHandler({ appendAuditEntry })

    const res = makeRes()
    await handler(
      { body: { secrets: { GITLAB_TOKEN: 'abc' } }, user: { email: 'admin@example.com' } },
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0].contents).toMatch(/GITLAB_TOKEN=abc/)
  })

  it('still reports the original error when the audit write fails', async () => {
    // Force the handler into its catch block by failing the .env write, then
    // make auditing fail too. Previously the second throw escaped the catch
    // and masked the real error.
    writeSpy.mockImplementation(() => { throw new Error('disk full') })
    const appendAuditEntry = vi.fn(async () => { throw new Error('audit backend down') })
    const handler = getSecretsHandler({ appendAuditEntry })

    const res = makeRes()
    await handler(
      { body: { secrets: { GITLAB_TOKEN: 'abc' } }, user: { email: 'admin@example.com' } },
      res
    )

    expect(res.statusCode).toBe(500)
    expect(res.body.error).toMatch(/Failed to update secrets/)
    expect(res.body.error).not.toMatch(/audit backend down/)
  })
})
