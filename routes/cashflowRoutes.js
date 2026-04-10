import express from 'express';
import * as cashflowController from '../controllers/cashflowController.js';
import { verifyToken } from '../middleware/authorization.js';

const router = express.Router();

/**
 * @route GET /api/cashflow/search
 * @desc Search for stocks
 * @access Private
 */
router.get('/search', verifyToken, cashflowController.searchStocks);

/**
 * @route GET /api/cashflow/quote
 * @desc Get real-time quote for the modal detail view
 * @access Private
 */
router.get('/quote', verifyToken, cashflowController.getStockQuote);

/**
 * @route POST /api/cashflow/analyze
 * @desc Analyze stock and send email report
 * @access Private
 */
router.post('/analyze', verifyToken, cashflowController.analyzeStock);

export default router;
