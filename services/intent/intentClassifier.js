/**
 * AISA Intent Classifier
 * LLM-based intent detection using OpenAI GPT-4o-mini.
 * Low temperature (0.1) for deterministic, structured JSON output.
 * Supports text, multilingual input, and attachment context.
 */

import axios from 'axios';
import logger from '../../utils/logger.js';
import { buildToolListForPrompt } from './toolRegistry.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLASSIFIER_MODEL = 'gpt-4o-mini';
const CONFIDENCE_THRESHOLD = 0.75;

/**
 * The system prompt for the intent classifier.
 * Generated dynamically so new tools from the registry are always included.
 */
const buildClassifierSystemPrompt = () => {
    const toolList = buildToolListForPrompt();

    return `You are AISA Intent Classifier — the AI routing brain of a multi-modal AI platform called AISA.

Your ONLY job is to analyze user input and return a structured JSON routing decision.

## Available Tools
${toolList}

## Attachment Types You May Receive
- image (jpg, png, webp, gif)
- video (mp4, mov)
- audio (mp3, wav, mpeg)
- document (pdf, docx, xlsx, pptx, txt, csv)

## Classification Rules
1. ALWAYS return VALID JSON only — no explanation, no markdown wrappers, no text outside JSON.
2. If multiple tools are needed, list them in execution ORDER in the "tools" array.
3. Set requires_assets: true if the primary tool NEEDS an attachment that was NOT provided.
4. confidence must be a float from 0.0 to 1.0.
5. If intent is ambiguous OR confidence < 0.5, set intent: "uncertain" and provide a clarification_question.
6. You MUST handle Hinglish, Hindi, Arabic, and all major world languages — detect and note the language.
7. For image+video combos ("edit this image" with attachment), prefer image_edit or image_to_video over text_to_image.
8. "Make a video with music" = text_to_video + text_to_audio (two separate tools, listed in order).
9. If the user asks a general legal question, explains a situation, or asks about a law without requesting a specific advanced task (like drafting, analysis, or prediction), use legal_free_chat.
10. **LEGAL SMART SUGGESTIONS**: If the intent is legal (starts with legal_), you MUST provide 2-3 extra relevant tool IDs in the "suggestions" array that could help the user further.
    - Example: User wants a "Legal Notice for non-payment" -> intent: legal_notice_generator, suggestions: ["legal_evidence_checker", "legal_case_predictor", "legal_strategy_engine"].
    - Example: User asks "Is this contract safe?" -> intent: legal_contract_analyzer, suggestions: ["legal_clause_scanner", "legal_clause_rewriter"].
12. **STOCK ANALYSIS**: If the user asks about a stock (e.g. "Reliance analysis", "TCS buy or sell", "What about Google stock?"), use stock_researcher. Always try to extract the likely stock symbol or name into metadata.stock_symbol if possible.
13. estimated_credits = sum of creditCost for all tools in the pipeline.

## Tool Credit Costs (for estimated_credits calculation)
- normal_chat: 0
- legal_free_chat: 0
- text_to_image: 60
- image_edit: 60
- text_to_video: 300 (base, 5 sec fast model 1080p)
- image_to_video: 50
- text_to_audio: 25
- web_search: 15
- deep_search: 30
- stock_researcher: 50
- code_writer: 10
- file_analysis: 5
- file_conversion: 15
- knowledge_base: 10
- legal_draft_maker: 100
- legal_nda_generator: 80
- legal_contract_analyzer: 150
- legal_case_predictor: 200
- legal_evidence_checker: 120
- legal_notice_generator: 90
- legal_affidavit_generator: 85
- legal_clause_scanner: 110
- legal_clause_rewriter: 75
- legal_strategy_engine: 180
- legal_research_assistant: 130
- legal_timeline_generator: 95
- legal_compliance_checker: 140
- legal_law_comparator: 160
- stock_researcher: 50
- legal_argument_builder: 180

## Output JSON Schema (return EXACTLY this structure)
{
  "intent": "string (one of the tool keys above, or 'uncertain')",
  "tools": ["string array of tool keys in execution order"],
  "pipeline_type": "single | sequential | parallel | hybrid",
  "confidence": 0.0,
  "input_type": "text | image | video | audio | document | mixed",
  "requires_assets": false,
  "missing_assets": null,
  "clarification_question": null,
  "estimated_credits": 0,
  "detected_language": "English",
  "frontend_mode": "string (the mode key to set in frontend)",
  "suggestions": ["array of 2-3 relevant tool IDs for further action"],
  "metadata": {
    "suggested_duration": null,
    "suggested_model": null,
    "output_format": null,
    "prompt_enhancement": null
  }
}`;
};

