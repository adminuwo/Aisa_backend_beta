import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true
    },
    token: {
        type: String,
        required: true,
        index: true
    },
    device: {
        type: String,
        default: "Unknown Device"
    },
    browser: {
        type: String,
        default: "Unknown Browser"
    },
    os: {
        type: String,
        default: "Unknown OS"
    },
    ip: {
        type: String,
        default: "Unknown IP"
    },
    location: {
        type: String,
        default: "Unknown Location"
    },
    lastActive: {
        type: Date,
        default: Date.now
    },
    isCurrent: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

const Session = mongoose.model("Session", sessionSchema);
export default Session;
