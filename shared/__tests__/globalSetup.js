let mongod

export async function setup() {
  const { MongoMemoryServer } = await import('mongodb-memory-server')
  mongod = await MongoMemoryServer.create()
  process.env.MONGODB_URI = mongod.getUri()
}

export async function teardown() {
  if (mongod) await mongod.stop()
}
