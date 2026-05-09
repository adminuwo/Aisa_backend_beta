import mongoose from 'mongoose';

const creditLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, required: true }, // e.g. 'chat', 'image', 'video', 'edit_image', 'plan_credit', 'purchase'
    description: { type: String, default: '' }, // human-readable label
    credits: { type: Number, required: true },  // negative = deducted, positive = added
    balanceAfter: { type: Number, required: true },
    category: { type: String, default: 'General' },
    createdAt: { type: Date, default: Date.now, index: true }
}, { timestamps: false });

export default mongoose.model('CreditLog', creditLogSchema);
