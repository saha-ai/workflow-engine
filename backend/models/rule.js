const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema({
  stepId: { type: mongoose.Schema.Types.ObjectId, ref: 'Step', required: true },
  priority: { type: Number, default: 0 },
  condition: { type: String, required: true },
  nextStepId: { type: mongoose.Schema.Types.ObjectId, ref: 'Step', default: null } // Allow null
}, { timestamps: true });

module.exports = mongoose.model('Rule', ruleSchema);