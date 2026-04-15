import mongoose from 'mongoose';

const KnowledgeSourceSchema = new mongoose.Schema({
    url: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    domain: {
        type: String,
        required: true
    },
    crawl_depth: {
        type: Number,
        default: 2
    },
    max_pages: {
        type: Number,
        default: 20
    },
    last_crawled_at: {
        type: Date
    },
    next_crawl_at: {
        type: Date
    },
    update_frequency: {
        type: String,
        enum: ['daily', 'weekly', 'monthly', 'manual'],
        default: 'daily'
    },
    status: {
        type: String,
        enum: ['active', 'paused', 'error'],
        default: 'active'
    },
    pages_indexed: {
        type: Number,
        default: 0
    },
    last_error: {
        type: String
    },
    category: {
        type: String,
        enum: ['LEGAL', 'GENERAL', 'FINANCE'],
        default: 'GENERAL'
    }
}, { timestamps: true });

export default mongoose.model('KnowledgeSource', KnowledgeSourceSchema);
