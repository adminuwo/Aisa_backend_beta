import express from 'express';
import { verifyToken } from '../middleware/authorization.js';
import User from '../models/User.js';
// Assuming there is an isAdmin middleware or we check role
import {
    getAdminStats,
    searchUserByEmail,
    adjustCredits,
    manualPlanUpgrade,
    createPlan,
    updatePlan,
    deletePlan,
    createCreditPackage,
    updateCreditPackage,
    deleteCreditPackage,
    getFeatureCredits,
    updateFeatureCredit,
    getAllPlansAdmin
} from '../controllers/adminController.js';


const router = express.Router();

// Middleware to check if user is admin (authoritative check against DB)
const isAdmin = async (req, res, next) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const PRIMARY_ADMIN_EMAIL = 'admin@uwo24.com';

        // Fast path: if email is already in the JWT payload, check it immediately
        if (req.user.email === PRIMARY_ADMIN_EMAIL || req.user.role === 'admin') {
            return next();
        }

        // DB lookup for role/email verification
        const user = await User.findById(req.user.id);

        if (user && (user.role === 'admin' || user.email === PRIMARY_ADMIN_EMAIL)) {
            next();
        } else {
            const identEmail = req.user.email || (user && user.email) || req.user.id;
            console.warn(`[Blocked Access] User ${identEmail} attempted admin access without proper role.`);
            res.status(403).json({ success: false, message: 'Access denied. Admins only.' });
        }
    } catch (error) {
        console.error('[Admin Auth Error]', error.message);
        res.status(500).json({ success: false, message: 'Error verifying admin status' });
    }
};

router.get('/stats', verifyToken, isAdmin, getAdminStats);
router.get('/search-user', verifyToken, isAdmin, searchUserByEmail);
router.post('/adjust-credits', verifyToken, isAdmin, adjustCredits);
router.post('/manual-upgrade', verifyToken, isAdmin, manualPlanUpgrade);

// Plan routes
router.get('/plans', verifyToken, isAdmin, getAllPlansAdmin);
router.post('/plans', verifyToken, isAdmin, createPlan);
router.put('/plans/:planId', verifyToken, isAdmin, updatePlan);
router.delete('/plans/:planId', verifyToken, isAdmin, deletePlan);


// Credit package routes
router.post('/packages', verifyToken, isAdmin, createCreditPackage);
router.put('/packages/:packageId', verifyToken, isAdmin, updateCreditPackage);
router.delete('/packages/:packageId', verifyToken, isAdmin, deleteCreditPackage);

// Feature Credit metrics and adjustments
router.get('/feature-credits', verifyToken, isAdmin, getFeatureCredits);
router.put('/feature-credits/:id', verifyToken, isAdmin, updateFeatureCredit);

export default router;
