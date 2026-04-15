import express from 'express';
import multer from 'multer';
import { fetchBrandAssets, quickAnalysis } from '../controllers/brandFetch.controller.js';
import { verifyToken } from '../middleware/authorization.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Fetch brand identity from a URL (auth required)
router.post('/fetch', verifyToken, fetchBrandAssets);

// NEW Stage 4: THE REAL MAGIC — Instant asset-to-DNA synthesis for auto-fill
router.post('/quick-analysis', verifyToken, upload.array('files', 5), quickAnalysis);

export default router;
