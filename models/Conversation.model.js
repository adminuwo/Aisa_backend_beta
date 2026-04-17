import mongoose from 'mongoose';

const ConversationSchema = new mongoose.Schema({
    userId: {
        type: String,
        default: 'admin', // For now, single user support
        index: true
    },
    title: {
        type: String,
        default: 'New Conversation'
    },
    messages: [{
        role: {
            type: String,
            enum: ['user', 'assistant'],
            required: true
        },
        text: {
            type: String,
            required: true
        },
        isRealTime: {
            type: Boolean,
            default: false
        },
        sources: [{
            title: String,
            url: String
        }],
        suggestions: [String],
        timestamp: {
            type: Date,
            default: Date.now
        }
    }],
    lastMessageAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

export default mongoose.model('Conversation', ConversationSchema);
