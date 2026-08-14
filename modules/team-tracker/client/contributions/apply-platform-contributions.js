/**
 * Discovery seam for platform-provided team-tracker contributions.
 *
 * A consumer repo ships `platform/<name>/team-tracker-contributions.js`
 * exporting a `register` function. Core team-tracker discovers those files with
 * `import.meta.glob('/platform/*\/team-tracker-contributions.js', { eager: true })`
 * (see `./index.js`) and passes the resulting map here.
 *
 * The registrar API is *injected* (never imported by the consumer) so a
 * contribution never has to reach into team-tracker internals:
 *
 *   // consumer: platform/<name>/team-tracker-contributions.js
 *   export function register({ registerTeamDetailTab, registerReport, registerSettingsTab }) {
 *     registerTeamDetailTab({ ... })
 *   }
 *
 * Resilience mirrors the contribution registry: a throwing or malformed
 * extension is skipped and logged, and never aborts the others. When `platform/`
 * is absent (core / CI), the glob is empty and this is a no-op.
 */

/**
 * Apply platform-provided team-tracker contributions.
 *
 * @param {Record<string, any>} globResult - map of module path → module
 *   namespace object, as returned by `import.meta.glob(..., { eager: true })`.
 * @param {object} api - the registrar API injected into each `register(api)`
 *   (e.g. `{ registerTeamDetailTab, registerReport, registerSettingsTab }`).
 */
export function applyPlatformContributions(globResult, api) {
  if (!globResult || typeof globResult !== 'object') return

  for (const [modulePath, mod] of Object.entries(globResult)) {
    if (!mod || typeof mod.register !== 'function') {
      console.warn(
        `[team-tracker] Skipping platform contribution "${modulePath}": no register() export`
      )
      continue
    }
    try {
      mod.register(api)
    } catch (err) {
      console.error(
        `[team-tracker] Platform contribution "${modulePath}" threw during register(); skipping`,
        err
      )
    }
  }
}
