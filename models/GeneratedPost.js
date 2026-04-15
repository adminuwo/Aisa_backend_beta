import mongoose from 'mongoose';

const GeneratedPostSchema = new mongoose.Schema({
  workspaceId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'SocialAgentWorkspace', 
    required: true,
    index: true
  },
  calendarEntryId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'CalendarEntry',
    index: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GenerationJob',
    index: true
  },
  type: { 
    type: String, 
    enum: ['image', 'carousel', 'video', 'reel', 'story', 'static'], 
    required: true 
  },
  platform: { 
    type: String, 
    enum: ['instagram', 'facebook', 'linkedin', 'twitter', 'youtube'],
    required: true 
  },
  aspectRatio: { 
    type: String, 
    default: '4:5' 
  },
  hook: { type: String },
  onAssetText: { type: String },
  captionShort: { type: String },
  captionLong: { type: String },
  hashtags: [{ type: String }],
  cta: { type: String },
  variations: [{
    type: { type: String },
    text: { type: String }
  }],
  status: { 
    type: String, 
    enum: ['draft', 'in_review', 'approved', 'rejected', 'scheduled', 'published', 'failed'], 
    default: 'draft' 
  },
  // Analytics Readiness (Phase 3)
  analytics: {
    impressions: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    commentsCount: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    saves: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    engagementRate: { type: Number, default: 0 }
  },
  version: { 
    type: Number, 
    default: 1 
  },
  primaryAssetId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'GeneratedAsset' 
  },
  parentPostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GeneratedPost',
    comment: 'Refers to the original post if this is a regeneration/version'
  },
  regenerationIntent: {
    type: String,
    comment: 'e.g. stronger CTA, shorter caption'
  },
  scheduledDate: { 
    type: Date,
    index: true 
  },
  dateString: {
    type: String,
    comment: 'Human readable date like Monday, Jan 1'
  }
}, { timestamps: true });

export default mongoose.model('GeneratedPost', GeneratedPostSchema);
