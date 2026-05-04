import OpenAI from 'openai';
import logger from '../utils/logger.js';
import { getConfig } from './configService.js';

// Simple in-memory cache for prompt enhancements
const promptCache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

const cleanCache = () => {
    if (promptCache.size > 1000) {
        const now = Date.now();
        for (const [key, value] of promptCache.entries()) {
            if (now - value.timestamp > CACHE_TTL) {
                promptCache.delete(key);
            }
        }
    }
};

/**
 * Enhances a raw user prompt based on the target media type.
 * @param {string} prompt Raw user prompt
 * @param {string} mediaType 'image' | 'video'
 * @returns {Promise<string>} Enhanced prompt
 */
/**
 * Enhances a raw user prompt using GPT-5.4 before passing to the image/video model.
 *
 * Architecture:
 *   User Input → GPT-5.4 (Prompt Enhancer) → Optimized Prompt → Execution Model
 *
 * @param {string} prompt - Raw user prompt
 * @param {string} mediaType - 'image' | 'video'
 * @returns {Promise<string>} Enhanced prompt
 */
export const enhancePrompt = async (prompt, mediaType) => {
    try {
        cleanCache();

        // Pre-process: Replace brand-sensitive word "AISA" with a neutral placeholder
        const AISA_PLACEHOLDER = '__PRODUCT_NAME__';
        const hasAisa = /\bAISA\b/i.test(prompt);
        const normalizedPrompt = hasAisa ? prompt.replace(/\bAISA\b/gi, AISA_PLACEHOLDER) : prompt;

        const cacheKey = `${mediaType}_${normalizedPrompt.trim().toLowerCase()}`;
        if (promptCache.has(cacheKey)) {
            const cached = promptCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                logger.info(`[PromptEnhancer] Cache hit for ${mediaType} prompt`);
                return cached.enhanced;
            }
        }

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            logger.warn('[PromptEnhancer] Missing OPENAI_API_KEY — skipping enhancement, using raw prompt');
            return prompt;
        }

        // Official OpenAI SDK — picks up OPENAI_API_KEY from env automatically
        const client = new OpenAI({ apiKey });

        // System instruction based on media type
        const systemInstruction = mediaType === 'video'
            ? getConfig('VIDEO_PROMPT_ENHANCER', `You are an expert video prompt engineer.
Enhance the given basic prompt to be highly descriptive for AI Video generation.
Format MUST follow strict structure: [Subject & Interactions] + [Environment] + [Lighting] + [Camera Movement/Angles] + [Quality/Style].

CRITICAL RULES — NEVER break these:
1. NEVER change, replace, drop, or ignore ANY of the intended main subjects. The intended subject is SACRED.
2. NEVER invent a new animal, person, object, or scene the user did not mention.
3. DO NOT include any prefix like "Prompt:" or extra conversational text. Keep it under 60 words.
4. If the prompt contains a placeholder like __PRODUCT_NAME__, treat it as a generic named entity.`)
            : getConfig('IMAGE_PROMPT_ENHANCER', `You are an expert image prompt engineer.
Your ONLY job is to add visual descriptors (style, lighting, quality) to the user's prompt.

CRITICAL RULES — NEVER break these:
1. NEVER change, replace, swap, or reinterpret the INTENDED main subject. Autocorrect obvious typos to the intended subject. The intended subject is SACRED.
2. NEVER invent a new animal, person, object, or scene the user did not mention.
3. ONLY add: art style, lighting quality, camera angle, mood, rendering quality.
4. Keep the output under 30 words.
5. DO NOT include any prefix like "Prompt:" or "Enhanced:".
6. If the prompt contains __PRODUCT_NAME__, treat it as a generic named entity — do NOT replace it with logos or brand visuals.

EXAMPLE:
Input: "generate image of panda"
Output: "A giant panda sitting in a bamboo forest, soft natural lighting, ultra-realistic, 8K, cinematic depth of field"

Input: "a dog on a beach"
Output: "A golden retriever dog playing on a sunny beach, golden hour lighting, shallow depth of field, photorealistic, 8K"`);

        logger.info(`[PromptEnhancer] Sending to GPT-5.4 for ${mediaType} prompt enhancement...`);

        // Official OpenAI Responses API
        const response = await client.responses.create({
            model: 'gpt-4o-mini',
            instructions: systemInstruction,
            input: `User Prompt: "${normalizedPrompt}"\n\nAdd visual quality descriptors. KEEP the exact subject. Return enhanced prompt only.`,
        });

        let enhancedText = response.output_text || normalizedPrompt;

        // Strip any hallucinated prefixes
        enhancedText = enhancedText
            .replace(/^(Here is the enhanced prompt:|Prompt:|Output:|Enhanced:|\*\*Enhanced Prompt:\*\*|\[.*?\]\s*-?\s*)/gi, '')
            .trim();

        // Restore "AISA" from placeholder
        if (hasAisa) {
            enhancedText = enhancedText.replace(new RegExp(AISA_PLACEHOLDER, 'g'), 'AISA');
        }

        logger.info(`[PromptEnhancer] GPT-5.4 enhanced: "${enhancedText.substring(0, 80)}..."`);

        // Cache the result
        promptCache.set(cacheKey, { enhanced: enhancedText, timestamp: Date.now() });

        return enhancedText;
    } catch (error) {
        logger.error(`[PromptEnhancer] GPT-5.4 enhancement failed: ${error.message} — falling back to raw prompt`);
        return prompt; // Non-fatal: image generation continues with original prompt
    }
};


