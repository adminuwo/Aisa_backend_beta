import mongoose from 'mongoose';

const SocialAgentWorkspaceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isPersonalProfile: { type: Boolean, default: false },
  planType: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Low' },
  selectedPlatforms: [{ type: String, enum: ['Instagram', 'Facebook', 'LinkedIn', 'X/Twitter', 'Threads', 'Pinterest', 'YouTube'] }],
  postSizeRules: {
    youtube: { type: String, default: '1:1' },
    default: { type: String, default: '4:5' }
  },
  status: { type: String, enum: ['setup', 'active', 'paused'], default: 'setup' },

  onboarding: {
    completed: { type: Boolean, default: false },
    role: String,
    industry: String,
    customName: String,
    contentCreationTime: String,
    postingFrequency: String,
    adsComfortLevel: String,
    biggestChallenge: String
  },
  currentStrategy: {
    summary: String,
    distribution: {
      educational: String,
      promotional: String,
      engagement: String,
      emotional: String
    },
    platform_plan: [mongoose.Schema.Types.Mixed],
    weekly_themes: [mongoose.Schema.Types.Mixed]
  }
}, { timestamps: true });

export default mongoose.models.SocialAgentWorkspace || mongoose.model('SocialAgentWorkspace', SocialAgentWorkspaceSchema);
