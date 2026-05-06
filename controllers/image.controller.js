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

const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

const getGenAIClient = () => new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID,
    location: 'global', // Image models require global endpoint
});

export const generateImageFromPrompt = async (prompt, originalImage = null, aspectRatio = '1:1', selectedModelId = 'gemini-3.1-flash-image-preview', manualEditMode = null) => {
    const startTime = Date.now();
    try {
        if (!process.env.GCP_PROJECT_ID) {
            throw new Error('Missing GCP_PROJECT_ID in environment');
        }

        // Validate and resolve model — fall back to default if unknown
        const model = GEMINI_IMAGE_MODELS.includes(selectedModelId) ? selectedModelId : DEFAULT_IMAGE_MODEL;

        console.log('\n' + '─'.repeat(55));
        console.log(`🎨  IMAGE ${originalImage ? 'EDIT' : 'GEN'} ─ ${model}`);
        console.log('─'.repeat(55));
        console.log(`  • Prompt  : "${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
        console.log(`  • Mode    : ${originalImage ? '📝 EDITING existing image' : '✨ GENERATING new image'}`);
        console.log(`  • Ratio   : ${aspectRatio}`);
        console.log(`  • Model   : ${model}`);
        console.log(`  • SDK     : @google/genai | location: global`);
        console.log('─'.repeat(55));

        const client = getGenAIClient();
        let base64Data = null;
        let mimeType = 'image/png';

        if (originalImage) {
            // ── IMAGE EDITING ───────────────────────────────────────────
            const imageBytes = originalImage.includes('base64,')
                ? originalImage.split('base64,')[1]
                : originalImage;

            console.log(`⏳ [Step 1/3] Sending image + prompt to ${model} via generateContent...`);
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
            console.log(`✅ [Step 1/3] Response received from ${model}`);

            console.log(`🔍 [Step 2/3] Extracting image data from response parts...`);
            for (const part of response.candidates[0].content.parts) {
                if (part.text) {
                    console.log(`   • Model note: ${part.text.substring(0, 100)}`);
                } else if (part.inlineData) {
                    base64Data = part.inlineData.data;
                    mimeType = part.inlineData.mimeType || 'image/png';
                    console.log(`   ✅ Image data extracted | MIME: ${mimeType} | Size: ~${Math.round(base64Data.length * 0.75 / 1024)}KB`);
                }
            }

            if (!base64Data) {
                throw new Error('Model returned no image for editing request.');
            }
        } else {
            // ── IMAGE GENERATION ───────────────────────────────────────────
            console.log(`⏳ [Step 1/3] Sending prompt to ${model} via generateContentStream...`);
            const response = await client.models.generateContentStream({
                model,
                contents: prompt,
                config: {
                    responseModalities: [Modality.TEXT, Modality.IMAGE],
                },
            });

            console.log(`📡 [Step 1/3] Stream opened, receiving chunks...`);
            let chunkCount = 0;
            for await (const chunk of response) {
                chunkCount++;
                if (chunk.text) {
                    console.log(`   • Model says: ${chunk.text.substring(0, 100)}`);
                } else if (chunk.data) {
                    base64Data = Buffer.from(chunk.data).toString('base64');
                    console.log(`   • Chunk #${chunkCount}: raw binary data received`);
                }
                const parts = chunk.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    if (part.inlineData?.data) {
                        base64Data = part.inlineData.data;
                        mimeType = part.inlineData.mimeType || 'image/png';
                        console.log(`   ✅ Chunk #${chunkCount}: inlineData image | MIME: ${mimeType}`);
                    }
                }
            }
            console.log(`✅ [Step 1/3] Stream complete. Total chunks: ${chunkCount}`);

            if (!base64Data) {
                throw new Error('Model returned no image for generation request.');
            }
            console.log(`🔍 [Step 2/3] Image data extracted | Size: ~${Math.round(base64Data.length * 0.75 / 1024)}KB`);
        }

        // ── UPLOAD TO GCS ──────────────────────────────────────────────
        console.log(`☁️  [Step 3/3] Uploading to Google Cloud Storage...`);
        const buffer = Buffer.from(base64Data, 'base64');
        const gcsResult = await uploadToGCS(buffer, {
            folder: 'generated_images',
            filename: gcsFilename(`aisa_${originalImage ? 'edit' : 'gen'}`),
            mimeType,
        });

        if (gcsResult?.publicUrl) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`✅ [Step 3/3] GCS upload complete!`);
            console.log('─'.repeat(55));
            console.log(`🎉 IMAGE ${originalImage ? 'EDIT' : 'GEN'} SUCCESS in ${elapsed}s`);
            console.log(`🔗 URL: ${gcsResult.publicUrl.substring(0, 70)}...`);
            console.log('─'.repeat(55) + '\n');
            return gcsResult.publicUrl;
        }

        throw new Error('GCS upload returned no public URL.');
    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const msg = error.message || 'Unknown error';
        console.error(`❌ IMAGE FAILED after ${elapsed}s: ${msg}`);
        throw new Error(`Image Generation Failed: ${msg}`);
    }
};


// -------------------------------------------------------------------
// @route  POST /api/image/generate
// -------------------------------------------------------------------
export const generateImage = async (req, res, next) => {
    try {
        let { prompt, aspectRatio = '1:1', modelId, quality = 'fast' } = req.body || {};

        console.log('\n' + '▓'.repeat(55));
        console.log(`📥 POST /api/image/generate — NEW REQUEST`);
        console.log('▓'.repeat(55));
        console.log(`  • User     : ${req.user?.id || req.user?._id || 'anonymous'}`);
        console.log(`  • Prompt   : "${(prompt || '').substring(0, 70)}"`);
        console.log(`  • ModelId  : ${modelId || 'not specified (will auto-select)'}`);
        console.log(`  • Quality  : ${quality}`);
        console.log(`  • Ratio    : ${aspectRatio}`);
        console.log('▓'.repeat(55));

        if (!prompt) {
            console.warn('  ⚠️  No prompt provided — rejecting request');
            return res.status(400).json({ success: false, message: 'Prompt is required' });
        }

        const isPremium = req.user?.isPremium || false;

        // 1. Resolve optimal model using selector
        const resolvedModelId = selectImageModel(modelId, quality, isPremium);
        console.log(`  🤖 Resolved Model: ${resolvedModelId}`);

        // 2. Execute via Pipeline (Handles enhancement, retries, and fallback)
        console.log(`  ⚡ Handing off to executeImagePipeline...`);
        const pipelineResult = await executeImagePipeline(
            prompt,
            async (finalPrompt, activeModel) => {
                return await generateImageFromPrompt(finalPrompt, null, aspectRatio, activeModel);
            },
            {
                modelId: resolvedModelId,
                enhance: true
            }
        );

        const imageUrl = pipelineResult.url;
        if (!imageUrl) throw new Error('Failed to retrieve image URL.');

        // 3. Generate follow-up suggestions
        console.log(`  💡 Generating follow-up prompts...`);
        const followUpPrompts = await generateFollowUpPrompts(prompt, imageUrl).catch(() => []);

        // 💰 Deduct credits on successful output
        if (req.creditMeta && req.creditMeta.cost > 0) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        console.log(`  ✅ Response sent to client.\n`);
        res.status(200).json({
            success: true,
            data: imageUrl,
            refinedPrompt: pipelineResult.finalPrompt,
            modelUsed: pipelineResult.modelId,
            followUpPrompts
        });
    } catch (error) {
        console.error(`\n❌ [/api/image/generate] FAILED: ${error.message}\n`);
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
