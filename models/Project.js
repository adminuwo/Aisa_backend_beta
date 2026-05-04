import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    // --- Basic Case Info ---
    clientName: {
        type: String,
        trim: true,
        default: ''
    },
    summary: {
        type: String,
        trim: true,
        default: ''
    },
    // Backward compatibility for existing data
    caseSummary: {
        type: String,
        trim: true
    },
    caseType: {
        type: String,
        trim: true,
        default: ''
    },
    status: {
        type: String,
        enum: ['Active', 'Closed', 'Archived'],
        default: 'Active'
    },
    stage: {
        type: String,
        enum: ['Pre-litigation', 'Notice', 'Court', 'Judgment', 'Settled'],
        default: 'Pre-litigation'
    },
    priority: {
        type: String,
        enum: ['Low', 'Medium', 'High', 'Urgent'],
        default: 'Medium'
    },
    // --- Parties ---
    opponentName: {
        type: String,
        trim: true,
        default: ''
    },
    lawyers: [{
        name: String,
        role: String,
        contact: String
    }],
    // --- Case Content ---
    facts: [{
        date: Date,
        event: String,
        description: String
    }],
    legalIssues: [{
        type: String,
        trim: true
    }],
    reliefGoals: {
        type: String,
        trim: true,
        default: ''
    },
    // --- Evidence & Documents ---
    documents: [{
        name: String,
        type: { type: String, enum: ['Notice', 'Agreement', 'Proof', 'Filing', 'Other'] },
        url: String,
        tags: [String],
        extractedData: mongoose.Schema.Types.Mixed,
        uploadDate: { type: Date, default: Date.now }
    }],
    evidence: [],
    savedPrecedents: [],
    // --- AI Intelligence & Risk ---
    intelligence: {
        strengthScore: { type: Number, default: 0 }, // 0-100
        winProbability: { type: Number, default: 0 }, // 0-100
        riskLevel: { type: String, enum: ['Low', 'Medium', 'High', 'Critical'], default: 'Medium' },
        weakPoints: [String],
        missingEvidence: [String],
        opponentStrategies: [String],
        strategyRecommendations: [String]
    },
    // --- Tasks & Timeline ---
    tasks: [{
        title: String,
        description: String,
        status: { type: String, enum: ['Pending', 'In Progress', 'Completed'], default: 'Pending' },
        deadline: Date,
        priority: String
    }],
    // --- Communication Logs ---
    communicationLogs: [{
        type: { type: String, enum: ['Call', 'Email', 'Note', 'Meeting'] },
        summary: String,
        timestamp: { type: Date, default: Date.now }
    }],
    // --- Legal Research ---
    research: [{
        lawName: String,
        section: String,
        description: String,
        referenceUrl: String
    }],
    // --- Compatibility/Legacy ---
    isLegalCase: {
        type: Boolean,
        default: false
    },
    accused: { // Kept for backward compatibility
        type: String,
        trim: true,
        default: ''
    },
    keyIssue: { // Kept for backward compatibility
        type: String,
        trim: true,
        default: ''
    },
    importantDates: [{ // Kept for backward compatibility
        label: String,
        date: Date
    }],
    hearings: [{
        date: { type: Date, required: false },
        time: String,
        courtName: String,
        location: String,
        notes: String,
        status: { 
            type: String, 
            enum: ['Upcoming', 'Completed', 'Missed'], 
            default: 'Upcoming' 
        }
    }]
}, { 
    timestamps: true,
    strict: false 
});

const Project = mongoose.model('Project', projectSchema);
export default Project;
