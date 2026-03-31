import mongoose from "mongoose";

const aiAdAgentSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    plan: {
        type: String,
        enum: ["low", "medium", "high"],
        default: "medium"
    },
    companyOverview: {
        type: String, // URL to PDF
        required: true
    },
    contentCalendar: {
        type: String, // URL to File (PDF/JSON/XLSX)
        required: true
    },
    brandLogo: {
        type: String, // URL to Image
        required: true
    },
    colorTheme: {
        type: String,
        default: ""
    },
    platforms: [{
        type: String
    }],
    status: {
        type: String,
        enum: ["idle", "generating", "active", "completed"],
        default: "idle"
    },
    generatedAssets: [{
        platform: String,
        type: String, // image, carousel, video
        content: String,
        mediaUrl: String,
        scheduledDate: Date,
        status: {
            type: String,
            default: "pending"
        }
    }]
}, { timestamps: true });

const AiAdAgent = mongoose.model("AiAdAgent", aiAdAgentSchema);
export default AiAdAgent;