/**
 * Clean and validate prompts to ensure safety and structure
 */
export const validatePrompt = (prompt) => {
    if (!prompt || typeof prompt !== 'string') {
        throw new Error('Prompt is missing or invalid');
    }
    
    // Basic sanitization
    const cleaned = prompt.replace(/[<>]/g, '').trim();
    if (cleaned.length < 2) {
        throw new Error('Prompt is too short');
    }
    if (cleaned.length > 2000) {
        throw new Error('Prompt is too long (max 2000 chars)');
    }
    
    return cleaned;
};

/**
 * Execute Video Pipeline with retries, caching, and enhancement
 */
export const executeVideoPipeline = async (rawPrompt, generateFunction, context) => {
    let currentPrompt = validatePrompt(rawPrompt);
    
    // 1. Enhancement (if not explicitly disabled)
    let finalPrompt = currentPrompt;
    if (context.enhance !== false) {
        finalPrompt = await enhancePrompt(currentPrompt, 'video');
        logger.info(`[GenerationPipeline] Enhanced Video Prompt: ${finalPrompt}`);
    }

    // 2. Queue Tracker / Retry Mechanism Logic 
    const maxRetries = 1;
    let attempt = 0;
    let lastError = null;

    // Define fallback models (cinema → fast on failure)
    const fallbackMap = {
        'veo-3.1-generate-001':      'veo-3.1-fast-generate-001',
        'veo-3.1-fast-generate-001': 'veo-3.1-fast-generate-001',
    };

    while (attempt <= maxRetries) {
        try {
            logger.info(`[GenerationPipeline] Starting Video Task (Attempt ${attempt + 1}/${maxRetries + 1}) with model ${context.modelId}`);
            
            // Execute the actual heavy generation function passed from controller
            const result = await generateFunction(finalPrompt, context.modelId);
            
            if (result) {
                return {
                    success: true,
                    url: result,
                    finalPrompt,
                    modelId: context.modelId
                };
            } else {
                throw new Error("Generation returned null/undefined");
            }
        } catch (error) {
            lastError = error;
            logger.warn(`[GenerationPipeline] Attempt ${attempt + 1} failed: ${error.message}`);
            
            attempt++;
            if (attempt <= maxRetries) {
                // Determine fallback model
                const fallback = fallbackMap[context.modelId];
                if (fallback) {
                    logger.info(`[GenerationPipeline] Switching to fallback model: ${fallback}`);
                    context.modelId = fallback;
                } else {
                    logger.warn(`[GenerationPipeline] No fallback block defined for ${context.modelId}, retrying with same.`);
                }
            }
        }
    }

    throw new Error(`Pipeline failed after ${maxRetries + 1} attempts. Last error: ${lastError.message}`);
};

/**
 * Execute Image Pipeline with retries, caching, and enhancement
 */
