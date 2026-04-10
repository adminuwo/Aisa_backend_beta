import mongoose from 'mongoose';

const KnowledgeSchema = new mongoose.Schema({
    filename: {
        type: String,
        required: true
    },
    cloudinaryUrl: {
        type: String
    },
    cloudinaryId: {
        type: String // Public ID
    },
    gcsUri: {
        type: String
    },
    mimetype: {
        type: String
    },
    size: {
        type: Number // In bytes
    },
    category: {
        type: String,
        enum: ['LEGAL', 'GENERAL', 'FINANCE'],
        default: 'GENERAL'
    },
    sourceUrl: {
        type: String
    },
    contentHash: {
        type: String
    },
    knowledgeSourceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'KnowledgeSource'
    },
    // content: { type: String } // Removed to save metadata only
    totalChunks: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['Pending', 'Indexing', 'Active', 'Error'],
        default: 'Pending'
    },
    uploadDate: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('AIBaseKnowledge', KnowledgeSchema);
