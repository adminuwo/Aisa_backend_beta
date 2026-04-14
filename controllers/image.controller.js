import { uploadToGCS, gcsFilename } from '../services/gcs.service.js';
import logger from '../utils/logger.js';
import { GoogleGenAI, Modality } from '@google/genai';
import { refineAdvancedEditPrompt, generateFollowUpPrompts } from '../utils/imagePromptController.js';
import { getConfig } from '../services/configService.js';
import { subscriptionService } from '../services/subscriptionService.js';
import { selectImageModel } from '../services/modelSelector.js';
import { executeImagePipeline } from '../services/generationPipeline.js';
import axios from 'axios';

// ------------------------------------------------------------------
// Gemini image models — use @google/genai SDK with global endpoint
// Imagen models — use Vertex AI REST predict API
// ------------------------------------------------------------------
const GEMINI_IMAGE_MODELS = [
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-image-preview',
    'gemini-2.5-flash-image',
];

const getGenAIClient = (location = 'global') => new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID,
    location,
});

// ------------------------------------------------------------------
// Gemini SDK Streaming Generator
// Uses generateContentStream + collects inlineData chunks
// ------------------------------------------------------------------
const generateWithGeminiSDK = async (prompt, modelId, aspectRatio = '1:1') => {
    console.log(`[Gemini GenAI SDK] Generating with model: ${modelId} | Ratio: ${aspectRatio} | Prompt: "${prompt}"`);
    const client = getGenAIClient('global');

    // Map frontend aspect ratios to Gemini-supported values
    let geminiRatio = '1:1';
    if (aspectRatio === '16:9') geminiRatio = '16:9';
    else if (aspectRatio === '9:16') geminiRatio = '9:16';
    else if (aspectRatio === '4:5') geminiRatio = '4:5';
    else if (aspectRatio === '3:4') geminiRatio = '3:4';
    else if (aspectRatio === '4:3') geminiRatio = '4:3';

    console.log(`[Gemini GenAI SDK] Resolved aspect ratio: "${aspectRatio}" → "${geminiRatio}"`);

    // Build config — always pass aspectRatio explicitly so API never defaults to a different ratio
    const config = {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        imageConfig: {
            personGeneration: 'ALLOW_ALL',
            aspectRatio: geminiRatio,
        }
    };

    const response = await client.models.generateContentStream({
        model: modelId,
        contents: prompt,
        config
    });

    let base64Data = null;
    let mimeType = 'image/png';
    let responseText = null;

    for await (const chunk of response) {
        if (chunk.text) {
            console.log(`[Gemini GenAI SDK] Model says: ${chunk.text}`);
            responseText = chunk.text;
        } else if (chunk.data) {
            // chunk.data is already a Buffer/Uint8Array of raw image bytes
            base64Data = Buffer.from(chunk.data).toString('base64');
            console.log(`[Gemini GenAI SDK] Received image chunk (${base64Data.length} base64 chars)`);
        }
        
        // Also check inlineData format (some SDK versions pack it this way)
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
            if (part.inlineData?.data) {
                base64Data = part.inlineData.data;
                mimeType = part.inlineData.mimeType || 'image/png';
            }
        }
    }

    if (!base64Data) {
        const reason = responseText ? `Model responded: ${responseText}` : 'No image data in response';
        throw new Error(`[Gemini GenAI SDK] Generation failed — ${reason}`);
    }

    return { base64Data, mimeType };
};

