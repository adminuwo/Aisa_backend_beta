/**
 * AISA Model Selector
 * Picks the optimal AI model based on:
 * - Media type (image / video)
 * - User-requested quality/speed tradeoff
 * - User subscription tier
 * - Tool registry metadata
 */

import { getToolByName } from './intent/toolRegistry.js';
import logger from '../utils/logger.js';

/**
 * Selects the best image model for a given quality request.
 * @param {string} requestedModelId - Model provided in request (explicit selection)
 * @param {'fast'|'quality'|'ultra'} quality - Quality hint
 * @param {boolean} isPremium - Is user a premium subscriber
 * @returns {string} - Final model ID to use
 */
export const selectImageModel = (requestedModelId, quality = 'fast', isPremium = false) => {
    // Quality tier map → Gemini image models (all use @google/genai SDK, global endpoint)
    const modelMap = {
        fast:    'gemini-1.5-flash-image',
        quality: 'gemini-3.1-flash-image-preview',
        ultra:   'gemini-3-pro-image-preview',
    };

    // All valid Gemini image models the frontend can select via model cards
    const knownModels = [
        'gemini-1.5-flash-image',
        'gemini-3.1-flash-image-preview',
        'gemini-3-pro-image-preview',
    ];

    // If frontend sent a valid model ID, use it directly
    if (requestedModelId && knownModels.includes(requestedModelId)) {
        return requestedModelId;
    }

    // Auto-select based on quality hint
    const selected = modelMap[quality] || modelMap.fast;
    logger.info(`[ModelSelector] Auto-selected image model: ${selected} (quality=${quality}, premium=${isPremium})`);
    return selected;
};

/**
 * Selects the best video model.
 * @param {string} requestedModelId - Model provided in request
 * @param {'fast'|'cinema'} quality - Quality hint
 * @param {boolean} isPremium - Is user a premium subscriber
 * @returns {string} - Final model ID to use
 */
export const selectVideoModel = (requestedModelId, quality = 'fast', isPremium = false) => {
    const modelMap = {
        fast:   'veo-3.1-fast-generate-001',
        cinema: 'veo-3.1-generate-001'
    };

    // All valid Veo video models the frontend can select via model cards
    const knownModels = ['veo-3.1-fast-generate-001', 'veo-3.1-generate-001'];

    if (requestedModelId && knownModels.includes(requestedModelId)) {
        // Cinema/Pro model is premium-only — uncomment to enforce:
        // if (requestedModelId === 'veo-3.1-generate-001' && !isPremium) {
        //     logger.warn('[ModelSelector] Cinema model requested by non-premium user, downgrading to Fast');
        //     return 'veo-3.1-fast-generate-001';
        // }
        return requestedModelId;
    }

    const selected = quality === 'cinema'
        ? modelMap.cinema
        : modelMap.fast;

    logger.info(`[ModelSelector] Auto-selected video model: ${selected} (quality=${quality}, premium=${isPremium})`);
    return selected;
};

/**
 * Universal model selector driven by tool registry metadata.
 * @param {string} toolName - Tool key from registry (e.g., 'text_to_image')
 * @param {Object} options - { requestedModelId, quality, isPremium }
 * @returns {string} resolved model ID
 */
export const selectModelForTool = (toolName, { requestedModelId, quality = 'fast', isPremium = false } = {}) => {
    const tool = getToolByName(toolName);

    if (!tool) {
        logger.warn(`[ModelSelector] Unknown tool: ${toolName}, no model to select`);
        return requestedModelId || null;
    }

    if (toolName === 'text_to_image' || toolName === 'image_edit') {
        return selectImageModel(requestedModelId, quality, isPremium);
    }

    if (toolName === 'text_to_video' || toolName === 'image_to_video' || toolName === 'text_to_image_to_video') {
        return selectVideoModel(requestedModelId, quality, isPremium);
    }

    // For other tools (chat, search, etc.) just return what was requested or null
    return requestedModelId || null;
};

/**
 * Returns the fallback model for a given tool from the registry.
 * @param {string} toolName
 * @returns {string|null}
 */
export const getFallbackModel = (toolName) => {
    const tool = getToolByName(toolName);
    return tool?.fallbackModel || null;
};
