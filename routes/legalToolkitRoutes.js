import express from 'express';
import { verifyToken } from '../middleware/authorization.js';
import { creditMiddleware } from '../middleware/creditSystem.js';
import { generateChatResponse } from '../services/geminiService.js';
import { getToolByName } from '../services/intent/toolRegistry.js';
import { getLegalPrompt, LEGAL_DISCLAIMER } from '../services/legal/legalPrompts.js';
import { subscriptionService } from '../services/subscriptionService.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Note: getStrictToolPrompt was removed in favor of centralized services/legal/legalPrompts.js
 */

/**
 * POST /api/legal-toolkit/execute
 */
router.post('/execute', verifyToken, creditMiddleware, async (req, res) => {
    try {
        const {
            message,
            toolName,
            sessionId,
            attachments = [],
            conversationHistory = []
        } = req.body;

        if (!toolName) {
            return res.status(400).json({
                success: false,
                error: 'toolName is required'
            });
        }

        const tool = getToolByName(toolName);
        if (!tool) {
            return res.status(404).json({
                success: false,
                error: `Tool ${toolName} not found`
            });
        }

        // 🔥 STEP 1: Get STRICT TOOL PROMPT from Centralized Service
        const systemPrompt = getLegalPrompt(toolName);

        // 🔥 STEP 2: FORCE TOOL MODE (ALIGNED WITH DRAFT-FIRST WORKFLOW)
        const isDraftMaker = toolName === 'legal_draft_maker';
        const isFollowUp = conversationHistory && conversationHistory.length > 0;
        
        const enforcedMessage = isDraftMaker 
            ? `${isFollowUp ? '📝 FOLLOW-UP DATA AND UPDATES FOR DRAFT:' : '⚖️ DRAFTING REQUEST:'}\n${message}` 
            : `🚨 TOOL MODE: ${toolName}

### 🎯 TASK:
${message}

### INSTRUCTIONS:
- Follow the vertical report structure defined in your rules.
- Prioritize Uploaded Document (CASE CONTEXT).
- Use Legal Knowledge (RAG) for references.
`;

        logger.info(`[LegalToolkit] Tool: ${toolName} | User: ${req.user?._id}`);

        // 🔥 STEP 3: CALL AI
        const responseData = await generateChatResponse(
            conversationHistory,
            enforcedMessage,
            systemPrompt,
            attachments,
            null, // Auto-detect language (English/Hindi/Hinglish)
            null,
            'LEGAL_TOOLKIT',
            sessionId,
            null, // projectId
            toolName
        );


        if (!responseData || !responseData.reply) {
            throw new Error('Empty response from AI');
        }

        // 🔥 STEP 4: FINAL RESPONSE CLEAN + TOOL TAG
        let finalReply = responseData.reply.trim();
        
        // 🏷️ ENSURE TOOL TAG EXISTS (UI FIX) - Skip for Draft Maker for clean PDF output
        if (!isDraftMaker && !finalReply.startsWith('**[ACTIVE TOOL:')) {
            const toolDisplayName = tool.name || toolName;
            finalReply = `**[ACTIVE TOOL: ${toolDisplayName}]**\n\n` + finalReply;
        }

        // 💰 Deduct credits on successful execution
        if (req.creditMeta && req.creditMeta.cost > 0) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        return res.json({
            success: true,
            reply: finalReply,
            toolUsed: toolName,
            creditsUsed: tool.creditCost || 0,
            suggestions: responseData.suggestions || []
        });

    } catch (error) {
        logger.error(`[LegalToolkit] Error: ${error.message}`);

        return res.status(500).json({
            success: false,
            error: 'Legal tool execution failed',
            details: error.message
        });
    }
});

export default router;