export const executeImagePipeline = async (rawPrompt, generateFunction, context) => {
    const pipelineStart = Date.now();

    console.log('\n' + '\u2550'.repeat(55));
    console.log(`\ud83d\ude80 IMAGE PIPELINE STARTED`);
    console.log('\u2550'.repeat(55));
    console.log(`  \u2022 Raw Prompt : "${rawPrompt.substring(0, 70)}${rawPrompt.length > 70 ? '...' : ''}"`);
    console.log(`  \u2022 Model      : ${context.modelId}`);
    console.log(`  \u2022 Enhance    : ${context.enhance !== false ? 'YES (GPT-5.4)' : 'NO (skipped)'}`);
    console.log('\u2500'.repeat(55));

    let currentPrompt = validatePrompt(rawPrompt);
    let finalPrompt = currentPrompt;

    // Detect if the user already provided a rich, detailed prompt
    // If so, skip GPT-5.4 enhancement to preserve their exact intent
    const RICH_PROMPT_KEYWORDS = [
        'cinematic', 'ultra-realistic', 'photorealistic', 'hyperrealistic',
        '8k', '4k', 'hdr', 'shot on', 'depth of field', 'moody', 'dramatic',
        'high-contrast', 'bokeh', 'volumetric', 'studio lighting', 'golden hour',
        'full-body', 'close-up', 'wide angle', 'macro', 'aerial view',
        'detailed', 'intricate', 'highly detailed', 'masterpiece'
    ];
    const promptLower = currentPrompt.toLowerCase();
    const isAlreadyRich = currentPrompt.length > 150 ||
        RICH_PROMPT_KEYWORDS.some(kw => promptLower.includes(kw));

    if (context.enhance !== false && !isAlreadyRich) {
        console.log(`🧠 [Pipeline Step 1] Enhancing short prompt via GPT-5.4...`);
        finalPrompt = await enhancePrompt(currentPrompt, 'image');
        console.log(`✅ [Pipeline Step 1] Enhancement complete.`);
        console.log(`   • Before : "${currentPrompt.substring(0, 60)}"`);
        console.log(`   • After  : "${finalPrompt.substring(0, 60)}"`);
    } else if (isAlreadyRich) {
        console.log(`⏭️  [Pipeline Step 1] Rich prompt detected (${currentPrompt.length} chars) — skipping enhancement, using as-is.`);
    } else {
        console.log(`⏭️  [Pipeline Step 1] Enhancement disabled — using raw prompt.`);
    }


    // 2. Model Execution with Retry
    const maxRetries = 1;
    let attempt = 0;
    let lastError = null;

    const fallbackMap = {
        'gemini-3.1-flash-image-preview': 'gemini-1.5-flash-image',
        'gemini-3-pro-image-preview':     'gemini-3.1-flash-image-preview',
    };

    while (attempt <= maxRetries) {
        try {
            console.log(`\ud83d\uddbc\ufe0f  [Pipeline Step 2] Calling image model (Attempt ${attempt + 1}/${maxRetries + 1}) \u2192 ${context.modelId}`);
            const result = await generateFunction(finalPrompt, context.modelId);

            if (result) {
                const elapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
                console.log('\u2550'.repeat(55));
                console.log(`\ud83c\udf89 IMAGE PIPELINE COMPLETE in ${elapsed}s`);
                console.log('\u2550'.repeat(55) + '\n');
                return {
                    success: true,
                    url: result,
                    finalPrompt,
                    modelId: context.modelId
                };
            } else {
                throw new Error("Generation returned null");
            }
        } catch (error) {
            lastError = error;
            console.warn(`\u26a0\ufe0f  [Pipeline] Attempt ${attempt + 1} failed: ${error.message}`);
            attempt++;
            if (attempt <= maxRetries) {
                const fallback = fallbackMap[context.modelId] || context.modelId;
                console.log(`\ud83d\udd04 [Pipeline] Switching to fallback model: ${fallback}`);
                context.modelId = fallback;
            }
        }
    }

    console.error(`\u274c [Pipeline] All ${maxRetries + 1} attempts failed.`);
    throw new Error(`Pipeline failed after ${maxRetries + 1} attempts. Last error: ${lastError.message}`);
};
