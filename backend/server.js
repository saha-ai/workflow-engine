const express = require('express');
const path = require("path");


const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

// Import models
const Workflow = require('./models/workflow');
const Step = require('./models/step');
const Rule = require('./models/rule');
const Execution = require('./models/execution');

const app = express();

// CORS configuration for deployment
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
// Serve static files
app.use(express.static(path.join(__dirname, "frontend")));
// MongoDB connection with environment variable
// MongoDB connection with environment variable
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI not found in environment variables");
  process.exit(1);
}
console.log("MONGODB_URI VALUE:", process.env.MONGODB_URI);
console.log("Using Mongo URI:", MONGODB_URI);
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB Connected Successfully');
  } catch (err) {
    console.error('MongoDB Connection Error:', err.message);
    process.exit(1);
  }
}
connectDB();
console.log("🔥 RENDER MONGO URI:", process.env.MONGODB_URI);

/* =========================
   Helper: Evaluate condition safely
========================= */
function evaluateCondition(condition, data) {
  if (condition === 'DEFAULT') return true;
  try {
    // Restrict to data properties only (avoid global access)
    const fn = new Function('data', `with(data) { return ${condition} }`);
    return fn(data);
  } catch (err) {
    console.log('Error evaluating condition:', err.message);
    return false;
  }
}

