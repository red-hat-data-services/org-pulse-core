let mongod

export async function setup() {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server')
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  process.env.MONGODB_URI = mongod.getUri()
}

export async function teardown() {
  if (mongod) await mongod.stop()
}