export const generateImageFromPrompt = async (prompt, originalImage = null, aspectRatio = '1:1', selectedModelId = 'gemini-3.1-flash-image-preview', manualEditMode = null) => {
    try {
        console.log(`[VERTEX IMAGE] Triggered for: "${prompt}" (Edit: ${!!originalImage}, Ratio: ${aspectRatio}, Model: ${selectedModelId})`);

        if (!process.env.GCP_PROJECT_ID) {
            console.warn('[VERTEX IMAGE] Missing GCP_PROJECT_ID');
            throw new Error('Missing GCP_PROJECT_ID');
        }

        let base64Data = null;
        let mimeType = 'image/png';
        let usedModel = selectedModelId;

        // Ensure the model is one of the supported Gemini models
        if (!GEMINI_IMAGE_MODELS.includes(usedModel)) {
            usedModel = 'gemini-3.1-flash-image-preview';
        }

        try {
            const result = await generateWithGeminiSDK(prompt, usedModel, aspectRatio);
            base64Data = result.base64Data;
            mimeType = result.mimeType;
        } catch (geminiErr) {
            console.warn(`[Gemini GenAI SDK] ${usedModel} failed: ${geminiErr.message} — falling back to gemini-2.5-flash-image`);
            usedModel = 'gemini-2.5-flash-image';
            const fallbackResult = await generateWithGeminiSDK(prompt, usedModel, aspectRatio);
            base64Data = fallbackResult.base64Data;
            mimeType = fallbackResult.mimeType;
        }

        // -------------------------------------------------------
        // Upload to GCS
        // -------------------------------------------------------
        if (base64Data) {
            console.log(`[GCS] Uploading result from ${usedModel}...`);
            const buffer = Buffer.from(base64Data, 'base64');
            const gcsResult = await uploadToGCS(buffer, {
                folder: 'generated_images',
                filename: gcsFilename(`aisa_${originalImage ? 'edit' : 'gen'}`),
                mimeType,
                isPublic: true,
                useSignedUrl: false,
            });

            if (gcsResult?.publicUrl) {
                console.log(`[IMAGE SUCCESS] ${gcsResult.publicUrl}`);
                return gcsResult.publicUrl;
            }
        }

        throw new Error(`Image pipeline (${usedModel}) returned no image data.`);

    } catch (error) {
        const vertexMsg = error.response?.data?.error?.message || error.message || 'Unknown error';
        console.error(`[VERTEX GEN FAILED] ${vertexMsg}`);
        throw new Error(`Google Vertex AI Image Generation Failed: ${vertexMsg}`);
    }
};

// -------------------------------------------------------------------
// @route  POST /api/image/generate
// -------------------------------------------------------------------
export const generateImage = async (req, res, next) => {
    try {
        let { prompt, aspectRatio = '1:1', modelId, quality = 'fast' } = req.body || {};

        if (!prompt) {
            return res.status(400).json({ success: false, message: 'Prompt is required' });
        }

        const isPremium = req.user?.isPremium || false;
        
        // 1. Resolve optimal model using selector
        const resolvedModelId = selectImageModel(modelId, quality, isPremium);

        // 2. Execute via Pipeline (Handles enhancement, retries, and fallback)
        const pipelineResult = await executeImagePipeline(
            prompt, 
            async (finalPrompt, activeModel) => {
                // Wrapper for the actual generation logic
                return await generateImageFromPrompt(finalPrompt, null, aspectRatio, activeModel);
            },
            {
                modelId: resolvedModelId,
                enhance: true // Toggle based on UI if needed
            }
        );

        const imageUrl = pipelineResult.url;
        if (!imageUrl) throw new Error('Failed to retrieve image URL.');

        // 3. Generate follow-up suggestions based on BOTH prompt and the generated image
        const followUpPrompts = await generateFollowUpPrompts(prompt, imageUrl).catch(() => []);

        // 💰 Deduct credits on successful output
        if (req.creditMeta && req.creditMeta.cost > 0) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.status(200).json({ 
            success: true, 
            data: imageUrl,
            refinedPrompt: pipelineResult.finalPrompt,
            modelUsed: pipelineResult.modelId,
            followUpPrompts
        });
    } catch (error) {
        logger?.error
            ? logger.error(`[Image Generation] Error: ${error.message}`)
            : console.error('[Image Generation] Error:', error);
        res.status(500).json({ success: false, message: `Image generation failed: ${error.message}` });
    }
};

// ...
// -------------------------------------------------------------------
// @route  GET /api/image/proxy?url=...
// -------------------------------------------------------------------
export const proxyImage = async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).send('URL is required');
    }
    console.log(`[Image Proxy] Fetching:`, url);

    try {
        const response = await axios.get(url, {
            responseType: 'stream',
            timeout: 10000,
            headers: {
                'User-Agent': 'AISA-Backend-Proxy'
            }
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'image/png');
        res.setHeader('Access-Control-Allow-Origin', '*'); // Ensure CORS is allowed for this proxy
        
        response.data.pipe(res);
    } catch (err) {
        console.error(`[Image Proxy Error]: ${err.message}. ${err.response ? 'Status: ' + err.response.status : ''}`);
        res.status(500).send('Failed to proxy image');
    }
};
