import express from 'express';
import { getSubscriptionDetails, purchasePlan, purchaseCredits, createOrder, getCreditLogs, deductCredits } from '../controllers/subscriptionController.js';
import { verifyToken } from '../middleware/authorization.js'; 

const router = express.Router();

router.get('/', verifyToken, getSubscriptionDetails);
router.get('/credit-history', verifyToken, getCreditLogs);
router.get('/user-credits', verifyToken, getSubscriptionDetails);
router.post('/create-order', verifyToken, createOrder);
router.post('/purchase', verifyToken, purchasePlan);
router.post('/buy-credits', verifyToken, purchaseCredits);
router.post('/deduct-credits', verifyToken, deductCredits);

export default router;
