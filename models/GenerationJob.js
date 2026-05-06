import mongoose from 'mongoose';

const GenerationJobSchema = new mongoose.Schema({
  workspaceId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'SocialAgentWorkspace', 
    required: true,
    index: true 
  },
  triggeredBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
  generationMode: { 
    type: String, 
    enum: ['single', 'bulk', 'daily-run', 'regeneration', 'today', 'selected', 'visual_post'], 
    required: true 
  },
  // AI Ads Agent: target calendar entry for visual post generation
  targetEntryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CalendarEntry',
  },
  // AI Ads Agent: resulting asset once job completes
  resultAssetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GeneratedAsset',
  },
  requestedCount: { 
    type: Number, 
    default: 1 
  },
  completedCount: { 
    type: Number, 
    default: 0 
  },
  failedCount: { 
    type: Number, 
    default: 0 
  },
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'], 
    default: 'pending' 
  },
  startedAt: { 
    type: Date 
  },
  completedAt: { 
    type: Date 
  },
  logs: [{
    timestamp: { type: Date, default: Date.now },
    message: { type: String },
    level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' }
  }],
  errorSummary: {
    type: String,
    comment: 'Summary of what went wrong if status is failed'
  }
}, { timestamps: true });

export default mongoose.model('GenerationJob', GenerationJobSchema);
