const mongoose = require('mongoose')

let memoryServer = null

async function connectDatabase(options = {}) {
  const uri = options.uri || process.env.MONGODB_URI
  const dbName = options.dbName || process.env.DB_NAME || 'org-pulse'

  if (uri) {
    await mongoose.connect(uri, { dbName })
    console.log(`[database] Connected to MongoDB (${dbName})`)
    return mongoose.connection
  }

  // No URI provided. The in-memory fallback is strictly for local dev and
  // tests — never start it in production, where it would create an ephemeral
  // database that silently loses all data on the next redeploy. Refuse
  // explicitly so a misconfigured deployment fails loudly (and the caller
  // falls back to file storage) instead of appearing healthy on a throwaway DB.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'MONGODB_URI is not set in production. Refusing to start an in-memory ' +
      'database (its data is lost on redeploy). Set MONGODB_URI to a managed ' +
      'MongoDB instance.'
    )
  }

  // No URI provided — start an in-memory MongoDB instance (dev/test only)
  let MongoMemoryServer
  try {
    ;({ MongoMemoryServer } = require('mongodb-memory-server'))
  } catch {
    throw new Error(
      'MONGODB_URI is not set and mongodb-memory-server is not installed. ' +
      'Install it as a dev dependency or set MONGODB_URI.'
    )
  }
  memoryServer = await MongoMemoryServer.create()
  const memoryUri = memoryServer.getUri()
  await mongoose.connect(memoryUri, { dbName })
  console.log(`[database] Connected to in-memory MongoDB (${dbName}) at ${memoryUri}`)
  return mongoose.connection
}

async function disconnectDatabase() {
  await mongoose.disconnect()
  if (memoryServer) {
    await memoryServer.stop()
    memoryServer = null
  }
}

function getConnection() {
  return mongoose.connection
}

module.exports = { connectDatabase, disconnectDatabase, getConnection }
