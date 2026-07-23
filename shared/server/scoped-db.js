function createScopedDb(connection, slug) {
  const models = new Map()

  const scopedDb = {
    model(name, schema) {
      const collectionName = slug + '__' + name
      if (models.has(collectionName)) return models.get(collectionName)

      const model = connection.model(collectionName, schema, collectionName)
      models.set(collectionName, model)
      return model
    }
  }

  return Object.freeze(scopedDb)
}

module.exports = { createScopedDb }
