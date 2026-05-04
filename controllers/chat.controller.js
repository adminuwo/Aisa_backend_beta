import * as aiService from '../services/ai.service.js';
import { subscriptionService } from '../services/subscriptionService.js';
import logger from '../utils/logger.js';
import Conversation from '../models/Conversation.model.js';
import User from '../models/User.js';
import { uploadToGCS, gcsFilename } from '../services/gcs.service.js';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import xlsx from 'xlsx';
import officeParser from 'officeparser';
import Tesseract from 'tesseract.js';


// @desc    Chat with AI
// @route   POST /api/chat
// @access  Public (for now)
export const chat = async (req, res, next) => {
    try {
        const { message, conversationId, activeDocContent, systemInstruction, mode, image, document } = req.body;

        if (!message && (!image || image.length === 0) && (!document || document.length === 0)) {
            return res.status(400).json({ success: false, message: 'Message or attachment is required' });
        }

        // Try to get user name if authenticated
        let userName = null;
        if (req.user && req.user.id) {
            const user = await User.findById(req.user.id).select('name');
            if (user && user.name) userName = user.name.split(' ')[0];
        }

        // 1. Get AI Response (Pass detailed context)
        const chatResponse = await aiService.chat(message, activeDocContent, {
            systemInstruction,
            mode,
            images: image,
            documents: document,
            userName,
            conversationId,
            userId: req.user?.id || req.user?._id
        });

        const { text: responseText, isRealTime, sources, suggestions } = chatResponse;


        // 2. Persist to DB
        let conversation;
        if (conversationId) {
            conversation = await Conversation.findById(conversationId);
        }

        if (!conversation) {
            let titleSourceText = message;
            if (!titleSourceText) {
                if (image && image.length > 0) titleSourceText = "Image Analysis Session";
                else if (document && document.length > 0) titleSourceText = "Document Analysis Session";
                else titleSourceText = "New Conversation";
            }
            
            const generatedTitle = await aiService.generateConversationTitle(titleSourceText);

            conversation = new Conversation({
                userId: req.user?.id || req.user?._id || 'admin', // Support dynamic user
                title: generatedTitle,
                messages: []
            });
        }

        conversation.messages.push({ role: 'user', text: message || "[Attachment Uploaded]" });
        conversation.messages.push({
            role: 'assistant',
            text: responseText,
            isRealTime: isRealTime || false,
            sources: sources || [],
            suggestions: suggestions || []
        });
        conversation.lastMessageAt = Date.now();
        await conversation.save();

        // 💰 Deduct credits on successful output
        if (req.creditMeta && req.creditMeta.cost > 0) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.status(200).json({
            success: true,
            data: responseText,
            isRealTime: isRealTime || false,
            sources: sources || [],
            suggestions: suggestions || [],
            conversationId: conversation._id,
            title: conversation.title
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Upload attachment for Chat (Temporary Context)
// @route   POST /api/chat/upload
// @access  Public
export const uploadAttachment = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const fileBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;
        let parsedText = null;

        // Extract Text for Immediate Context
        if (mimeType === 'application/pdf') {
            try {
                const data = await pdf(fileBuffer);
                parsedText = data.text;
                logger.info(`[Chat Upload] Parsed PDF: ${data.numpages} pages.`);
            } catch (e) {
                logger.error(`[Chat Upload] PDF parse error: ${e.message}`);
            }
        } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            try {
                const result = await mammoth.extractRawText({ buffer: fileBuffer });
                parsedText = result.value;
                logger.info(`[Chat Upload] Parsed DOCX: ${parsedText.length} chars.`);
            } catch (e) {
                logger.error(`[Chat Upload] DOCX parse error: ${e.message}`);
            }
        } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
            try {
                const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
                parsedText = workbook.SheetNames.map(name => {
                    return xlsx.utils.sheet_to_text(workbook.Sheets[name]);
                }).join('\n\n');
                logger.info(`[Chat Upload] Parsed Excel.`);
            } catch (e) {
                logger.error(`[Chat Upload] Excel parse error: ${e.message}`);
            }
        } else if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
            try {
                parsedText = await officeParser.parse(fileBuffer);
                logger.info(`[Chat Upload] Parsed PPTX.`);
            } catch (e) {
                logger.error(`[Chat Upload] PPTX parse error: ${e.message}`);
            }
        } else if (mimeType.startsWith('image/')) {
            try {
                logger.info(`[Chat Upload] Starting OCR...`);
                const { data: { text } } = await Tesseract.recognize(fileBuffer, 'eng');
                parsedText = text;
                logger.info(`[Chat Upload] OCR Complete: ${parsedText.length} chars.`);
            } catch (e) {
                logger.error(`[Chat Upload] OCR error: ${e.message}`);
            }
        } else if (mimeType === 'text/plain') {
            parsedText = fileBuffer.toString('utf8');
        }

        // Upload to GCS aisa_objects bucket for visual reference (image/pdf link)
        const ext = req.file.originalname.split('.').pop() || 'bin';
        const gcsResult = await uploadToGCS(fileBuffer, {
            folder: 'chat_uploads',
            filename: gcsFilename(`chat_${Date.now()}`, ext),
            mimeType: mimeType,
            isPublic: false,
            useSignedUrl: true,
        });

        // Return text so frontend can send it back as context
        res.status(200).json({
            success: true,
            data: {
                url: gcsResult.publicUrl,
                mimetype: mimeType,
                filename: req.file.originalname,
                size: req.file.size,
                parsedText: parsedText // Frontend stores this in state
            }
        });
    } catch (error) {
        next(error);
    }
};


// @desc    Get all conversations
// @route   GET /api/chat/history
// @access  Public
export const getHistory = async (req, res, next) => {
    try {
        const query = { userId: 'admin' };

        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search, 'i');
            query.$or = [
                { title: searchRegex },
                { 'messages.text': searchRegex }
            ];
        }

        const conversations = await Conversation.find(query)
            .sort({ lastMessageAt: -1 })
            .select('title lastMessageAt createdAt');

        res.status(200).json({
            success: true,
            data: conversations
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Get specific conversation
// @route   GET /api/chat/:id
// @access  Public
export const getConversation = async (req, res, next) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        if (!conversation) {
            return res.status(404).json({ success: false, message: 'Conversation not found' });
        }
        res.status(200).json({
            success: true,
            data: conversation
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Delete a conversation
// @route   DELETE /api/chat/:id
// @access  Public
export const deleteConversation = async (req, res, next) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        if (!conversation) {
            return res.status(404).json({ success: false, message: 'Conversation not found' });
        }

        await Conversation.findByIdAndDelete(req.params.id);

        res.status(200).json({
            success: true,
            message: 'Conversation deleted'
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Clear all history
// @route   DELETE /api/chat/history
// @access  Public
export const clearHistory = async (req, res, next) => {
    try {
        await Conversation.deleteMany({ userId: 'admin' }); // Clear for current user

        res.status(200).json({
            success: true,
            message: 'History cleared'
        });
    } catch (error) {
        next(error);
    }
};
