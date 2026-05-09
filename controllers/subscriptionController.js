import Subscription from '../models/Subscription.js';
import Plan from '../models/Plan.js';
import CreditPackage from '../models/CreditPackage.js';
import User from '../models/User.js';
import CreditLog from '../models/CreditLog.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret'
});

export const getSubscriptionDetails = async (req, res) => {
    try {
        const userId = req.user.id || req.user._id; // assumes protectAuth middleware sets req.user
        const subscription = await Subscription.findOne({ userId, subscriptionStatus: 'active' }).populate('planId');
        const user = await User.findById(userId).select('credits founderStatus');

        res.status(200).json({
            success: true,
            subscription,
            credits: user?.credits || 0,
            founderStatus: user?.founderStatus || false
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getCreditLogs = async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const logs = await CreditLog.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50);

        res.status(200).json({
            success: true,
            logs
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const createOrder = async (req, res) => {
    try {
        const { planId, packageId, billingCycle } = req.body;
        let amount = 0;

        if (planId) {
            const plan = await Plan.findById(planId);
            if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });
            amount = billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
        } else if (packageId) {
            const creditPackage = await CreditPackage.findById(packageId);
            if (!creditPackage) return res.status(404).json({ success: false, message: "Package not found" });
            amount = creditPackage.price;
        } else {
            return res.status(400).json({ success: false, message: "Invalid request" });
        }

        if (amount === 0) {
            return res.status(200).json({ success: true, isFree: true });
        }

        const options = {
            amount: amount * 100, // INR in paise
            currency: "INR",
            receipt: `order_rcptid_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);
        res.status(200).json({
            success: true,
            order,
            key: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const purchasePlan = async (req, res) => {
    try {
        const { planId, billingCycle } = req.body;
        const userId = req.user.id || req.user._id;

        const plan = await Plan.findById(planId);
        if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });

        const user = await User.findById(userId);

        if (plan.planName === 'Founder Plan') {
            const founderCount = await User.countDocuments({ founderStatus: true });
            if (founderCount >= 500 && !user.founderStatus) {
                return res.status(400).json({ success: false, message: "Founder plan limit reached." });
            }
            user.founderStatus = true;
        }

        await Subscription.updateMany({ userId, subscriptionStatus: 'active' }, { subscriptionStatus: 'cancelled' });

        // AWARD CREDITS: Use DB field if yearly, otherwise use monthly
        let finalCredits = (billingCycle === 'yearly')
            ? (plan.creditsYearly || plan.credits * 12)
            : plan.credits;

        const isFirstPurchase = await Subscription.countDocuments({ userId }) === 0;

        // Give extra credits for the very first purchase (excluding Founder)
        if (isFirstPurchase && !plan.planName.toLowerCase().includes('founder')) {
            finalCredits += finalCredits * 0.5;
        }

        user.credits = Math.floor(finalCredits);

        // VALIDITY: Calculate the Renewal/Expiry Date
        let renewalDate = new Date();
        if (plan.planName.toLowerCase().includes('founder')) {
            // Lifetime validity (100 years)
            renewalDate.setFullYear(renewalDate.getFullYear() + 100);
        } else if (billingCycle === 'yearly') {
            // Use validity from DB (default 12 months)
            const months = plan.validityYearly || 12;
            renewalDate.setMonth(renewalDate.getMonth() + months);
        } else {
            // Use validity from DB (default 1 month)
            const months = plan.validityMonthly || 1;
            renewalDate.setMonth(renewalDate.getMonth() + months);
        }

        const newSubscription = await Subscription.create({
            userId,
            planId: plan._id,
            creditsRemaining: user.credits,
            billingCycle,
            subscriptionStart: new Date(),
            renewalDate,
            subscriptionStatus: 'active',
            paymentId: "mock_payment_id_for_now"
        });

        await user.save();

        // 📝 Log Plan Credit
        await CreditLog.create({
            userId,
            action: 'plan_credit',
            description: `Subscription: ${plan.planName}`,
            credits: finalCredits,
            balanceAfter: user.credits
        });

        res.status(200).json({
            success: true,
            subscription: newSubscription,
            credits: user.credits,
            message: "Plan upgraded successfully."
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const purchaseCredits = async (req, res) => {
    try {
        const { packageId } = req.body;
        const userId = req.user.id || req.user._id;

        const creditPackage = await CreditPackage.findById(packageId);
        if (!creditPackage) return res.status(404).json({ success: false, message: "Package not found" });

        const user = await User.findById(userId);
        user.credits += creditPackage.credits;
        await user.save();

        // 📝 Log Credit Purchase
        await CreditLog.create({
            userId,
            action: 'purchase',
            description: `Purchased: ${creditPackage.packageName}`,
            credits: creditPackage.credits,
            balanceAfter: user.credits
        });

        res.status(200).json({
            success: true,
            credits: user.credits,
            message: "Credits purchased successfully."
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deductCredits = async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const { amount, description, tool, category } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: "Invalid amount" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.credits < amount) {
            return res.status(403).json({ 
                success: false, 
                code: 'OUT_OF_CREDITS',
                message: "Insufficient credits",
                available: user.credits
            });
        }

        // Atomically deduct credits
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            { $inc: { credits: -amount } },
            { new: true }
        );

        // 📝 Log Credit Deduction
        const log = await CreditLog.create({
            userId,
            action: tool || 'tool_usage',
            description: description || `Used tool: ${tool}`,
            credits: -amount,
            balanceAfter: updatedUser.credits,
            category: category || 'AI Legal'
        });

        res.status(200).json({
            success: true,
            credits: updatedUser.credits,
            log,
            message: "Credits deducted successfully."
        });
    } catch (error) {
        console.error("Deduct Credits Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

