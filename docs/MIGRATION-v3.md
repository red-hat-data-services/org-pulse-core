# Migration Guide: v2.x → v3.0.0 (Async Storage API)

This guide covers the breaking changes in v3.0.0 where all storage and
role-store APIs were converted from synchronous to asynchronous.

## What Changed

All storage functions now return Promises and use `fs.promises` internally
for true non-blocking I/O. The `writeToStorageAtomic` function was removed
(it was unused).

### Storage API

Every storage function is now `async`. Callers must `await` them.

**Before:**
```js
const data = storage.readFromStorage('config.json');
storage.writeToStorage('config.json', data);
const files = storage.listStorageFiles('people');
```

**After:**
```js
const data = await storage.readFromStorage('config.json');
await storage.writeToStorage('config.json', data);
const files = await storage.listStorageFiles('people');
```

All affected functions:
- `readFromStorage(key)` → `async readFromStorage(key)`
- `writeToStorage(key, data)` → `async writeToStorage(key, data)`
- `listStorageFiles(dir)` → `async listStorageFiles(dir)`
- `deleteStorageDirectory(dir)` → `async deleteStorageDirectory(dir)`
- `deleteFromStorage(key)` → `async deleteFromStorage(key)`
- `getFileMtime(key)` → `async getFileMtime(key)`

**Removed:**
- `writeToStorageAtomic` — no callers existed; use `writeToStorage` instead

### Role Store API

All role store methods are now async (they were already returning Promises
in some cases, but now consistently do so).

**Before:**
```js
const roles = roleStore.getRoles(email);
const isAdmin = roleStore.hasRole(email, 'admin');
```

**After:**
```js
const roles = await roleStore.getRoles(email);
const isAdmin = await roleStore.hasRole(email, 'admin');
```

### Route Handlers

Express route handlers that call storage must be `async`:

**Before:**
```js
router.get('/data', (req, res) => {
  const data = storage.readFromStorage('data.json');
  res.json(data);
});
```

**After:**
```js
router.get('/data', async (req, res) => {
  const data = await storage.readFromStorage('data.json');
  res.json(data);
});
```

### Refresh Handlers

Refresh handler functions should `await` storage calls:

```js
context.registerRefresh('my-refresh', {
  handler: async (storage) => {
    const data = await storage.readFromStorage('cache.json');
    // ... process ...
    await storage.writeToStorage('cache.json', result);
  }
});
```

### Diagnostics Functions

```js
context.registerDiagnostics(async (storage) => {
  const config = await storage.readFromStorage('my-config.json');
  return { configured: !!config };
});
```

## Test Mock Updates

### createTestContext

`createTestContext()` from `@shared/server` now provides async storage
mocks by default. If you override storage in tests, make your mock
functions async:

**Before:**
```js
const ctx = createTestContext({
  storage: {
    readFromStorage: () => myData,
    writeToStorage: () => {}
  }
});
```

**After:**
```js
const ctx = createTestContext({
  storage: {
    readFromStorage: async () => myData,
    writeToStorage: async () => {}
  }
});
```

### Inline Test Mocks

When creating storage mocks directly in tests:

```js
function makeStorage(data = {}) {
  return {
    async readFromStorage(key) { return data[key] ?? null },
    async writeToStorage(key, val) { data[key] = val },
    async listStorageFiles(dir) { return [] },
    async deleteStorageDirectory() { return { deleted: 0 } },
    async deleteFromStorage() {},
    async getFileMtime() { return null }
  };
}
```

### Testing Thrown Errors

Functions that previously threw synchronously now reject with errors:

**Before:**
```js
expect(() => {
  fieldStore.createField(storage, badInput);
}).toThrow('validation error');
```

**After:**
```js
await expect(
  fieldStore.createField(storage, badInput)
).rejects.toThrow('validation error');
```

## Race Condition Protection

v3.0.0 adds `async-mutex` for protecting read-modify-write operations.
This is handled internally by the core stores — module code does not need
to acquire mutexes manually. If your module has its own read-modify-write
patterns on shared storage keys, consider adding your own mutex.

## Checklist

- [ ] All `readFromStorage` / `writeToStorage` / `listStorageFiles` /
      `deleteStorageDirectory` / `deleteFromStorage` / `getFileMtime`
      calls are `await`ed
- [ ] Route handlers calling storage are `async`
- [ ] Refresh handlers `await` storage calls
- [ ] Diagnostics functions `await` storage calls
- [ ] Test mocks return Promises (or use `async` functions)
- [ ] `expect(...).toThrow()` converted to `await expect(...).rejects.toThrow()`
      for functions that are now async
- [ ] No references to `writeToStorageAtomic` (removed)
