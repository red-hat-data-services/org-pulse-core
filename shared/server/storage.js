/**
 * Local file storage - drop-in replacement for S3 in local development.
 * Reads/writes JSON files to a local data/ directory.
 *
 * All public functions are async using fs.promises for true non-blocking I/O.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let DATA_DIR = path.join(__dirname, '..', '..', 'data');

/**
 * Initialize storage with a custom data directory.
 * Must be called before any read/write operations if overriding the default.
 * @param {{ dataDir: string }} options
 */
function initStorage({ dataDir }) {
  DATA_DIR = path.resolve(dataDir);
}

/**
 * Verify that a resolved path stays within DATA_DIR to prevent path traversal.
 * @param {string} resolvedPath - The fully resolved path to check
 * @returns {boolean} true if safe, false if path escapes DATA_DIR
 */
function isPathSafe(resolvedPath) {
  const resolvedDataDir = path.resolve(DATA_DIR);
  return resolvedPath === resolvedDataDir || resolvedPath.startsWith(resolvedDataDir + path.sep);
}

/**
 * Ensure the data directory and any subdirectories exist
 */
async function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Read JSON from local file
 * @param {string} key - S3-style key (e.g., 'boards.json' or 'sprints/123.json')
 * @returns {Promise<object|null>} Parsed JSON or null if not found
 */
async function readFromStorage(key) {
  const filePath = path.resolve(DATA_DIR, key);
  if (!isPathSafe(filePath)) {
    console.error(`[storage] Blocked path traversal attempt: ${key}`);
    return null;
  }
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Write JSON to local file
 * @param {string} key - S3-style key
 * @param {object} data - Data to write
 * @returns {Promise<void>}
 */
async function writeToStorage(key, data) {
  const filePath = path.resolve(DATA_DIR, key);
  if (!isPathSafe(filePath)) {
    console.error(`[storage] Blocked path traversal attempt: ${key}`);
    return;
  }
  await ensureDir(filePath);
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`Wrote ${key} to local storage`);
}

/**
 * List JSON files in a subdirectory of storage
 * @param {string} dir - Subdirectory name (e.g., 'people')
 * @returns {Promise<string[]>} Array of filenames (without path)
 */
async function listStorageFiles(dir) {
  const dirPath = path.resolve(DATA_DIR, dir);
  if (!isPathSafe(dirPath)) {
    console.error(`[storage] Blocked path traversal attempt: ${dir}`);
    return [];
  }
  try {
    const files = await fsp.readdir(dirPath);
    return files.filter(f => f.endsWith('.json'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Recursively delete a subdirectory of storage
 * @param {string} dir - Subdirectory name (e.g., 'snapshots')
 * @returns {Promise<{ deleted: number }>} Count of JSON files that were in the directory
 */
async function deleteStorageDirectory(dir) {
  const dirPath = path.resolve(DATA_DIR, dir);
  if (!isPathSafe(dirPath)) {
    console.error(`[storage] Blocked path traversal attempt: ${dir}`);
    return { deleted: 0 };
  }
  let deleted = 0;
  try {
    // Count files before deletion (sync walk is fine — directory is about to be removed)
    const countFiles = (p) => {
      const entries = fs.readdirSync(p, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) countFiles(path.join(p, entry.name));
        else if (entry.name.endsWith('.json')) deleted++;
      }
    };
    countFiles(dirPath);
    await fsp.rm(dirPath, { recursive: true, force: true });
    console.log(`Deleted storage directory ${dir} (${deleted} files)`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { deleted: 0 };
    }
    throw error;
  }
  return { deleted };
}

/**
 * Delete a single file from storage
 * @param {string} key - S3-style key (e.g., 'release-planning/candidates-cache-3.5.json')
 * @returns {Promise<void>}
 */
async function deleteFromStorage(key) {
  const filePath = path.resolve(DATA_DIR, key);
  if (!isPathSafe(filePath)) {
    console.error(`[storage] Blocked path traversal attempt: ${key}`);
    return;
  }
  try {
    await fsp.unlink(filePath);
    console.log(`Deleted ${key} from local storage`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist — nothing to delete
      return;
    }
    throw error;
  }
}

/**
 * Get the modification time of a storage file without reading it.
 * @param {string} key - S3-style key
 * @returns {Promise<number|null>} mtime in milliseconds, or null if file doesn't exist or path is unsafe
 */
async function getFileMtime(key) {
  const filePath = path.resolve(DATA_DIR, key);
  if (!isPathSafe(filePath)) {
    console.error(`[storage] Blocked path traversal attempt: ${key}`);
    return null;
  }
  try {
    const stat = await fsp.stat(filePath);
    return stat.mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

module.exports = {
  initStorage,
  readFromStorage,
  writeToStorage,
  listStorageFiles,
  deleteStorageDirectory,
  deleteFromStorage,
  getFileMtime,
  get DATA_DIR() { return DATA_DIR; }
};
