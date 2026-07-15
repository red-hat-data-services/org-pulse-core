/**
 * Auth middleware extracted from dev-server.js.
 * Provides authentication and authorization for Express routes.
 */

const crypto = require('crypto');
const { isManager } = require('./permissions');

function blockDuringImpersonation(req, res, next) {
  if (req.isImpersonating) {
    return res.status(403).json({
      error: 'This action is not allowed while impersonating another user'
    });
  }
  next();
}

function createAuthMiddleware(readFromStorage, writeToStorage, options = {}) {
  const { tokenValidator, roleStore, getFileMtime } = options;

  // Registry cache for resolveUserUid (30s TTL + mtime invalidation)
  let _registryCache = null;
  let _registryCacheMtime = 0;
  const REGISTRY_CACHE_TTL_MS = 30_000;
  let _registryCacheExpiry = 0;

  async function getCachedRegistry() {
    const now = Date.now();
    if (_registryCache && now < _registryCacheExpiry) {
      return _registryCache;
    }
    if (getFileMtime) {
      const mtime = await getFileMtime('team-data/registry.json');
      if (_registryCache && mtime === _registryCacheMtime) {
        _registryCacheExpiry = now + REGISTRY_CACHE_TTL_MS;
        return _registryCache;
      }
      _registryCacheMtime = mtime;
    }
    _registryCache = await readFromStorage('team-data/registry.json');
    _registryCacheExpiry = now + REGISTRY_CACHE_TTL_MS;
    return _registryCache;
  }

  async function isAdmin(email) {
    if (roleStore) {
      return await roleStore.hasRole(email, 'admin');
    }
    const adminList = await readFromStorage('allowlist.json')
    return adminList && adminList.emails && adminList.emails.includes(email)
  }

  async function seedRoles() {
    if (roleStore) {
      // Try migration from allowlist first
      await roleStore.migrateFromAllowlist();

      const assignments = await roleStore.listAssignments();
      if (Object.keys(assignments).length > 0) {
        const adminCount = (await roleStore.getAdminEmails()).length;
        console.log(`Roles: ${adminCount} admin(s) loaded`);
        return;
      }

      const adminEmails = process.env.ADMIN_EMAILS;
      if (!adminEmails) {
        console.log('Roles: empty — first authenticated user will be auto-added');
        return;
      }

      const emails = adminEmails
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);

      for (const email of emails) {
        await roleStore.assignRole(email, 'admin', 'system-seed');
      }
      console.log(`Roles: seeded with ${emails.length} admin(s) from ADMIN_EMAILS`);
      return;
    }

    // Legacy path (no role store)
    const existing = await readFromStorage('allowlist.json')
    const currentEmails = (existing && existing.emails) ? existing.emails : []

    const adminEmails = process.env.ADMIN_EMAILS
    if (!adminEmails) {
      if (currentEmails.length > 0) {
        console.log(`Admin list: ${currentEmails.length} admin(s) loaded`)
      } else {
        console.log('Admin list: empty — first authenticated user will be auto-added as admin')
      }
      return
    }

    const envEmails = adminEmails
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)

    const merged = [...new Set([...currentEmails, ...envEmails])]

    if (merged.length !== currentEmails.length) {
      await writeToStorage('allowlist.json', { emails: merged })
      console.log(`Admin list: merged to ${merged.length} admin(s) (${merged.length - currentEmails.length} added from ADMIN_EMAILS)`)
    } else {
      console.log(`Admin list: ${merged.length} admin(s) loaded`)
    }
  }

  async function resolveUserUid(req) {
    const registry = await getCachedRegistry();
    req.userUid = null;
    if (registry && registry.people) {
      for (const [uid, person] of Object.entries(registry.people)) {
        if (person.status !== 'active') continue;
        if (person.email && person.email.toLowerCase() === req.userEmail) {
          req.userUid = uid;
          break;
        }
      }
      // Fallback: match by UID when email domain doesn't match (e.g. user@cluster.local)
      if (!req.userUid && req.userEmail) {
        const localPart = req.userEmail.split('@')[0];
        if (localPart && registry.people[localPart] && registry.people[localPart].status === 'active') {
          req.userUid = localPart;
        }
      }
    }
    req.userRoles = roleStore ? await roleStore.getRoles(req.userEmail) : [];
    req.isTeamAdmin = req.userRoles.includes('team-admin');
    req.isPlanningManager = req.userRoles.includes('planning-manager');
    req.isManager = isManager(req.userUid, registry);
  }

  async function applyImpersonation(req, res) {
    const impersonateUid = req.headers['x-impersonate-uid'];
    if (!impersonateUid) {
      req.auditActor = req.userEmail;
      return null;
    }

    if (!req.isAdmin) {
      return res.status(403).json({ error: 'Only admins can impersonate' });
    }

    if (req.userUid && impersonateUid === req.userUid) {
      return res.status(400).json({ error: 'Cannot impersonate yourself' });
    }

    const registry = await getCachedRegistry();
    if (!registry?.people?.[impersonateUid] || registry.people[impersonateUid].status !== 'active') {
      return res.status(404).json({ error: 'Target user not found in roster' });
    }

    const target = registry.people[impersonateUid];

    req.realAdminEmail = req.userEmail;
    req.realAdminUid = req.userUid;

    req.userEmail = target.email?.toLowerCase() || impersonateUid;
    req.userUid = impersonateUid;
    req.isAdmin = await isAdmin(req.userEmail);
    req.userRoles = roleStore ? await roleStore.getRoles(req.userEmail) : [];
    req.isTeamAdmin = req.userRoles.includes('team-admin');
    req.isPlanningManager = req.userRoles.includes('planning-manager');
    req.isManager = isManager(req.userUid, registry);
    req.isImpersonating = true;
    req.impersonatedDisplayName = target.name || null;

    req.auditActor = `${req.userEmail} (impersonated by ${req.realAdminEmail})`;
    return null;
  }

  async function authMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next()

    // Check for Bearer token FIRST — the tt_ prefix distinguishes our tokens
    // from other Bearer schemes, which fall through to the proxy/local-dev path
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer tt_')) {
      const rawToken = authHeader.slice('Bearer '.length);
      if (tokenValidator) {
        const tokenRecord = await tokenValidator.validateToken(rawToken);
        if (!tokenRecord) {
          // HARD STOP: invalid/expired token must NEVER fall through
          return res.status(401).json({ error: 'Invalid or expired API token' });
        }
        req.userEmail = tokenRecord.ownerEmail;
        req.isAdmin = await isAdmin(tokenRecord.ownerEmail);
        req.authMethod = 'token';
        req.tokenScopes = tokenRecord.scopes; // array, ['*'], null, or undefined
        // Update lastUsedAt (fire-and-forget, throttled)
        tokenValidator.touchLastUsed(tokenRecord.id);
        await resolveUserUid(req);
        const blocked = await applyImpersonation(req, res);
        if (blocked) return;
        return next();
      }
      // No token validator configured — reject token auth
      return res.status(401).json({ error: 'API token authentication is not configured' });
    }

    // Existing flow: X-Forwarded-Email or local dev fallback
    const email = req.headers['x-forwarded-email']
    if (email) {
      req.userEmail = email.toLowerCase()
    } else {
      req.userEmail = (process.env.ADMIN_EMAILS || 'local-dev@redhat.com').split(',')[0].trim().toLowerCase()
    }

    if (roleStore) {
      const assignments = await roleStore.listAssignments();
      if (!assignments || Object.keys(assignments).length === 0) {
        await roleStore.assignRole(req.userEmail, 'admin', 'auto-first-user');
        console.log(`Roles: auto-added first user ${req.userEmail} as admin`);
      }
    } else {
      const adminList = await readFromStorage('allowlist.json')
      if (!adminList || !adminList.emails || adminList.emails.length === 0) {
        const seeded = { emails: [req.userEmail] }
        await writeToStorage('allowlist.json', seeded)
        console.log(`Admin list: auto-added first user ${req.userEmail}`)
      }
    }

    req.isAdmin = await isAdmin(req.userEmail)
    await resolveUserUid(req);
    const blocked = await applyImpersonation(req, res);
    if (blocked) return;
    next()
  }

  function requireAuth(req, res, next) {
    if (!req.userEmail) {
      return res.status(401).json({ error: 'Authentication required.' })
    }
    next()
  }

  function requireAdmin(req, res, next) {
    if (!req.isAdmin) {
      return res.status(403).json({ error: 'Admin access required.' })
    }
    next()
  }

  function requireTeamAdmin(req, res, next) {
    if (!req.isAdmin && !req.isTeamAdmin) {
      return res.status(403).json({ error: 'Team admin access required.' })
    }
    next()
  }

  function requireRole(role) {
    return async function(req, res, next) {
      if (req.isAdmin) return next();
      if (!roleStore || !(await roleStore.hasRole(req.userEmail, role))) {
        return res.status(403).json({
          error: `Role "${role}" required.`
        });
      }
      next();
    };
  }

  function requireScope(scope) {
    return function(req, res, next) {
      // Only enforce scopes for token auth
      if (req.authMethod !== 'token') return next();

      const scopes = req.tokenScopes;

      // null/undefined or ['*'] means full access (legacy / wildcard)
      if (!scopes || (scopes.length === 1 && scopes[0] === '*')) return next();

      // tokens:manage is always implicitly granted
      if (scope === 'tokens:manage') return next();

      if (!scopes.includes(scope)) {
        return res.status(403).json({
          error: 'Token scope insufficient',
          requiredScope: scope
        });
      }
      next();
    };
  }

  return { authMiddleware, requireAuth, requireAdmin, requireTeamAdmin, requireRole, requireScope, isAdmin, seedRoles }
}

