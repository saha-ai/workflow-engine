const mongoose = require('mongoose');

const executionSchema = new mongoose.Schema({
  workflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow', required: true },
  workflowVersion: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'failed', 'canceled', 'waiting_approval'],
    default: 'pending'
  },
  inputData: { type: mongoose.Schema.Types.Mixed, default: {} },
  logs: [{
    step: String,
    ruleCondition: String,
    ruleMatched: Boolean,
    nextStep: String,
    error: String,
    message: String,
    timestamp: { type: Date, default: Date.now }
  }],
  currentStepId: { type: mongoose.Schema.Types.ObjectId, ref: 'Step' },
  retries: { type: Number, default: 0 },
  triggeredBy: { type: String },
  startedAt: Date,
  completedAt: Date
}, { timestamps: true });

module.exports = mongoose.model('Execution', executionSchema);