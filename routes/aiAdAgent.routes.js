import express from 'express';
import { verifyToken } from '../middleware/authorization.js';
import { configureAiAdAgent, getAiAdPosts, getAiAdStatus } from '../controllers/aiAdAgent.controller.js';

const router = express.Router();

router.post('/configure', verifyToken, configureAiAdAgent);
router.get('/posts', verifyToken, getAiAdPosts);
router.get('/status', verifyToken, getAiAdStatus);

export default router;
