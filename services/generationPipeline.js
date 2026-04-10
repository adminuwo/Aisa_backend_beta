import { GoogleGenAI } from '@google/genai';
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
export const enhancePrompt = async (prompt, mediaType) => {
    try {
        cleanCache();

        // Pre-process: Replace brand-sensitive word "AISA" with a neutral placeholder
        // so the LLM enhancer doesn't interpret it as a logo/branding request.
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

        const projectId = process.env.GCP_PROJECT_ID;
        if (!projectId) {
            logger.warn('[PromptEnhancer] Missing GCP_PROJECT_ID, skipping enhancement');
            return prompt;
        }

        const client = new GoogleGenAI({
            vertexai: true,
            project: projectId,
            location: 'us-central1'
        });

        let systemInstruction = '';
        if (mediaType === 'video') {
            systemInstruction = getConfig('VIDEO_PROMPT_ENHANCER', `You are an expert video prompt engineer.
Enhance the given basic prompt to be highly descriptive for AI Video generation.
Format MUST follow strict structure: [Subject] + [Environment] + [Lighting] + [Camera Movement/Angles] + [Quality/Style].
DO NOT include any prefix like "Prompt:" or extra conversational text. Keep it under 60 words for maximum impact.
If the prompt contains a placeholder like __PRODUCT_NAME__, treat it as a generic named entity or product and do NOT replace it with branding, logos, or specific visual styles.`);
        } else {
            systemInstruction = getConfig('IMAGE_PROMPT_ENHANCER', `You are an expert image prompt engineer.
Enhance the user prompt. Keep it punchy, short, and cost-effective for token usage, while maximizing visual impact.
Focus ONLY on [Subject], [Core Style], and [Lighting].
DO NOT include any prefix like "Prompt:". Stay under 30 words.
If the prompt contains a placeholder like __PRODUCT_NAME__, treat it as a generic named entity and do NOT replace it with logos, brand visuals, or specific identifiable imagery.`);
        }

        logger.info(`[PromptEnhancer] Enhancing ${mediaType} prompt via LLM...`);
        const response = await client.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: [{ role: 'user', parts: [{ text: `Original Prompt: "${normalizedPrompt}"\n\nEnhance this.` }] }],
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.7,
                maxOutputTokens: 200,
            }
        });

        let enhancedText = response.text || normalizedPrompt;
        // Clean up any weird prefixes the LLM might hallucinate
        enhancedText = enhancedText.replace(/^(Here is the enhanced prompt:|Prompt:|\*\*Enhanced Prompt:\*\*|\[.*?\]\s*-?\s*)/gi, '').trim();

        // Post-process: Restore the original word AISA from the placeholder
        if (hasAisa) {
            enhancedText = enhancedText.replace(new RegExp(AISA_PLACEHOLDER, 'g'), 'AISA');
        }

        // Save to cache
        promptCache.set(cacheKey, {
            enhanced: enhancedText,
            timestamp: Date.now()
        });

        return enhancedText;
    } catch (error) {
        logger.error(`[PromptEnhancer] Failed to enhance prompt: ${error.message}`);
        return prompt; // Fallback to original
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

    // Define fallback models
    const fallbackMap = {
        'veo-3.1-fast-generate-001': 'veo-3.1-generate-001',
        'veo-3.1-generate-001': 'veo-3.1-fast-generate-001'
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
    let currentPrompt = validatePrompt(rawPrompt);
    
    // 1. Enhancement
    let finalPrompt = currentPrompt;
    if (context.enhance !== false) {
        finalPrompt = await enhancePrompt(currentPrompt, 'image');
        logger.info(`[GenerationPipeline] Enhanced Image Prompt: ${finalPrompt}`);
    }

    // 2. Retry Logic
    const maxRetries = 1;
    let attempt = 0;
    let lastError = null;
    
    const fallbackMap = {
        'imagen-3.0-generate-001': 'imagen-3.0-generate-002', // Clean Imagen fallback
        'imagen-4.0-ultra-generate-001': 'imagen-3.0-generate-001'
    };

    while (attempt <= maxRetries) {
        try {
            logger.info(`[GenerationPipeline] Starting Image Task (Attempt ${attempt + 1}/${maxRetries + 1}) with model ${context.modelId}`);
            const result = await generateFunction(finalPrompt, context.modelId);
            
            if (result) {
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
            logger.warn(`[GenerationPipeline] Image Attempt ${attempt + 1} failed: ${error.message}`);
            attempt++;
            if (attempt <= maxRetries) {
                const fallback = fallbackMap[context.modelId];
                if (fallback) {
                    logger.info(`[GenerationPipeline] Switching to image fallback model: ${fallback}`);
                    context.modelId = fallback;
                }
            }
        }
    }

    throw new Error(`Pipeline failed after ${maxRetries + 1} attempts. Last error: ${lastError.message}`);
};
