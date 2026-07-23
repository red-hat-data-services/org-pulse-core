const mongoose = require('mongoose')

const roleAssignmentSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  roles: { type: [String], default: [] },
  assignedBy: { type: String },
  assignedAt: { type: String }
}, {
  // No timestamps: the store manages assignedBy/assignedAt explicitly, matching
  // the file-based format. Mongoose createdAt/updatedAt would only duplicate them.
  collection: 'core__roles'
})

module.exports = { roleAssignmentSchema }
