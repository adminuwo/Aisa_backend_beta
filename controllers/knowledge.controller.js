import logger from '../utils/logger.js';
import { subscriptionService } from '../services/subscriptionService.js';
import path from 'path';
import stream from 'stream';
import util from 'util';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import Knowledge from '../models/Knowledge.model.js';
import * as aiService from '../services/ai.service.js';

import mammoth from 'mammoth';
import xlsx from 'xlsx';
import officeParser from 'officeparser';
import Tesseract from 'tesseract.js';
import { GoogleAuth } from 'google-auth-library';
import * as vertexService from '../services/vertex.service.js';
import * as ingestionService from '../services/knowledgeIngestion.service.js';
import { Storage } from '@google-cloud/storage';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const pipeline = util.promisify(stream.pipeline);

const estimateChunks = async (fileBuffer, mimeType) => {
    try {
        let text = '';
        if (mimeType === 'application/pdf') {
            const data = await pdf(fileBuffer);
            text = data.text;
        } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
           const result = await mammoth.extractRawText({ buffer: fileBuffer });
           text = result.value;
        } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
            text = fileBuffer.toString();
        } else {
            return Math.max(1, Math.ceil(fileBuffer.length / 800));
        }

        const chunks = await ingestionService.chunkText(text);
        return chunks.length;
    } catch (error) {
        logger.warn(`Chunk estimation failed: ${error.message}`);
        return 0;
    }
}

// @desc    Upload a document
// @route   POST /api/knowledge/upload
// @access  Public
export const uploadDocument = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const fileBuffer = req.file.buffer;
        const originalName = req.file.originalname;
        const mimeType = req.file.mimetype;
        const fileSize = req.file.size;

        logger.info(`Received file for GCS upload: ${originalName} (${fileSize} bytes)`);

        // 1. Upload to Google Cloud Storage (Vertex AI RAG bucket)
        let gcsUri = null;
        try {
            logger.info("Uploading to Google Cloud Storage (aisa_knowledge_base)...");
            const storageOptions = process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : {};
            const storageClient = new Storage(storageOptions);
            const bucketName = 'aisa_knowledge_base';
            const bucket = storageClient.bucket(bucketName);
            const gcsFileName = `${Date.now()}-${originalName.replace(/\s+/g, '_')}`;
            const fileRef = bucket.file(gcsFileName);

            await fileRef.save(fileBuffer, {
                contentType: mimeType,
                resumable: false
            });
            gcsUri = `gs://${bucketName}/${gcsFileName}`;
            logger.info(`GCS Upload Success: ${gcsUri}`);
        } catch (gcsError) {
            logger.error(`GCS Upload Failed: ${gcsError.message}`);
            // Throw the actual error so the frontend stops and reports it
            throw new Error(`Google Cloud Storage Error: ${gcsError.message}`);
        }

        // 2. Dispatch Vertex AI RAG Engine Import (Run asynchronously)
        if (gcsUri) {
            vertexService.importToVertexRag(gcsUri, originalName).catch(err => {
                logger.error(`Background Vertex RAG error for ${originalName}: ${err.message}`);
            });
        }

        let category = req.body.category || 'GENERAL';
        category = category.toUpperCase();
        if (!['LEGAL', 'GENERAL', 'FINANCE'].includes(category)) category = 'GENERAL';

        // 3. Always Store Metadata (for listing)
        try {
            const chunks = await estimateChunks(fileBuffer, mimeType);
            await Knowledge.create({
                filename: originalName,
                gcsUri: gcsUri,
                mimetype: mimeType,
                size: fileSize,
                category: category,
                status: 'Active',
                totalChunks: chunks
            });
            logger.info(`Document metadata saved to MongoDB for track. GCS URI: ${gcsUri}, Chunks: ${chunks}`);
        } catch (dbError) {
            logger.error(`MongoDB Save Error: ${dbError.message}`);
        }

        // 💰 Deduct credits on successful upload
        if (req.creditMeta && req.creditMeta.cost > 0) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.status(200).json({
            success: true,
            message: 'File uploaded and sent to Vertex RAG Engine',
            data: {
                filename: originalName,
                gcsUri: gcsUri,
                mimetype: mimeType,
                size: fileSize,
                category: category,
                gcsSuccess: !!gcsUri
            }
        });

    } catch (error) {
        logger.error(`Upload Error: ${error.message}`);
        res.status(500).json({ success: false, message: error.message || 'Server error during upload' });
    }
};