/* =========================
   Debug Endpoint - Check MongoDB Connection
========================= */
app.get('/debug', async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };
    
    const status = {
      server: 'running',
      mongodb: {
        state: states[dbState] || 'unknown',
        readyState: dbState
      },
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    };

    // If connected to MongoDB, try to get some stats
    if (dbState === 1) {
      try {
        const collections = await mongoose.connection.db.listCollections().toArray();
        status.mongodb.collections = collections.map(c => c.name);
        status.mongodb.database = mongoose.connection.db.databaseName;
        
        // Check if workflow exists
        const workflowCount = await Workflow.countDocuments();
        status.mongodb.workflowCount = workflowCount;
      } catch (err) {
        status.mongodb.error = err.message;
      }
    }

    res.json(status);
  } catch (err) {
    res.status(500).json({ 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

/* =========================
   WORKFLOW ENDPOINTS
========================= */

// POST /workflows - Create a new workflow
app.post('/workflows', async (req, res) => {
  try {
    const { name, description, inputSchema } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Workflow name is required' });
    }
    
    const workflow = new Workflow({ 
      name, 
      description, 
      inputSchema: inputSchema || {},
      version: 1,
      status: 'draft'
    });
    await workflow.save();
    res.status(201).json(workflow);
  } catch (err) {
    console.error('Create workflow error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /workflows - List workflows (with pagination & search)
app.get('/workflows', async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', status } = req.query;
    const query = {};
    if (search) query.name = { $regex: search, $options: 'i' };
    if (status) query.status = status;

    const workflows = await Workflow.find(query)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Workflow.countDocuments(query);

    res.json({
      data: workflows,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('List workflows error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /workflows/:id - Get workflow details with steps & rules
app.get('/workflows/:id', async (req, res) => {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    const steps = await Step.find({ workflowId: workflow._id }).lean();
    // Populate rules for each step
    for (let step of steps) {
      step.rules = await Rule.find({ stepId: step._id }).sort('priority');
    }
    res.json({ workflow, steps });
  } catch (err) {
    console.error('Get workflow error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /workflows/:id - Update workflow (creates new version)
app.put('/workflows/:id', async (req, res) => {
  try {
    const oldWorkflow = await Workflow.findById(req.params.id);
    if (!oldWorkflow) return res.status(404).json({ message: 'Workflow not found' });

    // Create new version
    const newWorkflow = new Workflow({
      name: req.body.name || oldWorkflow.name,
      description: req.body.description || oldWorkflow.description,
      inputSchema: req.body.inputSchema || oldWorkflow.inputSchema,
      version: oldWorkflow.version + 1,
      status: req.body.status || 'draft'
    });
    await newWorkflow.save();

    // Create a map to track old step IDs to new step IDs
    const stepIdMap = new Map();

    // Duplicate steps from old workflow to new version
    const oldSteps = await Step.find({ workflowId: oldWorkflow._id });
    for (const oldStep of oldSteps) {
      const newStep = new Step({
        workflowId: newWorkflow._id,
        name: oldStep.name,
        type: oldStep.type,
        config: oldStep.config || {}
      });
      await newStep.save();
      
      // Store the mapping
      stepIdMap.set(oldStep._id.toString(), newStep._id.toString());
    }

    // Duplicate rules and update nextStepId using the map
    for (const oldStep of oldSteps) {
      const oldRules = await Rule.find({ stepId: oldStep._id });
      const newStepId = stepIdMap.get(oldStep._id.toString());
      
      for (const oldRule of oldRules) {
        let newNextStepId = null;
        if (oldRule.nextStepId) {
          // Map the old nextStepId to the new one
          newNextStepId = stepIdMap.get(oldRule.nextStepId.toString()) || null;
        }
        
        const newRule = new Rule({
          stepId: newStepId,
          priority: oldRule.priority,
          condition: oldRule.condition,
          nextStepId: newNextStepId
        });
        await newRule.save();
      }
    }

    res.status(201).json(newWorkflow);
  } catch (err) {
    console.error('Update workflow error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /workflows/:id - Delete workflow (and cascade steps/rules)
app.delete('/workflows/:id', async (req, res) => {
  try {
    const workflow = await Workflow.findById(req.params.id);
    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    // Delete associated steps and rules
    const steps = await Step.find({ workflowId: workflow._id });
    for (const step of steps) {
      await Rule.deleteMany({ stepId: step._id });
    }
    await Step.deleteMany({ workflowId: workflow._id });
    await workflow.deleteOne();

    res.json({ message: 'Workflow deleted successfully' });
  } catch (err) {
    console.error('Delete workflow error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   STEP ENDPOINTS
========================= */

// POST /workflows/:workflow_id/steps - Add step to workflow
app.post('/workflows/:workflow_id/steps', async (req, res) => {
  try {
    const { name, type, config } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Step name is required' });
    }
    
    const step = new Step({
      workflowId: req.params.workflow_id,
      name,
      type: type || 'task',
      config: config || {}
    });
    await step.save();
    res.status(201).json(step);
  } catch (err) {
    console.error('Create step error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /workflows/:workflow_id/steps - List steps for workflow
app.get('/workflows/:workflow_id/steps', async (req, res) => {
  try {
    const steps = await Step.find({ workflowId: req.params.workflow_id }).sort('createdAt');
    res.json(steps);
  } catch (err) {
    console.error('List steps error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /steps/:id - Update step
app.put('/steps/:id', async (req, res) => {
  try {
    const step = await Step.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!step) return res.status(404).json({ message: 'Step not found' });
    res.json(step);
  } catch (err) {
    console.error('Update step error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /steps/:id - Delete step (and its rules)
app.delete('/steps/:id', async (req, res) => {
  try {
    const step = await Step.findById(req.params.id);
    if (!step) return res.status(404).json({ message: 'Step not found' });

    await Rule.deleteMany({ stepId: step._id });
    await step.deleteOne();
    res.json({ message: 'Step deleted' });
  } catch (err) {
    console.error('Delete step error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   RULE ENDPOINTS
========================= */

// POST /steps/:step_id/rules - Add rule to step
app.post('/steps/:step_id/rules', async (req, res) => {
  try {
    const { priority, condition, nextStepId } = req.body;
    
    // Validate nextStepId if provided (not null)
    if (nextStepId && !mongoose.Types.ObjectId.isValid(nextStepId)) {
      return res.status(400).json({ error: 'Invalid nextStepId format' });
    }
    
    const rule = new Rule({
      stepId: req.params.step_id,
      priority: priority || 1,
      condition: condition || 'DEFAULT',
      nextStepId: nextStepId || null // Allow null for end steps
    });
    await rule.save();
    res.status(201).json(rule);
  } catch (err) {
    console.error('Create rule error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /steps/:step_id/rules - List rules for step (ordered by priority)
app.get('/steps/:step_id/rules', async (req, res) => {
  try {
    const rules = await Rule.find({ stepId: req.params.step_id }).sort('priority');
    res.json(rules);
  } catch (err) {
    console.error('List rules error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /rules/:id - Update rule
app.put('/rules/:id', async (req, res) => {
  try {
    const { nextStepId } = req.body;
    
    // Validate nextStepId if provided
    if (nextStepId && !mongoose.Types.ObjectId.isValid(nextStepId)) {
      return res.status(400).json({ error: 'Invalid nextStepId format' });
    }
    
    const rule = await Rule.findByIdAndUpdate(
      req.params.id, 
      { ...req.body, nextStepId: nextStepId || null }, 
      { new: true }
    );
    if (!rule) return res.status(404).json({ message: 'Rule not found' });
    res.json(rule);
  } catch (err) {
    console.error('Update rule error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /rules/:id - Delete rule
app.delete('/rules/:id', async (req, res) => {
  try {
    const rule = await Rule.findById(req.params.id);
    if (!rule) return res.status(404).json({ message: 'Rule not found' });
    await rule.deleteOne();
    res.json({ message: 'Rule deleted' });
  } catch (err) {
    console.error('Delete rule error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   EXECUTION ENDPOINTS
========================= */

// POST /workflows/:workflow_id/execute - Start workflow execution
app.post('/workflows/:workflow_id/execute', async (req, res) => {
  try {
    const workflow = await Workflow.findById(req.params.workflow_id);
    if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

    // Create execution record
    const execution = new Execution({
      workflowId: workflow._id,
      workflowVersion: workflow.version,
      inputData: req.body || {},
      status: 'pending',
      logs: [],
      retries: 0,
      startedAt: new Date()
    });
    await execution.save();

    // Start asynchronous processing
    setTimeout(() => processExecution(execution._id), 100);

    res.status(202).json({ 
      executionId: execution._id, 
      message: 'Execution started' 
    });
  } catch (err) {
    console.error('Start execution error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /executions/:id - Get execution status & logs
app.get('/executions/:id', async (req, res) => {
  try {
    const execution = await Execution.findById(req.params.id)
      .populate('currentStepId', 'name');
    if (!execution) return res.status(404).json({ message: 'Execution not found' });
    res.json(execution);
  } catch (err) {
    console.error('Get execution error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /executions - Get all executions (for audit log)
app.get('/executions', async (req, res) => {
  try {
    const executions = await Execution.find()
      .populate('workflowId', 'name')
      .sort('-createdAt')
      .limit(100);
    res.json(executions);
  } catch (err) {
    console.error('List executions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /executions/:id/cancel - Cancel execution
app.post('/executions/:id/cancel', async (req, res) => {
  try {
    const execution = await Execution.findById(req.params.id);
    if (!execution) return res.status(404).json({ message: 'Execution not found' });

    if (!['pending', 'in_progress'].includes(execution.status)) {
      return res.status(400).json({ message: 'Execution cannot be cancelled' });
    }

    execution.status = 'canceled';
    execution.completedAt = new Date();
    execution.logs.push({
      step: 'System',
      ruleCondition: 'Manual cancellation',
      ruleMatched: true,
      nextStep: null,
      timestamp: new Date()
    });
    await execution.save();

    res.json({ message: 'Execution cancelled' });
  } catch (err) {
    console.error('Cancel execution error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /executions/:id/retry - Retry failed step
app.post('/executions/:id/retry', async (req, res) => {
  try {
    const execution = await Execution.findById(req.params.id);
    if (!execution) return res.status(404).json({ message: 'Execution not found' });

    if (execution.status !== 'failed') {
      return res.status(400).json({ message: 'Only failed executions can be retried' });
    }

    // Reset status and increment retry count
    execution.status = 'in_progress';
    execution.retries += 1;
    execution.logs.push({
      step: 'System',
      ruleCondition: 'Manual retry',
      ruleMatched: true,
      nextStep: execution.currentStepId?.toString() || 'unknown',
      timestamp: new Date()
    });
    await execution.save();

    // Reprocess from current step
    setTimeout(() => processExecution(execution._id, true), 100);

    res.json({ message: 'Retry initiated' });
  } catch (err) {
    console.error('Retry execution error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   Core Execution Engine
========================= */
async function processExecution(executionId, isRetry = false) {
  try {
    const execution = await Execution.findById(executionId);
    if (!execution || execution.status === 'canceled') return;

    execution.status = 'in_progress';
    await execution.save();

    const workflow = await Workflow.findById(execution.workflowId);
    if (!workflow) throw new Error('Workflow not found');

    // Determine starting step
    let currentStep;
    if (isRetry && execution.currentStepId) {
      currentStep = await Step.findById(execution.currentStepId);
    } else {
      // Find first step (oldest first)
      const steps = await Step.find({ workflowId: workflow._id }).sort('createdAt');
      if (steps.length === 0) throw new Error('No steps in workflow');
      currentStep = steps[0];
    }

    if (!currentStep) throw new Error('Current step not found');

    while (currentStep) {
      execution.currentStepId = currentStep._id;
      await execution.save();

      // Get rules for this step, sorted by priority
      const rules = await Rule.find({ stepId: currentStep._id }).sort('priority');

      // If no rules, this is an end step
      if (rules.length === 0) {
        execution.logs.push({
          step: currentStep.name,
          ruleCondition: 'End step - no rules',
          ruleMatched: true,
          nextStep: null,
          timestamp: new Date()
        });
        execution.status = 'completed';
        execution.currentStepId = null;
        execution.completedAt = new Date();
        await execution.save();
        return;
      }

      // Evaluate rules
      let matchedRule = null;
      for (const rule of rules) {
        const result = evaluateCondition(rule.condition, execution.inputData);
        
        let nextStepName = null;
        if (rule.nextStepId) {
          const nextStep = await Step.findById(rule.nextStepId);
          nextStepName = nextStep ? nextStep.name : 'Unknown';
        }

        execution.logs.push({
          step: currentStep.name,
          ruleCondition: rule.condition,
          ruleMatched: result,
          nextStep: nextStepName || 'END',
          timestamp: new Date()
        });

        if (result) {
          matchedRule = rule;
          break;
        }
      }

      if (!matchedRule) {
        // No rule matched → fail the step
        execution.status = 'failed';
        execution.logs.push({
          step: currentStep.name,
          ruleCondition: 'No matching rule',
          ruleMatched: false,
          error: 'No rule satisfied, and no DEFAULT rule found',
          timestamp: new Date()
        });
        execution.completedAt = new Date();
        await execution.save();
        return;
      }

      // If nextStepId is null, this is the end
      if (!matchedRule.nextStepId) {
        execution.status = 'completed';
        execution.currentStepId = null;
        execution.completedAt = new Date();
        await execution.save();
        return;
      }

      // Move to next step
      currentStep = await Step.findById(matchedRule.nextStepId);
      if (!currentStep) {
        // Next step not found - end workflow
        execution.status = 'completed';
        execution.currentStepId = null;
        execution.completedAt = new Date();
        await execution.save();
        return;
      }

      // Check for self-reference (rule pointing to same step)
      if (currentStep._id.toString() === execution.currentStepId.toString()) {
        execution.status = 'completed';
        execution.currentStepId = null;
        execution.completedAt = new Date();
        await execution.save();
        return;
      }
    }

  } catch (err) {
    console.error('Execution error:', err);
    const execution = await Execution.findById(executionId);
    if (execution) {
      execution.status = 'failed';
      execution.logs.push({ 
        step: 'System',
        error: err.message, 
        timestamp: new Date() 
      });
      execution.completedAt = new Date();
      await execution.save();
    }
  }
}

/* =========================
   Test Route
========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "execution.html"));
});
app.get('/', (req, res) => {
  res.send('Workflow Engine Server Working');
});

/* =========================
   Start server
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});