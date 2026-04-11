import express from 'express';
import { verifyToken } from '../middleware/authorization.js';
import { creditMiddleware } from '../middleware/creditSystem.js';
import { generateImage, editImage, proxyImage } from '../controllers/image.controller.js';

const router = express.Router();

router.post('/generate', verifyToken, creditMiddleware, generateImage);
router.post('/edit', verifyToken, creditMiddleware, editImage);
router.get('/proxy', proxyImage); // No token required for public proxy, or add verifyToken if needed

export default router;