let _emptySecretWarned = false;

function proxySecretGuard(req, res, next, options = {}) {
  const { tokenValidator } = options;
  const expectedSecret = process.env.PROXY_AUTH_SECRET;
  if (!expectedSecret) {
    if (process.env.PROXY_AUTH_SECRET === '' && !_emptySecretWarned) {
      _emptySecretWarned = true;
      console.warn('[auth] PROXY_AUTH_SECRET is set but empty — proxy secret guard is disabled');
    }
    return next();
  }
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/healthz' || req.path === '/api/healthz') return next();
  // API docs: publicly accessible without auth
  if (req.path.startsWith('/api/docs')) return next();
  // Shell module list: public metadata only (same payload as unauthenticated dev)
  if (req.method === 'GET' && req.path === '/api/built-in-modules/manifests') return next();

  const providedSecret = req.headers['x-proxy-secret'];
  if (providedSecret && providedSecret.length === expectedSecret.length &&
      crypto.timingSafeEqual(Buffer.from(providedSecret), Buffer.from(expectedSecret))) {
    return next();
  }

  // Bearer token inline validation: if request has a tt_ token, validate it
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer tt_') && tokenValidator) {
    const rawToken = authHeader.slice('Bearer '.length);
    if (tokenValidator.isValidToken(rawToken)) {
      return next();
    }
    // Invalid token — reject immediately (defense in depth)
    return res.status(401).json({ error: 'Invalid or expired API token' });
  }

  console.warn(`[auth] Proxy secret mismatch from ${req.ip} on ${req.method} ${req.path}`);
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { createAuthMiddleware, proxySecretGuard, blockDuringImpersonation }
