const mongoose = require('mongoose')

const fieldDefinitionSchema = new mongoose.Schema({
  fieldId: { type: String, required: true, unique: true, index: true },
  scope: { type: String, required: true, index: true, enum: ['person', 'team'] },
  label: { type: String },
  type: { type: String }, // 'free-text' | 'constrained' | 'person-reference-linked'
  helpText: { type: String },
  optionsRef: { type: String },
  multiValue: { type: Boolean, default: false },
  required: { type: Boolean, default: false },
  visible: { type: Boolean, default: true },
  primaryDisplay: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  order: { type: Number },
  allowedValues: { type: [String], default: undefined },
  createdAt: { type: String },
  createdBy: { type: String }
}, {
  // No timestamps: the store manages createdAt/createdBy explicitly, matching
  // the file-based format. Mongoose createdAt/updatedAt would only duplicate them.
  collection: 'core__field_definitions'
})

module.exports = { fieldDefinitionSchema }
