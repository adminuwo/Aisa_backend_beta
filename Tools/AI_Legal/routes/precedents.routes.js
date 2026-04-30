import express from 'express';
import { findPrecedents } from '../services/precedents.service.js';
import Project from '../../../models/Project.js';
import logger from '../../../utils/logger.js';
import { generatePrecedentPDF } from '../services/pdf.service.js';

const router = express.Router();

/**
 * @route POST /api/precedents/search
 * @desc Find legal precedents based on query or case context
 */
router.post('/search', async (req, res) => {
    try {
        const { query, projectId, language } = req.body;
        
        let caseContext = null;
        if (projectId) {
            caseContext = await Project.findById(projectId);
        }

        const results = await findPrecedents(query, caseContext, language);
        res.json(results);
    } catch (error) {
        logger.error(`[PrecedentsRoute] Search failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to retrieve precedents.', details: error.message });
    }
});

/**
 * @route POST /api/precedents/analyze
 * @desc Perform AI analysis on a specific precedent
 */
router.post('/analyze', async (req, res) => {
    try {
        const { actionType, precedentData, projectId, language } = req.body;
        
        let activeCaseData = null;
        if (projectId) {
            activeCaseData = await Project.findById(projectId);
        }

        const { analyzePrecedent } = await import('../services/precedents.service.js');
        const analysis = await analyzePrecedent(actionType, precedentData, activeCaseData, language);
        
        res.json({ analysis });
    } catch (error) {
        logger.error(`[PrecedentsRoute] Analysis failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to generate AI analysis.', details: error.message });
    }
});

/**
 * @route POST /api/precedents/reanalyze
 * @desc Re-analyze a specific precedent against a new case context
 */
router.post('/reanalyze', async (req, res) => {
    try {
        const { precedentData, projectId, language } = req.body;
        
        let activeCaseData = null;
        if (projectId) {
            activeCaseData = await Project.findById(projectId);
        }

        const { processPrecedentWithAI } = await import('../services/precedents.service.js');
        const reanalyzedData = await processPrecedentWithAI(precedentData, activeCaseData, language);
        
        res.json(reanalyzedData);
    } catch (error) {
        logger.error(`[PrecedentsRoute] Re-analysis failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to re-analyze precedent.', details: error.message });
    }
});

/**
 * @route POST /api/precedents/generate-pdf
 * @desc Generate a professional PDF for a precedent
 */
router.post('/generate-pdf', async (req, res) => {
    try {
        const { precedentData } = req.body;
        
        if (!precedentData) {
            return res.status(400).json({ error: 'Precedent data is required' });
        }

        const pdfBuffer = await generatePrecedentPDF(precedentData);
        
        const caseName = (precedentData.case_identity?.case_name || precedentData.case_name || "Precedent").replace(/[^a-z0-9]/gi, '_');
        const court = (precedentData.case_identity?.court || precedentData.court || "Court").replace(/[^a-z0-9]/gi, '_');
        const year = precedentData.case_identity?.year || precedentData.year || "2025";
        
        const fileName = `${caseName}_${court}_${year}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.send(pdfBuffer);
    } catch (error) {
        logger.error(`[PrecedentsRoute] PDF generation failed: ${error.message}`);
        console.error("[PDF_ERROR_TRACE]", error);
        res.status(500).json({ 
            error: 'Failed to generate PDF.', 
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
        });
    }
});

export default router;
