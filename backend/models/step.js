const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  workflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow', required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['approval', 'notification', 'task'], default: 'task' },
  // Optional configuration per step type
  config: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('Step', stepSchema);