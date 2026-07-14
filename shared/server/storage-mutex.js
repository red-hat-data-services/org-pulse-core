const { Mutex } = require('async-mutex');

const storageMutexes = new Map();

function getStorageMutex(key) {
  if (!storageMutexes.has(key)) storageMutexes.set(key, new Mutex());
  return storageMutexes.get(key);
}

module.exports = { getStorageMutex };
