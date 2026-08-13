/**
 * Generic frontend contribution machinery (mechanism, not policy).
 *
 * This module provides the domain-agnostic building blocks that any module can
 * use to build its own "contribution slots" — named extension points that
 * features register into, instead of core hardcoding `if (feature configured)`
 * branches. It intentionally does NOT define a universal slot vocabulary: each
 * module creates its own named registries via `createContributionRegistry` and
 * decides what a valid contribution looks like via the `validate` callback.
 *
 * What lives here (the reusable mechanism):
 *   - `createContributionRegistry({ name, validate })` — a namespaced registry
 *     factory returning `{ register, getAll, runGuard, reset }`.
 *   - `runGuard` — safely runs a guard callback (throws are swallowed).
 *   - render-descriptor validation + resolution — the single place that knows
 *     the `render` descriptor `type` switch, so new delivery types (`remote`,
 *     `declarative`, ...) can be added here once and picked up everywhere.
 *
 * The `render` field of every contribution is a *descriptor*, never a raw
 * component, so the shape stays forward-compatible with future remote/federated
 * or declarative delivery. Today only `{ type: 'component', load: () => import(...) }`
 * is renderable; unknown-but-well-formed descriptors are accepted at
 * registration time and degrade gracefully (to a fallback) at render time via
 * `ContributionBoundary`.
 */

/**
 * Validate a render descriptor. Only `component` is renderable today, but any
 * object with a non-empty string `type` is accepted so `remote` / `declarative`
 * types can be introduced later (in this file) without breaking registries.
 * Unknown-but-well-formed descriptors are allowed through and handled (with a
 * fallback) at render time.
 * @param {*} render
 * @returns {boolean}
 */
export function isValidRenderDescriptor(render) {
  if (!render || typeof render !== 'object') return false
  if (typeof render.type !== 'string' || render.type.length === 0) return false
  if (render.type === 'component') {
    return typeof render.load === 'function'
  }
  // Forward-compatible: accept other descriptor types; render layer decides.
  return true
}

/**
 * Resolve a render descriptor into instructions the render layer can act on.
 * This is the single `type` switch for delivery: add new descriptor types here
 * (and in `isValidRenderDescriptor`) and every consumer picks them up.
 * @param {*} render
 * @returns {{ type: 'component', loader: () => Promise } | { type: 'unsupported' }}
 */
export function resolveRenderDescriptor(render) {
  if (render && render.type === 'component' && typeof render.load === 'function') {
    return { type: 'component', loader: render.load }
  }
  // Unknown / unsupported descriptor type — the render layer degrades gracefully.
  return { type: 'unsupported' }
}

/**
 * Run a contribution guard callback safely. A throw (or an absent callback) is
 * swallowed and treated per `defaultValue`. Guards (e.g. `isVisible`,
 * `isAvailable`) are the caller's responsibility to run through this helper so a
 * throwing guard means "not visible / not available", never a crash.
 * @param {Function|undefined} fn - guard callback
 * @param {object} [options]
 * @param {boolean} [options.defaultValue=true] - result when `fn` is not a function
 * @param {any[]} [options.args=[]] - arguments to pass to `fn`
 * @returns {boolean}
 */
export function runGuard(fn, { defaultValue = true, args = [] } = {}) {
  if (typeof fn !== 'function') return defaultValue
  try {
    return !!fn(...args)
  } catch (err) {
    console.error('[contribution] guard threw; treating as hidden/unavailable', err)
    return false
  }
}

/**
 * Create a namespaced contribution registry.
 *
 * Each registry is an independent slot: it owns its own backing store, so two
 * registries never share state. Registration is resilient — a malformed
 * contribution is skipped and logged, never aborting the others.
 *
 * @param {object} options
 * @param {string} options.name - namespace used in log messages (e.g.
 *   `my-module:my-slot`). Required.
 * @param {(contribution: object) => (boolean|string|void)} [options.validate]
 *   - slot-specific validation run after the generic object check. Return
 *     `true`/`undefined` to accept; return `false` or a string reason to skip
 *     (the reason is logged). Throwing is treated as a skip.
 * @returns {{
 *   register: (contribution: object) => void,
 *   getAll: () => Array,
 *   runGuard: typeof runGuard,
 *   reset: () => void
 * }}
 */
export function createContributionRegistry({ name, validate } = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('createContributionRegistry requires a non-empty string "name"')
  }

  const items = []

  function register(contribution) {
    try {
      if (!contribution || typeof contribution !== 'object') {
        console.warn(`[${name}] Skipping malformed contribution: not an object`, contribution)
        return
      }

      if (typeof validate === 'function') {
        let result
        try {
          result = validate(contribution)
        } catch (err) {
          console.warn(`[${name}] Skipping contribution "${contribution.id}": validation threw`, err)
          return
        }
        if (result === false || typeof result === 'string') {
          const reason = typeof result === 'string' ? result : 'failed validation'
          console.warn(`[${name}] Skipping contribution "${contribution.id}": ${reason}`, contribution)
          return
        }
      }

      if (!isValidRenderDescriptor(contribution.render)) {
        console.warn(`[${name}] Skipping contribution "${contribution.id}": invalid render descriptor`, contribution.render)
        return
      }

      if (items.some(c => c.id === contribution.id)) {
        console.warn(`[${name}] Skipping duplicate contribution id "${contribution.id}"`)
        return
      }

      items.push({ order: 100, ...contribution })
      items.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    } catch (err) {
      console.error(`[${name}] Failed to register contribution`, err)
    }
  }

  /** @returns {Array} registered contributions (sorted, defensive copy) */
  function getAll() {
    return [...items]
  }

  /** Clear all registered contributions. Intended for unit tests only. */
  function reset() {
    items.length = 0
  }

  return { register, getAll, runGuard, reset }
}
