import mongoose from 'mongoose';

const GeneratedAssetSchema = new mongoose.Schema({
  postId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'GeneratedPost', 
    required: false,
    index: true 
  },
  // AI Ads Agent: direct link to the calendar entry that triggered generation
  calendarEntryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CalendarEntry',
    index: true
  },
  workspaceId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'SocialAgentWorkspace', 
    required: true,
    index: true 
  },
  assetType: { 
    type: String, 
    enum: ['image', 'carousel', 'video', 'reel', 'carousel_page', 'video_file', 'thumbnail'],
    required: true 
  },
  // AI Ads Agent: 'generated' | 'uploaded'
  assetSource: {
    type: String,
    enum: ['generated', 'uploaded'],
    default: 'generated'
  },
  gcsUrl: { 
    type: String, 
    required: true 
  },
  thumbnailUrl: { 
    type: String 
  },
  duration: { 
    type: Number, 
    comment: 'Seconds for video'
  },
  dimensions: {
    width: { type: Number },
    height: { type: Number }
  },
  mimeType: { 
    type: String 
  },
  fileSize: { 
    type: Number 
  },
  // Flexible metadata — supports both carousel and AI Ads visual pipeline fields
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  dateString: {
    type: String,
    comment: 'Human readable date like Monday, Jan 1'
  }
}, { timestamps: true });

export default mongoose.model('GeneratedAsset', GeneratedAssetSchema);
