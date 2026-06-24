/**
 * Scope registry — dynamic registration of platform and module token scopes.
 *
 * Modules register scopes via context.registerScopes() during startup.
 * The registry is frozen after construction; individual entries are
 * frozen on registration.
 *
 * @module shared/server/scope-registry
 */

/**
 * @typedef {object} ScopeConfig
 * @property {string} key         - Scope key (e.g. 'releases:read')
 * @property {string} label       - Human label
 * @property {string} description - Short description
 * @property {string} category    - UI grouping
 * @property {string} module      - Module slug (or 'platform')
 */

/**
 * Create a scope registry instance.
 * @returns {{ register: Function, isValid: Function, getAll: Function, getValidKeys: Function }}
 */
function createScopeRegistry() {
  const scopes = new Map();

  function register(key, config) {
    if (scopes.has(key)) {
      throw new Error(`Scope "${key}" is already registered`);
    }
    scopes.set(key, Object.freeze({ key, ...config }));
  }

  function isValid(key) {
    return scopes.has(key);
  }

  function getAll() {
    return [...scopes.values()];
  }

  function getValidKeys() {
    return [...scopes.keys()];
  }

  return Object.freeze({ register, isValid, getAll, getValidKeys });
}

module.exports = { createScopeRegistry };
