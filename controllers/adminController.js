import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import Plan from '../models/Plan.js';
import CreditPackage from '../models/CreditPackage.js';
import CreditLog from '../models/CreditLog.js';
import SupportTicket from '../models/SupportTicket.js';
import FeatureCredit from '../models/FeatureCredit.js';

export const getFeatureCredits = async (req, res) => {
    try {
        const features = await FeatureCredit.find({});
        res.status(200).json({ success: true, features });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch feature credits' });
    }
};

export const updateFeatureCredit = async (req, res) => {
    try {
        const { id } = req.params;
        const { cost, uiLabel, isActive } = req.body;
        
        const feature = await FeatureCredit.findByIdAndUpdate(
            id, 
            { cost, uiLabel, isActive }, 
            { new: true }
        );
        
        if (!feature) {
            return res.status(404).json({ success: false, message: 'Feature not found' });
        }
        
        // Notify the application to refresh its RAM cache
        try {
            const { refreshFeatureCostCache } = await import('../services/subscriptionService.js');
            await refreshFeatureCostCache();
        } catch(cacheErr) {
            console.error("Failed to refresh feature cost cache:", cacheErr);
        }
        
        res.status(200).json({ success: true, feature });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update feature credit' });
    }
};

export const getAdminStats = async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const pendingTickets = await SupportTicket.countDocuments({ status: { $in: ['pending', 'open', 'in_progress'] } });
        const activeSubscriptionsCount = await Subscription.countDocuments({ 
          subscriptionStatus: 'active' 
        });

        // Revenue calculation: Sum of plan prices for all successful/active paid subscriptions
        // Note: Joining with Plan model to get the current price at the time of calculation
        const revenueAggregation = await Subscription.aggregate([
          { $match: { subscriptionStatus: 'active', paymentId: { $exists: true, $ne: "" } } },
          {
            $lookup: {
              from: 'plans',
              localField: 'planId',
              foreignField: '_id',
              as: 'planDetails'
            }
          },
          { $unwind: '$planDetails' },
          {
            $group: {
              _id: null,
              total: {
                $sum: {
                  $cond: [
                    { $eq: ['$billingCycle', 'yearly'] },
                    '$planDetails.priceYearly',
                    '$planDetails.priceMonthly'
                  ]
                }
              }
            }
          }
        ]);
        const totalRevenue = revenueAggregation.length > 0 ? revenueAggregation[0].total : 0;

        // Credit usage from real logs
        const creditUsageData = await CreditLog.aggregate([
            { $match: { credits: { $lt: 0 } } },
            { $group: { 
                _id: null, 
                totalUsed: { $sum: { $abs: "$credits" } } 
            } }
        ]);
        const totalCreditsUsed = creditUsageData.length > 0 ? creditUsageData[0].totalUsed : 0;

        // Tool usage analytics grouped by action
        const toolUsage = await CreditLog.aggregate([
            { $match: { credits: { $lt: 0 } } },
            { $group: { 
                _id: "$action", 
                count: { $sum: 1 }, 
                totalCredits: { $sum: { $abs: "$credits" } } 
            } },
            { $sort: { count: -1 } }
        ]);

        res.status(200).json({
            success: true,
            stats: {
                totalUsers,
                activeSubscriptions: activeSubscriptionsCount,
                totalRevenue,
                totalCreditsUsed,
                toolUsage,
                pendingTickets
            }
        });
    } catch (error) {
        console.error("[getAdminStats Error]", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const searchUserByEmail = async (req, res) => {
    try {
        const { email } = req.query;
        const user = await User.findOne({ email }).select('name email credits role isBlocked');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const subscription = await Subscription.findOne({ userId: user._id }).populate('planId');
        
        res.status(200).json({
            success: true,
            user,
            subscription
        });
    } catch (error) {
        console.error("[searchUserByEmail Error]", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const adjustCredits = async (req, res) => {
    try {
        const { userId, credits, amount } = req.body;
        const adminId = req.user.id;
        
        // Find the target user and admin
        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });
        
        let adminUser = await User.findById(adminId);
        if (!adminUser) {
            adminUser = await User.findOne({ email: 'admin@uwo24.com' });
        }
        if (!adminUser) return res.status(404).json({ success: false, message: 'Admin not found' });
        
        const oldCredits = targetUser.credits || 0;
        
        // Determine the delta to transfer
        // If 'amount' is provided, we use it directly (additive)
        // If only 'credits' is provided, we calculate the difference (absolute update)
        let creditsToTransfer = 0;
        if (typeof amount === 'number') {
            creditsToTransfer = amount;
        } else if (typeof credits === 'number') {
            creditsToTransfer = credits - oldCredits;
        }

        const newTargetCredits = oldCredits + creditsToTransfer;
        
        if (creditsToTransfer > 0) {
            if ((adminUser.credits || 0) < creditsToTransfer) {
                return res.status(400).json({ success: false, message: 'Admin does not have enough credits to transfer.' });
            }
        }
        
        if (creditsToTransfer !== 0) {
            const adminIdToUpdate = adminUser._id;
            const adminNewBalance = (adminUser.credits || 0) - creditsToTransfer;
            const targetUserNewBalance = newTargetCredits;

            // Deduct/Add from admin pool
            await User.findByIdAndUpdate(adminIdToUpdate, { $set: { credits: adminNewBalance } });
            await Subscription.findOneAndUpdate(
                { userId: adminIdToUpdate },
                { $set: { creditsRemaining: adminNewBalance } }
            );
            
            // Create CreditLog for admin
            await CreditLog.create({
                userId: adminIdToUpdate,
                action: creditsToTransfer > 0 ? 'Admin Credit Transfer to User' : 'Admin Credit Recovery from User',
                credits: -creditsToTransfer,
                balanceAfter: adminNewBalance,
                description: `Transferred to/from user ${targetUser.email}`
            });
            
            // Create CreditLog for target user
            await CreditLog.create({
                userId: targetUser._id,
                action: creditsToTransfer > 0 ? 'Credit Received from Admin' : 'Credit Deducted by Admin',
                credits: creditsToTransfer,
                balanceAfter: targetUserNewBalance,
                description: `Processed by admin ${adminUser.email}`
            });
        }

        // Update both the user model and the subscription model for consistency
        await User.findByIdAndUpdate(userId, { $set: { credits: newTargetCredits } });
        
        const subscription = await Subscription.findOneAndUpdate(
            { userId: userId },
            { $set: { creditsRemaining: newTargetCredits } },
            { new: true }
        );

        res.status(200).json({
            success: true,
            message: `Transferred ${creditsToTransfer} credits successfully.`,
            subscription
        });
    } catch (error) {
        console.error("[adjustCredits Error]", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const manualPlanUpgrade = async (req, res) => {
    try {
        const { userId, planName, expiryDate } = req.body;
        
        // Find the actual plan ID first
        const plan = await Plan.findOne({ planName: new RegExp(`^${planName}$`, 'i') });
        if (!plan) return res.status(404).json({ success: false, message: `Plan '${planName}' not found.` });

        const subscription = await Subscription.findOneAndUpdate(
            { userId: userId },
            { 
                planId: plan._id, 
                renewalDate: expiryDate ? new Date(expiryDate) : undefined,
                subscriptionStatus: 'active',
                creditsRemaining: plan.credits
            },
            { new: true, upsert: true }
        );

        // Also update User record for consistency with credit system
        await User.findByIdAndUpdate(userId, { 
            $set: { 
                credits: plan.credits,
                founderStatus: plan.planName.toLowerCase().includes('founder')
            } 
        });

        res.status(200).json({
            success: true,
            message: `Plan upgraded to ${plan.planName} successfully.`,
            subscription
        });
    } catch (error) {
        console.error("[manualPlanUpgrade Error]", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const createPlan = async (req, res) => {
    try {
        const plan = await Plan.create(req.body);
        res.status(201).json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updatePlan = async (req, res) => {
    try {
        const { planId } = req.params;
        const plan = await Plan.findByIdAndUpdate(planId, req.body, { new: true });
        if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });
        res.status(200).json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deletePlan = async (req, res) => {
    try {
        const { planId } = req.params;
        await Plan.findByIdAndDelete(planId);
        res.status(200).json({ success: true, message: "Plan deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const createCreditPackage = async (req, res) => {
    try {
        const packageData = await CreditPackage.create(req.body);
        res.status(201).json({ success: true, packageData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateCreditPackage = async (req, res) => {
    try {
        const { packageId } = req.params;
        const packageData = await CreditPackage.findByIdAndUpdate(packageId, req.body, { new: true });
        if (!packageData) return res.status(404).json({ success: false, message: "Package not found" });
        res.status(200).json({ success: true, packageData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deleteCreditPackage = async (req, res) => {
    try {
        const { packageId } = req.params;
        await CreditPackage.findByIdAndDelete(packageId);
        res.status(200).json({ success: true, message: "Package deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Returns ALL plans (regardless of isActive) for admin use
export const getAllPlansAdmin = async (req, res) => {
    try {
        const plans = await Plan.find({}).sort({ priceMonthly: 1 });
        res.status(200).json({ success: true, plans });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
