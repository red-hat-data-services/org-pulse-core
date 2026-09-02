const mongoose = require('mongoose')

const fieldExceptionSchema = new mongoose.Schema({
  exceptionId: { type: String, required: true, unique: true, index: true },
  entityType: { type: String, required: true, enum: ['person', 'team'] },
  entityId: { type: String, required: true },
  fieldId: { type: String, required: true },
  reason: { type: String, required: true },
  createdAt: { type: String, required: true },
  createdBy: { type: String, required: true }
})

fieldExceptionSchema.index({ entityType: 1, entityId: 1, fieldId: 1 }, { unique: true })

module.exports = { fieldExceptionSchema }
