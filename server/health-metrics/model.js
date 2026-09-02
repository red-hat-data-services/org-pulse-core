const mongoose = require('mongoose');

const healthMetricsStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  kind: { type: String, required: true, enum: ['aggregate', 'config', 'opted-out'], index: true },
  month: { type: String, default: null },
  data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
}, {
  collection: 'core__health_metrics'
});

const healthMetricsEventSchema = new mongoose.Schema({
  month: { type: String, required: true, index: true },
  event: { type: mongoose.Schema.Types.Mixed },
  recordedAt: { type: Date, default: Date.now, required: true },
  sourceLegacyId: { type: mongoose.Schema.Types.ObjectId },
  sourceLegacyIndex: { type: Number },
  // Kept temporarily so existing month-array documents can migrate in place.
  events: { type: [mongoose.Schema.Types.Mixed], default: undefined }
}, {
  collection: 'core__health_metric_events'
});

healthMetricsEventSchema.index(
  { sourceLegacyId: 1, sourceLegacyIndex: 1 },
  { unique: true, sparse: true }
);
healthMetricsEventSchema.index({ month: 1, recordedAt: 1, _id: 1 });

module.exports = {
  healthMetricsStateSchema,
  healthMetricsEventSchema,
  healthMetricsEventMonthSchema: healthMetricsEventSchema
};
