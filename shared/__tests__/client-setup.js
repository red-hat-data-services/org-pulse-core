// Guard against broken Web Storage globals leaked from Node.js 22's
// --localstorage-file flag (vitest's jsdom env won't override them).
function ensureStorage(name) {
  const storage = globalThis[name]
  if (storage && typeof storage.clear === 'function') return

  let store = {}
  globalThis[name] = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value) },
    removeItem: (key) => { delete store[key] },
    clear: () => { store = {} },
    get length() { return Object.keys(store).length },
    key: (i) => Object.keys(store)[i] ?? null,
  }
}

ensureStorage('localStorage')
ensureStorage('sessionStorage')
