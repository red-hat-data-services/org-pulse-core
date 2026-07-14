/**
 * Demo mode storage - reads from fixtures/ directory.
 * Write operations are no-ops (demo data is read-only).
 *
 * All public functions are async using fs.promises for true non-blocking I/O.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let FIXTURES_DIRS = [path.join(__dirname, '..', '..', 'fixtures')];

/**
 * Initialize demo storage with custom fixture directories.
 * Directories are searched in order; first match wins.
 * @param {{ fixturesDirs: string[] }} options
 */
function initDemoStorage({ fixturesDirs }) {
  FIXTURES_DIRS = fixturesDirs.map(d => path.resolve(d));
}

function isPathSafeForDir(resolvedPath, baseDir) {
  const resolvedBase = path.resolve(baseDir);
  return resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + path.sep);
}

/**
 * Find a file across all fixture directories. Returns the first match.
 * @param {string} key - Relative path
 * @returns {Promise<{ filePath: string, baseDir: string } | null>}
 */
async function findInFixtures(key) {
  for (const dir of FIXTURES_DIRS) {
    const filePath = path.resolve(dir, key);
    if (!isPathSafeForDir(filePath, dir)) continue;
    try {
      await fsp.access(filePath);
      return { filePath, baseDir: dir };
    } catch {
      // File doesn't exist in this directory, try next
    }
  }
  return null;
}

/**
 * Read JSON from fixtures directory
 * @param {string} key - Path relative to fixtures/ (e.g., 'team-data/registry.json' or 'people/name.json')
 * @returns {Promise<object|null>} Parsed JSON or null if not found
 */
async function readFromStorage(key) {
  const found = await findInFixtures(key);
  if (!found) return null;
  try {
    const content = await fsp.readFile(found.filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * No-op write for demo mode (fixtures are read-only)
 * @param {string} key - Would-be path
 * @param {object} _data - Data that would be written
 * @returns {Promise<void>}
 */
async function writeToStorage(key, _data) {
  console.log(`[Demo Mode] Write ignored: ${key}`);
}

/**
 * List JSON files in a subdirectory of fixtures
 * @param {string} dir - Subdirectory name (e.g., 'people')
 * @returns {Promise<string[]>} Array of filenames (without path)
 */
async function listStorageFiles(dir) {
  const seen = new Set();
  const results = [];
  for (const baseDir of FIXTURES_DIRS) {
    const dirPath = path.resolve(baseDir, dir);
    if (!isPathSafeForDir(dirPath, baseDir)) continue;
    try {
      const files = await fsp.readdir(dirPath);
      for (const f of files) {
        if (f.endsWith('.json') && !seen.has(f)) {
          seen.add(f);
          results.push(f);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return results;
}

/**
 * No-op delete for demo mode (fixtures are read-only)
 * @param {string} dir - Would-be directory to delete
 * @returns {Promise<{ deleted: number }>}
 */
async function deleteStorageDirectory(dir) {
  console.log(`[Demo Mode] Delete ignored: ${dir}`);
  return { deleted: 0 };
}

/**
 * No-op single file delete for demo mode (fixtures are read-only)
 * @param {string} key - Would-be file to delete
 * @returns {Promise<void>}
 */
async function deleteFromStorage(key) {
  console.log(`[Demo Mode] Delete ignored: ${key}`);
}

/**
 * Get the modification time of a fixture file without reading it.
 * In demo mode, mtimes are static — polling detects no changes (by design).
 * @param {string} key - S3-style key
 * @returns {Promise<number|null>} mtime in milliseconds, or null if not found
 */
async function getFileMtime(key) {
  const found = await findInFixtures(key);
  if (!found) return null;
  try {
    const stat = await fsp.stat(found.filePath);
    return stat.mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

module.exports = {
  initDemoStorage,
  readFromStorage,
  writeToStorage,
  listStorageFiles,
  deleteStorageDirectory,
  deleteFromStorage,
  getFileMtime,
  get FIXTURES_DIR() { return FIXTURES_DIRS[0]; }
};
