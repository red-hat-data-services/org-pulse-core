/**
 * Search index registry — module-contributed searchable items.
 *
 * Supports two modes:
 * 1. Declarative: module.json `searchIndex` array — auto-generates from data files
 * 2. Custom handler: `context.registerSearchIndex(fn)` — for complex logic
 *
 * @module shared/server/search-index-registry
 */

function getNestedValue(obj, path) {
  if (!path) return obj
  var parts = path.split('.')
  var current = obj
  for (var i = 0; i < parts.length; i++) {
    if (current == null) return null
    current = current[parts[i]]
  }
  return current
}

function matchesFilter(item, filter) {
  if (!filter) return true
  var keys = Object.keys(filter)
  for (var i = 0; i < keys.length; i++) {
    if (item[keys[i]] !== filter[keys[i]]) return false
  }
  return true
}

function resolveParams(template, item) {
  if (!template) return undefined
  var result = {}
  var keys = Object.keys(template)
  for (var i = 0; i < keys.length; i++) {
    var val = template[keys[i]]
    if (typeof val === 'string' && val.startsWith('$')) {
      result[keys[i]] = item[val.slice(1)]
    } else {
      result[keys[i]] = val
    }
  }
  return result
}

function resolveKeywords(fields, item) {
  if (!fields || !Array.isArray(fields)) return []
  var kw = []
  for (var i = 0; i < fields.length; i++) {
    var val = item[fields[i]]
    if (val) kw.push(String(val))
  }
  return kw
}

function processDeclaration(slug, decl, storage) {
  var results = []
  try {
    var data = storage.readFromStorage(decl.source)
    if (!data) return results
    var raw = decl.items ? getNestedValue(data, decl.items) : data
    var arr
    if (Array.isArray(raw)) {
      arr = raw
    } else if (raw && typeof raw === 'object') {
      arr = Object.keys(raw).map(function(k) { return Object.assign({ $key: k }, raw[k]) })
    } else {
      return results
    }
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i]
      if (!matchesFilter(item, decl.filter)) continue
      var label = item[decl.label]
      if (!label && decl.fallbackLabel) label = item[decl.fallbackLabel]
      if (!label) continue
      results.push({
        label: String(label),
        context: decl.context || slug,
        viewId: decl.viewId,
        params: resolveParams(decl.params, item),
        keywords: resolveKeywords(decl.keywords, item),
        module: slug
      })
    }
  } catch (err) {
    console.error('[search-index] Declarative index for "' + slug + '" failed:', err.message)
  }
  return results
}

function createSearchIndexRegistry() {
  var handlers = new Map()
  var declarations = new Map()

  function register(slug, fn) {
    if (typeof fn !== 'function') {
      console.warn('[search-index] Handler for "' + slug + '" is not a function, skipping')
      return
    }
    handlers.set(slug, fn)
  }

  function registerDeclarative(slug, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return
    declarations.set(slug, entries)
  }

  async function collect(storage) {
    var results = []

    for (var entry of declarations) {
      var slug = entry[0]
      var entries = entry[1]
      for (var i = 0; i < entries.length; i++) {
        var items = processDeclaration(slug, entries[i], storage)
        results.push.apply(results, items)
      }
    }

    for (var handlerEntry of handlers) {
      var handlerSlug = handlerEntry[0]
      var fn = handlerEntry[1]
      try {
        var handlerItems = await fn(storage)
        if (Array.isArray(handlerItems)) {
          for (var j = 0; j < handlerItems.length; j++) {
            results.push(Object.assign({}, handlerItems[j], { module: handlerSlug }))
          }
        }
      } catch (err) {
        console.error('[search-index] Module "' + handlerSlug + '" handler failed:', err.message)
      }
    }

    return results
  }

  return { register, registerDeclarative, collect }
}

module.exports = { createSearchIndexRegistry }
