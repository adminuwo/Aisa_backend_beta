import express from 'express';
import * as stockController from '../controllers/stockController.js';
import { creditMiddleware } from '../middleware/creditSystem.js';
import { verifyToken } from '../middleware/authorization.js';

const router = express.Router();

// Dynamic Stock Search
router.get('/search', verifyToken, stockController.searchStocks);

router.get('/quote', verifyToken, stockController.getQuote);
router.get('/intraday', verifyToken, creditMiddleware, stockController.getIntraday);
router.get('/news', verifyToken, creditMiddleware, stockController.getNews);
router.get('/historical', verifyToken, creditMiddleware, stockController.getHistorical);
router.get('/advisory', verifyToken, creditMiddleware, stockController.getAdvisory);
router.get('/research', verifyToken, creditMiddleware, stockController.getResearch);
router.get('/graham-analysis', verifyToken, creditMiddleware, stockController.getGrahamAnalysis);
router.get('/kiyosaki-analysis', verifyToken, creditMiddleware, stockController.getKiyosakiAnalysis);

export default router;
