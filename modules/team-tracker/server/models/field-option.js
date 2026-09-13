const mongoose = require('mongoose')

const fieldOptionSchema = new mongoose.Schema({
  optionId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  label: { type: String, required: true },
  values: { type: [String], default: [] },
  source: { type: String, default: undefined },
  sourceProject: { type: String, default: undefined },
  sourceConfig: { type: mongoose.Schema.Types.Mixed, default: undefined },
  richValues: { type: mongoose.Schema.Types.Mixed, default: undefined },
  orphanedValues: { type: [String], default: undefined },
  syncedAt: { type: String, default: undefined },
  updatedAt: { type: String, default: undefined },
  updatedBy: { type: String, default: undefined },
  migrationDone: { type: Boolean, default: undefined },
  migratedAt: { type: String, default: undefined },
  migratedBy: { type: String, default: undefined }
})

module.exports = { fieldOptionSchema }
