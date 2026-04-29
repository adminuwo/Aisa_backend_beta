import express from 'express';
import { getPlans, getCreditPackages, getFounderCount, getPublicFeatureCosts } from '../controllers/pricingController.js';

const router = express.Router();

router.get('/plans', getPlans);
router.get('/packages', getCreditPackages);
router.get('/founder-count', getFounderCount);
router.get('/feature-costs', getPublicFeatureCosts);

export default router;
