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
    clientName: {
        type: String,
        trim: true,
        default: ''
    },
    caseSummary: {
        type: String,
        trim: true,
        default: ''
    },
    keyIssue: {
        type: String,
        trim: true,
        default: ''
    },
    importantDates: [{
        label: String,
        date: Date
    }],
    isLegalCase: {
        type: Boolean,
        default: false
    }
}, { 
    timestamps: true 
});

const Project = mongoose.model('Project', projectSchema);
export default Project;
