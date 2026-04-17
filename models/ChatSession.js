import mongoose from 'mongoose';


const messageSchema = new mongoose.Schema({
  id: String,
  role: {
    type: String,
    enum: ['user', 'model', 'assistant'],
    required: true
  },
  content: { type: String, required: true },
  timestamp: {
    type: mongoose.Schema.Types.Mixed,
    default: Date.now,
    set: (v) => {
      if (typeof v === 'string') return new Date(v).getTime() || Date.now();
      if (v instanceof Date) return v.getTime();
      return v;
    }
  },
  attachments: [{
    type: { type: String }, // Flexible type
    url: String,
    name: String
  }],
  imageUrl: String,
  videoUrl: String,
  conversion: {
    file: String, // base64
    blobUrl: String, // temporary url
    fileName: String,
    mimeType: String,
    fileSize: String,
    rawSize: Number,
    charCount: Number
  },
  isProcessing: Boolean,
  isRealTime: { type: Boolean, default: false },
  sources: [{
    title: String,
    url: String,
    description: String
  }],
  agentName: String,
  agentCategory: String,
  suggestions: [String]
});

const chatSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  guestId: {
    type: String,
    index: true,
    required: false
  },
  title: { type: String, default: 'New Chat' },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    index: true,
    required: false
  },
  messages: [messageSchema],
  lastModified: { type: Number, default: Date.now },
  detectedMode: { type: String, default: 'NORMAL_CHAT' },
  isShared: { type: Boolean, default: false },
  shareId: { type: String, unique: true, sparse: true, index: true }
}, { timestamps: true });
const ChatSession = mongoose.model('ChatSession', chatSessionSchema);
export default ChatSession