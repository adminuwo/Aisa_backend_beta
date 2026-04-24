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
// Supported Gemini image models (via @google/genai SDK, location: global)
// ------------------------------------------------------------------
const GEMINI_IMAGE_MODELS = [
    'gemini-2.5-flash-image',
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-image-preview',
];

const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';

const getGenAIClient = () => new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID,
    location: 'global', // Image models require global endpoint
});

// ------------------------------------------------------------------
// Core image generation & editing function
// model is passed from the frontend card selection and used directly
// ------------------------------------------------------------------
export const generateImageFromPrompt = async (prompt, originalImage = null, aspectRatio = '1:1', selectedModelId = DEFAULT_IMAGE_MODEL) => {
    try {
        if (!process.env.GCP_PROJECT_ID) {
            throw new Error('Missing GCP_PROJECT_ID in environment');
        }

        // Validate and resolve model — fall back to default if unknown
        const model = GEMINI_IMAGE_MODELS.includes(selectedModelId) ? selectedModelId : DEFAULT_IMAGE_MODEL;
        console.log(`[IMAGE] Model: ${model} | Edit: ${!!originalImage} | Ratio: ${aspectRatio} | Prompt: "${prompt.substring(0, 60)}..."`);

        const client = getGenAIClient();
        let base64Data = null;
        let mimeType = 'image/png';

        if (originalImage) {
            // ── IMAGE EDITING ──────────────────────────────────────────────
            // Uses generateContent (non-streaming) as per official SDK pattern
            const imageBytes = originalImage.includes('base64,')
                ? originalImage.split('base64,')[1]
                : originalImage;

            const response = await client.models.generateContent({
                model,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType: 'image/png', data: imageBytes } },
                        { text: prompt },
                    ],
                }],
                config: {
                    responseModalities: [Modality.TEXT, Modality.IMAGE],
                },
            });

            for (const part of response.candidates[0].content.parts) {
                if (part.text) {
                    console.log(`[IMAGE EDIT] Model says: ${part.text}`);
                } else if (part.inlineData) {
                    base64Data = part.inlineData.data;
                    mimeType = part.inlineData.mimeType || 'image/png';
                }
            }

            if (!base64Data) {
                throw new Error('Model returned no image for editing request.');
            }
        } else {
            // ── IMAGE GENERATION ───────────────────────────────────────────
            // Uses generateContentStream as per official SDK pattern
            const response = await client.models.generateContentStream({
                model,
                contents: prompt,
                config: {
                    responseModalities: [Modality.TEXT, Modality.IMAGE],
                },
            });

            for await (const chunk of response) {
                if (chunk.text) {
                    console.log(`[IMAGE GEN] Model says: ${chunk.text}`);
                } else if (chunk.data) {
                    // Raw binary data path
                    base64Data = Buffer.from(chunk.data).toString('base64');
                }
                // Also check candidates parts for inlineData
                const parts = chunk.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    if (part.inlineData?.data) {
                        base64Data = part.inlineData.data;
                        mimeType = part.inlineData.mimeType || 'image/png';
                    }
                }
            }

            if (!base64Data) {
                throw new Error('Model returned no image for generation request.');
            }
        }

        // ── UPLOAD TO GCS ──────────────────────────────────────────────
        console.log(`[GCS] Uploading ${originalImage ? 'edited' : 'generated'} image from model: ${model}...`);
        const buffer = Buffer.from(base64Data, 'base64');
        const gcsResult = await uploadToGCS(buffer, {
            folder: 'generated_images',
            filename: gcsFilename(`aisa_${originalImage ? 'edit' : 'gen'}`),
            mimeType,
        });

        if (gcsResult?.publicUrl) {
            console.log(`[IMAGE SUCCESS] ${gcsResult.publicUrl}`);
            return gcsResult.publicUrl;
        }

        throw new Error('GCS upload returned no public URL.');
    } catch (error) {
        const msg = error.message || 'Unknown error';
        console.error(`[IMAGE FAILED] ${msg}`);
        throw new Error(`Image Generation Failed: ${msg}`);
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
