import Plan from '../models/Plan.js';
import CreditPackage from '../models/CreditPackage.js';
import User from '../models/User.js';
import FeatureCredit from '../models/FeatureCredit.js';

export const getPlans = async (req, res) => {
    try {
        const plans = await Plan.find({ isActive: true }).sort({ priceMonthly: 1 });
        res.status(200).json({ success: true, plans });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getCreditPackages = async (req, res) => {
    try {
        const packages = await CreditPackage.find({ isActive: true }).sort({ price: 1 });
        res.status(200).json({ success: true, packages });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getFounderCount = async (req, res) => {
    try {
        const count = await User.countDocuments({ founderStatus: true });
        res.status(200).json({ success: true, count });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getPublicFeatureCosts = async (req, res) => {
    try {
        const features = await FeatureCredit.find({});
        res.status(200).json({ success: true, features });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
