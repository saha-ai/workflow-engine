const mongoose = require('mongoose');

const workflowSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  inputSchema: {
    type: mongoose.Schema.Types.Mixed, // JSON schema definition
    default: {}
  },
  version: { type: Number, default: 1 },
  status: {
    type: String,
    enum: ['draft', 'active', 'archived'],
    default: 'draft'
  },
  startingStepId: { type: mongoose.Schema.Types.ObjectId, ref: 'Step' } // first step to execute
}, { timestamps: true });

module.exports = mongoose.model('Workflow', workflowSchema);