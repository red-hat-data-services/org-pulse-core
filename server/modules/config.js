/**
 * Module configuration stored on PVC.
 * Manages registered modules (built-in and git-static).
 */

const path = require('path');
const fs = require('fs');

const CONFIG_KEY = 'modules-config.json';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALID_TYPES = ['built-in', 'git-static'];

const DEFAULT_CONFIG = {
  modules: [{
    name: 'People & Teams',
    slug: 'team-tracker',
    type: 'built-in',
    description: 'Delivery metrics, sprint tracking, and team insights',
    icon: 'bar-chart',
    order: 0
  }]
};

async function updateModulesConfig(storage, updater) {
  if (typeof storage.updateFromStorage === 'function') {
    return storage.updateFromStorage(CONFIG_KEY, updater);
  }
  const current = (await loadModulesConfig(storage)) || { modules: [] };
  const next = updater(current);
  await saveModulesConfig(storage, next);
  return next;
}

async function loadModulesConfig(storage) {
  const config = await storage.readFromStorage(CONFIG_KEY);
  if (config) return config;
  return null;
}

async function saveModulesConfig(storage, config) {
  await storage.writeToStorage(CONFIG_KEY, config);
}

async function seedIfMissing(storage) {
  const existing = await loadModulesConfig(storage);
  if (!existing) {
    await saveModulesConfig(storage, DEFAULT_CONFIG);
    console.log('Modules config: seeded with People & Teams built-in module');
    return DEFAULT_CONFIG;
  }
  return existing;
}

async function getModule(storage, slug) {
  const config = await loadModulesConfig(storage);
  if (!config || !config.modules) return null;
  return config.modules.find(m => m.slug === slug) || null;
}

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug) && slug.length <= 64;
}

function isValidGitUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateModule(mod, existingModules, excludeSlug) {
  const errors = [];

  if (!mod.name || typeof mod.name !== 'string' || !mod.name.trim()) {
    errors.push('name is required');
  }
  if (!mod.slug || !isValidSlug(mod.slug)) {
    errors.push('slug must be lowercase alphanumeric with hyphens (e.g., "my-module")');
  }
  if (!mod.type || !VALID_TYPES.includes(mod.type)) {
    errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  }

  // Check slug uniqueness
  if (mod.slug && existingModules) {
    const conflict = existingModules.find(m => m.slug === mod.slug && m.slug !== excludeSlug);
    if (conflict) {
      errors.push(`slug "${mod.slug}" is already in use`);
    }
  }

  // Git-static specific validation
  if (mod.type === 'git-static') {
    if (!mod.gitUrl || !isValidGitUrl(mod.gitUrl)) {
      errors.push('gitUrl must be a valid HTTPS URL');
    }
    if (mod.gitSubdirectory && mod.gitSubdirectory.includes('..')) {
      errors.push('gitSubdirectory must not contain ".."');
    }
  }

  return errors;
}

async function addModule(storage, mod) {
  let newModule;
  let validationError;
  await updateModulesConfig(storage, config => {
    const errors = validateModule(mod, config.modules);
    if (errors.length > 0) {
      validationError = errors.join('; ');
      return config;
    }
    newModule = {
      name: mod.name.trim(), slug: mod.slug, type: mod.type,
      description: (mod.description || '').trim(), icon: mod.icon || 'box',
      order: typeof mod.order === 'number' ? mod.order : config.modules.length
    };
    if (mod.type === 'git-static') {
      Object.assign(newModule, {
        gitUrl: mod.gitUrl, gitBranch: mod.gitBranch || 'main',
        gitSubdirectory: mod.gitSubdirectory || '/', gitToken: mod.gitToken || null,
        lastSyncAt: null, lastSyncStatus: null, lastSyncError: null
      });
    }
    config.modules.push(newModule);
    return config;
  });
  if (validationError) return { error: validationError };
  return { module: newModule };
}

async function updateModule(storage, slug, updates) {
  let updatedModule;
  let updateError;
  await updateModulesConfig(storage, config => {
    const idx = config.modules.findIndex(m => m.slug === slug);
    if (idx === -1) {
      updateError = `Module "${slug}" not found`;
      return config;
    }
    const existing = config.modules[idx];
    const merged = { ...existing, ...updates, slug: existing.slug };
    const errors = validateModule(merged, config.modules, slug);
    if (errors.length > 0) {
      updateError = errors.join('; ');
      return config;
    }
    const allowedFields = ['name', 'description', 'icon', 'order', 'gitUrl', 'gitBranch', 'gitSubdirectory', 'gitToken'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) existing[field] = updates[field];
    }
    updatedModule = existing;
    return config;
  });
  if (updateError) return { error: updateError };
  return { module: updatedModule };
}

async function removeModule(storage, slug, contentStorage = storage) {
  let removed;
  await updateModulesConfig(storage, config => {
    const idx = config.modules.findIndex(m => m.slug === slug);
    if (idx !== -1) removed = config.modules.splice(idx, 1)[0];
    return config;
  });
  if (!removed) return { error: `Module "${slug}" not found` };

  // Clean up module content directory
  if (removed.type === 'git-static' && contentStorage.DATA_DIR) {
    const moduleDir = path.join(contentStorage.DATA_DIR, 'modules', slug);
    const expectedPrefix = path.join(contentStorage.DATA_DIR, 'modules');
    const resolved = path.resolve(moduleDir);
    if (resolved.startsWith(expectedPrefix + path.sep) && fs.existsSync(resolved)) {
      try {
        fs.rmSync(resolved, { recursive: true, force: true });
        console.log(`Removed module content directory: ${resolved}`);
      } catch (err) {
        console.error(`Failed to remove module directory ${resolved}:`, err.message);
      }
    }
  }

  return { removed };
}

/**
 * Strip sensitive fields for public API responses.
 * Returns only display fields.
 */
function sanitizeForPublic(mod) {
  return {
    name: mod.name,
    slug: mod.slug,
    type: mod.type,
    description: mod.description,
    icon: mod.icon,
    order: mod.order,
    lastSyncStatus: mod.lastSyncStatus || null
  };
}

/**
 * Mask sensitive fields for admin API responses.
 * Shows git fields but masks tokens.
 */
function sanitizeForAdmin(mod) {
  const result = { ...mod };
  if (result.gitToken) {
    result.gitToken = '••••••••';
  }
  return result;
}

async function updateSyncStatus(storage, slug, status, error) {
  await updateModulesConfig(storage, config => {
    const mod = config.modules.find(m => m.slug === slug);
    if (mod) {
      mod.lastSyncAt = new Date().toISOString();
      mod.lastSyncStatus = status;
      mod.lastSyncError = error || null;
    }
    return config;
  });
}

module.exports = {
  loadModulesConfig,
  saveModulesConfig,
  seedIfMissing,
  getModule,
  addModule,
  updateModule,
  removeModule,
  isValidSlug,
  isValidGitUrl,
  validateModule,
  sanitizeForPublic,
  sanitizeForAdmin,
  updateSyncStatus
};
