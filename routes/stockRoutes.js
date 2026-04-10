import express from 'express';
import * as stockController from '../controllers/stockController.js';
import { verifyToken } from '../middleware/authorization.js';

const router = express.Router();

// Dynamic Stock Search
router.get('/search', verifyToken, stockController.searchStocks);

router.get('/quote', verifyToken, stockController.getQuote);
router.get('/intraday', verifyToken, stockController.getIntraday);
router.get('/news', verifyToken, stockController.getNews);
router.get('/historical', verifyToken, stockController.getHistorical);
router.get('/advisory', verifyToken, stockController.getAdvisory);
router.get('/research', verifyToken, stockController.getResearch);
router.get('/graham-analysis', verifyToken, stockController.getGrahamAnalysis);

export default router;