/**
 * Classify user intent using GPT-4o-mini
 * @param {string} message - User's text message
 * @param {Array} attachments - Array of attachment metadata objects
 * @param {string} conversationSummary - Recent conversation context (last 3 messages)
 * @returns {Object} Structured classification result
 */
export const classifyIntent = async (message, attachments = [], conversationSummary = '') => {
    try {
        if (!OPENAI_API_KEY) {
            logger.warn('[IntentClassifier] OPENAI_API_KEY not set. Using fallback classification.');
            return buildFallbackResult(message, attachments);
        }

        // Build attachment context string for the classifier
        const attachmentContext = attachments && attachments.length > 0
            ? `\nAttachments: ${attachments.map(a => `${a.type || 'file'} (${a.name || 'unnamed'})`).join(', ')}`
            : '\nAttachments: none';

        const conversationContext = conversationSummary
            ? `\nRecent conversation context: ${conversationSummary}`
            : '';

        const userContent = `User Message: "${message}"${attachmentContext}${conversationContext}`;

        logger.info(`[IntentClassifier] Classifying: "${message.substring(0, 60)}..."`);

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: CLASSIFIER_MODEL,
                messages: [
                    { role: 'system', content: buildClassifierSystemPrompt() },
                    { role: 'user', content: userContent }
                ],
                temperature: 0.1,
                max_tokens: 400,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000 // 10s timeout — classifier must be fast
            }
        );

        const rawContent = response.data.choices[0].message.content;
        let result;

        try {
            result = JSON.parse(rawContent);
        } catch (parseErr) {
            logger.error('[IntentClassifier] JSON parse failed:', rawContent);
            return buildFallbackResult(message, attachments);
        }

        // Validate required fields
        if (!result.intent || !Array.isArray(result.tools)) {
            logger.warn('[IntentClassifier] Invalid response structure, using fallback');
            return buildFallbackResult(message, attachments);
        }

        // Enforce confidence threshold
        if (result.confidence < 0.5 && result.intent !== 'uncertain') {
            result.intent = 'uncertain';
            if (!result.clarification_question) {
                result.clarification_question = 'Could you clarify what you\'d like to create? For example: an image, video, audio, or just a text response?';
            }
        }

        logger.info(`[IntentClassifier] Result: intent=${result.intent}, confidence=${result.confidence}, tools=[${result.tools.join(', ')}]`);
        return { ...result, classified: true };

    } catch (error) {
        logger.error(`[IntentClassifier] Error: ${error.response?.data?.error?.message || error.message}`);
        return buildFallbackResult(message, attachments);
    }
};

/**
 * Fallback classification when LLM is unavailable.
 * Uses simple structural checks (not keyword matching — just attachment presence).
 */
const buildFallbackResult = (message, attachments = []) => {
    const hasAttachments = attachments && attachments.length > 0;
    const hasImage = hasAttachments && attachments.some(a =>
        a.type === 'image' || a.mimeType?.startsWith('image/')
    );
    const hasDocument = hasAttachments && attachments.some(a =>
        a.type === 'document' ||
        ['application/pdf', 'application/msword'].some(m => a.mimeType?.startsWith(m))
    );

    if (hasImage) {
        return buildResult('file_analysis', ['file_analysis'], 'single', 0.6, 'image', false, null, null, 5, 'English', 'FILE_ANALYSIS');
    }
    if (hasDocument) {
        return buildResult('file_analysis', ['file_analysis'], 'single', 0.6, 'document', false, null, null, 5, 'English', 'FILE_ANALYSIS');
    }
    return buildResult('normal_chat', ['normal_chat'], 'single', 0.65, 'text', false, null, null, 0, 'English', 'NORMAL_CHAT');
};

/**
 * Helper to build a structured result object
 */
const buildResult = (
    intent, tools, pipelineType, confidence, inputType,
    requiresAssets, missingAssets, clarificationQuestion,
    estimatedCredits, detectedLanguage, frontendMode, metadata = {}
) => ({
    intent,
    tools,
    pipeline_type: pipelineType,
    confidence,
    input_type: inputType,
    requires_assets: requiresAssets,
    missing_assets: missingAssets,
    clarification_question: clarificationQuestion,
    estimated_credits: estimatedCredits,
    detected_language: detectedLanguage,
    frontend_mode: frontendMode,
    metadata: {
        suggested_duration: metadata.suggested_duration || null,
        suggested_model: metadata.suggested_model || null,
        output_format: metadata.output_format || null,
        prompt_enhancement: metadata.prompt_enhancement || null
    },
    classified: false // flagged as fallback
});

export const CONFIDENCE_THRESHOLD_VALUE = CONFIDENCE_THRESHOLD;