// @desc    Get all uploaded documents
// @route   GET /api/knowledge/documents
// @access  Public
export const getDocuments = async (req, res) => {
    try {
        const documents = await Knowledge.find({}).sort({ uploadDate: -1 });
        res.status(200).json({
            success: true,
            data: documents
        });
    } catch (error) {
        logger.error(`Get Documents Error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error fetching documents' });
    }
};

// @desc    Get all knowledge (Documents + Web Sources)
// @route   GET /api/knowledge/list
// @access  Public
export const getKnowledgeList = async (req, res) => {
    try {
        const documents = await Knowledge.find({}).sort({ uploadDate: -1 });
        const KnowledgeSource = (await import('../models/KnowledgeSource.model.js')).default;
        const sources = await KnowledgeSource.find({}).sort({ updatedAt: -1 });

        // Map sources to a similar structure if needed, or just return both
        res.status(200).json({
            success: true,
            data: {
                documents,
                sources
            }
        });
    } catch (error) {
        logger.error(`List Knowledge Error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error fetching knowledge list' });
    }
};

// @desc    Re-index a document (Trigger Vertex Import again)
// @route   POST /api/knowledge/reindex/:id
// @access  Public
export const reindexDocument = async (req, res) => {
    try {
        const document = await Knowledge.findById(req.params.id);
        if (!document) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }

        if (!document.gcsUri) {
            return res.status(400).json({ success: false, message: 'Document has no GCS URI for indexing' });
        }

        document.status = 'Indexing';
        await document.save();

        // Trigger Vertex Import
        vertexService.importToVertexRag(document.gcsUri, document.filename)
            .then(async () => {
                document.status = 'Active';
                await document.save();
                logger.info(`Re-indexed ${document.filename} successfully.`);
            })
            .catch(async (err) => {
                document.status = 'Error';
                await document.save();
                logger.error(`Re-indexing failed for ${document.filename}: ${err.message}`);
            });

        res.status(200).json({
            success: true,
            message: 'Re-indexing process started'
        });
    } catch (error) {
        logger.error(`Re-index error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Failed to trigger re-indexing' });
    }
};

// @desc    Delete a document
// @route   DELETE /api/knowledge/:id
// @access  Public
export const deleteDocument = async (req, res) => {
    try {
        const document = await Knowledge.findById(req.params.id);
        if (!document) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }

        const gcsUri = document.gcsUri;
        const originalName = document.filename;

        // 1. Delete from GCS
        if (gcsUri) {
            try {
                const { Storage } = await import('@google-cloud/storage');
                const storageOptions = process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : {};
                const storageClient = new Storage(storageOptions);
                const urlParts = gcsUri.replace('gs://', '').split('/');
                const bucketName = urlParts[0];
                const gcsFileName = urlParts.slice(1).join('/');

                await storageClient.bucket(bucketName).file(gcsFileName).delete();
                logger.info(`Deleted file from GCS: ${gcsUri}`);
            } catch (err) {
                logger.error(`Failed to delete from GCS: ${err.message}`);
            }

            // 2. Delete from Vertex RAG
            vertexService.deleteFromVertexRag(gcsUri, originalName).catch(err => {
                logger.error(`Background Vertex RAG delete error: ${err.message}`);
            });
        }

        await Knowledge.findByIdAndDelete(req.params.id);

        // Reload Vector Store to remove the document context
        await aiService.reloadVectorStore();

        res.status(200).json({
            success: true,
            message: 'Document deleted and knowledge base updated'
        });
    } catch (error) {
        logger.error(`Delete Document Error: ${error.message}`);
        res.status(500).json({ success: false, message: 'Server error deleting document' });
    }
};

// @desc    Download/view a document by streaming it from GCS
// @route   GET /api/knowledge/download/:id
// @access  Public
export const downloadDocument = async (req, res) => {
    try {
        const document = await Knowledge.findById(req.params.id);
        if (!document) {
            logger.warn(`Download failed: Document ${req.params.id} not found`);
            return res.status(404).send('Document record not found in database');
        }

        if (!document.gcsUri) {
            logger.warn(`Download failed: Document ${document.filename} has no GCS URI`);
            return res.status(404).send('Document has no associated storage location');
        }

        logger.info(`Attempting to stream document: ${document.filename} from ${document.gcsUri}`);

        // Initialization using existing Storage import at top-level
        const storageOptions = process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : {};
        const storageClient = new Storage(storageOptions);

        const urlParts = document.gcsUri.replace('gs://', '').split('/');
        const bucketName = urlParts[0];
        const gcsFileName = urlParts.slice(1).join('/');

        const file = storageClient.bucket(bucketName).file(gcsFileName);

        // Check if file exists in GCS first
        const [exists] = await file.exists();
        if (!exists) {
            logger.error(`File not found in GCS bucket: ${document.gcsUri}`);
            return res.status(404).send('Physical file not found in storage bucket');
        }

        res.setHeader('Content-Type', document.mimetype || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.filename)}"`);

        const readStream = file.createReadStream();
        
        readStream.on('error', (err) => {
            logger.error(`ReadStream Error for ${document.filename}: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).send('Error reading file from storage');
            }
        });

        readStream.pipe(res);
    } catch (error) {
        logger.error(`Download Controller Error: ${error.message}`);
        res.status(500).send(`Server error: ${error.message}`);
    }
};

// @desc    Upload a URL
// @route   POST /api/knowledge/upload-url
// @access  Public
// @desc    Upload a URL
// @route   POST /api/knowledge/upload-url
// @access  Public
export const uploadUrl = async (req, res) => {
    try {
        let { url, category = 'LEGAL', depth = 2, maxPages = 20, frequency = 'daily' } = req.body;
        
        category = category.toUpperCase();
        if (!['LEGAL', 'GENERAL', 'FINANCE'].includes(category)) category = 'GENERAL';

        if (!url) {
            return res.status(400).json({ success: false, message: 'URL is required' });
        }

        logger.info(`Processing URL ingestion request: ${url}`);

        // Validate URL
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            return res.status(400).json({ success: false, message: 'Invalid URL format' });
        }

        // 1. Check if source already exists, if not create it
        const KnowledgeSource = (await import('../models/KnowledgeSource.model.js')).default;
        let source = await KnowledgeSource.findOne({ url });

        if (!source) {
            source = await KnowledgeSource.create({
                url: url,
                domain: parsedUrl.hostname,
                category: category,
                crawl_depth: depth,
                max_pages: maxPages,
                update_frequency: frequency,
                status: 'active',
                next_crawl_at: new Date()
            });
        }

        // 2. Trigger Ingestion via Service
        const result = await ingestionService.processUrlIngestion(url, source._id, {
            category,
            maxDepth: depth,
            maxPages: maxPages
        });

        // 3. Update Source Metadata
        const nextCrawl = new Date();
        if (frequency === 'daily') nextCrawl.setDate(nextCrawl.getDate() + 1);
        else if (frequency === 'weekly') nextCrawl.setDate(nextCrawl.getDate() + 7);
        else if (frequency === 'monthly') nextCrawl.setMonth(nextCrawl.getMonth() + 1);
        else nextCrawl.setDate(nextCrawl.getDate() + 1);

        source.last_crawled_at = new Date();
        source.next_crawl_at = nextCrawl;
        source.pages_indexed = result.total_pages;
        await source.save();

        // 💰 Deduct credits on successful ingestion
        if (req.creditMeta && req.creditMeta.cost > 0) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.status(200).json({
            success: true,
            message: `Processed ${result.updated_pages} new/updated pages from ${url}`,
            data: {
                source_id: source._id,
                total_pages: result.total_pages,
                updated_pages: result.updated_pages,
                results: result.results
            }
        });

    } catch (error) {
        logger.error(`URL Upload Error: ${error.message}`);
        res.status(500).json({ success: false, message: error.message || 'Server error during URL ingestion' });
    }
};

/**
 * @desc    Get all active knowledge sources (websites)
 * @route   GET /api/knowledge/sources
 */
export const getKnowledgeSources = async (req, res) => {
    try {
        const KnowledgeSource = (await import('../models/KnowledgeSource.model.js')).default;
        const sources = await KnowledgeSource.find({}).sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: sources });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Manually trigger a re-crawl
 * @route   POST /api/knowledge/recrawl
 */
export const recrawlSource = async (req, res) => {
    try {
        const { id, url } = req.body;
        const KnowledgeSource = (await import('../models/KnowledgeSource.model.js')).default;
        const { triggerManualUpdate } = await import('../services/scheduler.service.js');

        let sourceId = id;
        if (!sourceId && url) {
            const source = await KnowledgeSource.findOne({ url });
            if (source) sourceId = source._id;
        }

        if (!sourceId) {
            return res.status(404).json({ success: false, message: 'Source not found' });
        }

        // Trigger in background
        triggerManualUpdate(sourceId).catch(err => logger.error(`Manual recrawl failed: ${err.message}`));

        res.status(200).json({ success: true, message: 'Recrawl triggered successfully in background' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Update source settings (status, frequency, etc.)
 * @route   PATCH /api/knowledge/sources/:id
 */
export const updateSourceStatus = async (req, res) => {
    try {
        const { status, update_frequency, crawl_depth, max_pages } = req.body;
        const KnowledgeSource = (await import('../models/KnowledgeSource.model.js')).default;
        
        const updateData = {};
        if (status) updateData.status = status;
        if (update_frequency) updateData.update_frequency = update_frequency;
        if (crawl_depth) updateData.crawl_depth = crawl_depth;
        if (max_pages) updateData.max_pages = max_pages;

        const source = await KnowledgeSource.findByIdAndUpdate(req.params.id, updateData, { new: true });
        
        if (!source) return res.status(404).json({ success: false, message: 'Source not found' });
        
        res.status(200).json({ success: true, data: source });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Delete a knowledge source and its associated pages
 * @route   DELETE /api/knowledge/sources/:id
 */
export const deleteKnowledgeSource = async (req, res) => {
    try {
        const KnowledgeSource = (await import('../models/KnowledgeSource.model.js')).default;
        const source = await KnowledgeSource.findById(req.params.id);
        
        if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

        // Find all pages from this source
        const Knowledge = (await import('../models/Knowledge.model.js')).default;
        // 2. Find all associated crawled pages
        const pages = await Knowledge.find({ knowledgeSourceId: source._id });

        logger.info(`Deleting knowledge source ${source.url} and its ${pages.length} pages.`);

        // Delete from GCS and Vertex for each page
        const { Storage } = await import('@google-cloud/storage');
        const storageOptions = process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : {};
        const storageClient = new Storage(storageOptions);
        const vertexService = await import('../services/vertex.service.js');

        for (const page of pages) {
            if (page.gcsUri) {
                try {
                    const urlParts = page.gcsUri.replace('gs://', '').split('/');
                    const bName = urlParts[0];
                    const fName = urlParts.slice(1).join('/');
                    await storageClient.bucket(bName).file(fName).delete();
                } catch (e) { logger.warn(`Delete GCS failed for ${page.sourceUrl}: ${e.message}`); }

                vertexService.deleteFromVertexRag(page.gcsUri, page.filename).catch(e => {
                    logger.warn(`Delete Vertex failed for ${page.sourceUrl}: ${e.message}`);
                });
            }
            await Knowledge.findByIdAndDelete(page._id);
        }

        await KnowledgeSource.findByIdAndDelete(req.params.id);

        res.status(200).json({ success: true, message: 'Source and its knowledge completely removed' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Vertex RAG operations are handled by vertex.service.js
