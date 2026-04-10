import { uploadToGCS, gcsFilename } from '../services/gcs.service.js';
import axios from 'axios';
import logger from '../utils/logger.js';
import { GoogleAuth } from 'google-auth-library';
import { GoogleGenAI, Modality } from '@google/genai';
import { refineAdvancedEditPrompt, generateFollowUpPrompts } from '../utils/imagePromptController.js';
import { getConfig } from '../services/configService.js';
import { subscriptionService } from '../services/subscriptionService.js';
import { selectImageModel } from '../services/modelSelector.js';
import { executeImagePipeline } from '../services/generationPipeline.js';

// ------------------------------------------------------------------
// @google/genai SDK client (Vertex AI mode)
// Used for gemini-2.5-flash-image edits via the official GenAI SDK
// ------------------------------------------------------------------
const getGenAIClient = () => new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID,
    location: process.env.GCP_LOCATION || 'us-central1',
});

// -------------------------------------------------------------------
// Smart editMode detection for imagen-3.0-capability-001
// Supported modes: bgremoval, product-image, outpainting,
//                  inpainting-insert, inpainting-remove
// -------------------------------------------------------------------
const detectEditMode = (prompt) => {
    const lower = prompt.toLowerCase();

    if (/remove\s+background|background\s+remove|bg\s+remove|remove\s+bg|transparent\s+background|background\s+hatao|bg\s+hatao/.test(lower)) {
        return 'bgremoval';
    }
    if (/product|white\s+background|studio\s+shot|clean\s+background/.test(lower)) {
        return 'product-image';
    }
    if (/expand|extend|outpaint|wider|larger|zoom\s+out/.test(lower)) {
        return 'outpainting';
    }
    if (/remove|delete|erase|hata\s+do|hata|mitao/.test(lower)) {
        return 'inpainting-remove';
    }
    // Default: add / modify something in the image
    return 'inpainting-insert';
};

// -------------------------------------------------------------------
// Core Vertex AI helper — used by both chat and API endpoints
// -------------------------------------------------------------------
export const generateImageFromPrompt = async (prompt, originalImage = null, aspectRatio = '1:1', selectedModelId = 'imagen-3.0-generate-001', manualEditMode = null) => {
    try {
        console.log(`[VERTEX IMAGE] Triggered for: "${prompt}" (Edit: ${!!originalImage}, Ratio: ${aspectRatio})`);

        if (!process.env.GCP_PROJECT_ID) {
            console.warn('[VERTEX IMAGE] Missing GCP_PROJECT_ID');
            throw new Error('Missing GCP_PROJECT_ID');
        }

        // Auth: uses ADC (gcloud auth application-default login) or
        //       GOOGLE_APPLICATION_CREDENTIALS if explicitly set
        const auth = new GoogleAuth({
            scopes: 'https://www.googleapis.com/auth/cloud-platform',
            projectId: process.env.GCP_PROJECT_ID
        });

        const client = await auth.getClient();
        const projectId = await auth.getProjectId();
        const { token } = await client.getAccessToken();
        const location = 'us-central1';
        // -------------------------------------------------------
        // callGeminiSDK — uses @google/genai SDK (gemini-2.5-flash-image)
        // -------------------------------------------------------
        const callGeminiSDK = async (modelId) => {
            console.log(`[GENAI SDK] Calling ${modelId} via @google/genai SDK...`);

            const defaultInst = `You are an advanced AI image editor. The user has uploaded a reference image and provided specific transformation instructions.

YOUR TASK:
- Carefully follow ALL of the user's instructions to transform, stylize, or modify the image.
- You MUST generate a new image that matches the user's described scene while using the uploaded image as a "face/identity reference" for the subject.
- Apply the requested style, outfit, background, pose, and composition described in the prompt.
- PRESERVE the person's face and likeness from the reference image but apply everything else as instructed.
- If the user requests a completely new background or scene, generate it as described.
- TEXT ACCURACY: render any text CHARACTER-BY-CHARACTER.
- Output a high-quality, photorealistic result unless a specific style is requested.

IMPORTANT: DO NOT just return the original image unchanged. You MUST apply the transformation.`;

            const systemInstruction = getConfig('IMAGE_EDIT_INSTRUCTIONS', defaultInst);
            const editPrompt = originalImage
                ? `${systemInstruction}\n\n=== USER TRANSFORMATION REQUEST ===\n${prompt}\n\nNow generate the transformed image based on the instructions above and the reference image provided.`
                : prompt;

            // Build content parts
            const parts = [];

            // Attach source image if editing
            if (originalImage) {
                let base64Data = typeof originalImage === 'string'
                    ? originalImage
                    : (originalImage.base64Data || originalImage.image || originalImage.data);

                if (typeof base64Data === 'string' && base64Data.includes('base64,')) {
                    base64Data = base64Data.split('base64,')[1];
                }

                parts.push({
                    inlineData: {
                        mimeType: 'image/png',
                        data: base64Data,
                    },
                });
            }

            // Add text instruction after image
            parts.push({ text: editPrompt });

            const genaiClient = getGenAIClient();
            const sdkResponse = await genaiClient.models.generateContent({
                model: modelId,
                contents: [{ role: 'user', parts }],
                config: {
                    responseModalities: [Modality.TEXT, Modality.IMAGE],
                },
            });

            return sdkResponse;
        };

        // -------------------------------------------------------
        // callVertex — used for Imagen models (non-Gemini) via REST
        // -------------------------------------------------------
        const callVertex = async (modelId) => {
            const method = 'predict';
            const endpoint =
                `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
                `/locations/${location}/publishers/google/models/${modelId}:${method}`;

            console.log(`[VERTEX] Calling ${modelId} (Imagen) via REST predict...`);

            let instanceStruct = { prompt };
            let paramStruct = {
                sampleCount: 1,
                guidanceScale: originalImage ? 100.0 : 25.0,
                personGeneration: 'allow_all',
                negativePrompt: "misspelled text, garbled letters, overlapping characters, blurry text, extra characters"
            };

            if (originalImage) {
                let base64Data = typeof originalImage === 'string'
                    ? originalImage
                    : (originalImage.base64Data || originalImage.image || originalImage.data);

                if (typeof base64Data === 'string' && base64Data.includes('base64,')) {
                    base64Data = base64Data.split('base64,')[1];
                }

                const rawEditMode = manualEditMode || detectEditMode(prompt);
                instanceStruct.referenceImages = [
                    {
                        referenceType: 'REFERENCE_TYPE_RAW',
                        referenceId: 1,
                        referenceImage: { bytesBase64Encoded: base64Data }
                    }
                ];
                paramStruct.editConfig = { editMode: rawEditMode };
            } else {
                let vertexRatio = '1:1';
                if (aspectRatio === '16:9') vertexRatio = '16:9';
                else if (aspectRatio === '4:5') vertexRatio = '3:4';
                else if (aspectRatio === '4:7') vertexRatio = '9:16';
                paramStruct.aspectRatio = vertexRatio;
            }

            return axios.post(
                endpoint,
                { instances: [instanceStruct], parameters: paramStruct },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 60000 }
            );
        };

        // -------------------------------------------------------
        // Model Routing:
        //  - Editing  → PRIMARY: gemini-2.5-flash-image (via @google/genai SDK)
        //               FALLBACK: imagen-3.0-capability-001 (REST, for precise inpainting)
        //  - Generation → use selectedModelId (Imagen REST)
        // -------------------------------------------------------
        const GEMINI_EDIT_MODEL  = 'gemini-1.5-pro';
        const IMAGEN_FALLBACK     = 'imagen-3.0-capability-001';
        const IMAGEN_GEN_FALLBACK = selectedModelId === 'imagen-4.0-ultra-generate-001'
            ? 'imagen-3.0-generate-001'
            : 'imagen-3.0-generate-002';

        let base64Data = null;
        let usedModel;

        if (originalImage) {
            // ---- Path A: Image EDITING via Gemini SDK ----
            usedModel = GEMINI_EDIT_MODEL;
            try {
                console.log(`[GENAI SDK] Using ${GEMINI_EDIT_MODEL} for image edit...`);
                const sdkResponse = await callGeminiSDK(GEMINI_EDIT_MODEL);
                const candidateParts = sdkResponse?.candidates?.[0]?.content?.parts || [];
                const imagePart = candidateParts.find(
                    p => p.inlineData && (p.inlineData.mimeType?.startsWith('image/') || p.inlineData.data)
                );
                if (imagePart) {
                    base64Data = imagePart.inlineData.data;
                }
                if (!base64Data) {
                    console.warn(`[GENAI SDK] ${GEMINI_EDIT_MODEL} returned no image part — falling back to Imagen.`);
                }
            } catch (sdkErr) {
                console.warn(`[GENAI SDK] ${GEMINI_EDIT_MODEL} failed: ${sdkErr.message} — falling back to Imagen.`);
            }

            // ---- Fallback: Imagen inpainting (REST) ----
            if (!base64Data) {
                usedModel = IMAGEN_FALLBACK;
                console.log(`[VERTEX] Falling back to ${IMAGEN_FALLBACK} for image edit...`);
                const fallbackResponse = await callVertex(IMAGEN_FALLBACK);
                console.log(`[VERTEX RESPONSE] HTTP ${fallbackResponse.status} from ${usedModel}`);
                const prediction = fallbackResponse.data?.predictions?.[0];
                base64Data = prediction?.bytesBase64Encoded || (typeof prediction === 'string' ? prediction : null);
            }
        } else {
            // ---- Path B: Image GENERATION via Imagen REST ----
            usedModel = selectedModelId;
            const genFallback = IMAGEN_GEN_FALLBACK;
            let genResponse;
            try {
                genResponse = await callVertex(selectedModelId);
            } catch (genErr) {
                console.warn(`[VERTEX] ${selectedModelId} failed: ${genErr.message} — trying ${genFallback}`);
                usedModel = genFallback;
                genResponse = await callVertex(genFallback);
            }
            console.log(`[VERTEX RESPONSE] HTTP ${genResponse.status} from ${usedModel}`);
            const prediction = genResponse.data?.predictions?.[0];
            base64Data = prediction?.bytesBase64Encoded || (typeof prediction === 'string' ? prediction : null);
        }

        if (base64Data) {
            console.log(`[GCS] Uploading result from ${usedModel}...`);
            const buffer = Buffer.from(base64Data, 'base64');
            const gcsResult = await uploadToGCS(buffer, {
                folder: 'generated_images',
                filename: gcsFilename(`aisa_${originalImage ? 'edit' : 'gen'}`),
                mimeType: 'image/png',
                isPublic: false,
                useSignedUrl: true,
            });

            if (gcsResult?.publicUrl) {
                console.log(`[IMAGE SUCCESS] ${gcsResult.publicUrl}`);
                return gcsResult.publicUrl;
            }
        }

        throw new Error(`Image pipeline (${usedModel}) returned no image data.`);

    } catch (error) {
        const errorMsg = error.message || 'Unknown error';
        const vertexMsg = error.response?.data?.error?.message || errorMsg;

        if (originalImage) {
            console.error(`[VERTEX EDIT FAILED] ${vertexMsg}`);
            throw new Error(`Image modification failed: ${vertexMsg}`);
        }

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

// -------------------------------------------------------------------
// @route  POST /api/image/edit
// -------------------------------------------------------------------
export const editImage = async (req, res, next) => {
    try {
        const { prompt, imageUrl, imageBase64, modelId = 'imagen-3.0-generate-001', aspectRatio = '1:1' } = req.body || {};

        if (!prompt) {
            return res.status(400).json({ success: false, message: 'Editing prompt is required' });
        }
        if (!imageUrl && !imageBase64) {
            return res.status(400).json({ success: false, message: 'Image (URL or Base64) is required for editing' });
        }

        console.log(`[Image Editing] Processing raw request: "${prompt}"`);

        let imageToProcess = imageBase64;

        if (imageUrl && !imageToProcess) {
            if (imageUrl.startsWith('data:')) {
                imageToProcess = imageUrl.split(',')[1];
            } else {
                try {
                    const resp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                    imageToProcess = Buffer.from(resp.data).toString('base64');
                } catch (err) {
                    throw new Error(`Failed to fetch source image: ${err.message}`);
                }
            }
        }

        if (!imageToProcess) {
            return res.status(400).json({ success: false, message: 'Valid image data required' });
        }

        // Refine the edit request using the Advanced Editing Controller (WITH VISION)
        const { prompt: refined, config } = await refineAdvancedEditPrompt(prompt, imageUrl, imageToProcess);
        
        // Final fallback: Ensure the prompt is NEVER empty
        const finalPrompt = (refined && refined.trim()) ? refined : prompt;

        // If the controller suggested a specific edit mode, we can use it
        const suggestedEditMode = config?.edit_mode || (config?.mode === 'edit' ? 'inpainting-insert' : null);

        console.log(`[Image Editing] Refined Title: "${finalPrompt.substring(0, 100)}..." (Suggested Mode: ${suggestedEditMode})`);

        const modifiedImageUrl = await generateImageFromPrompt(finalPrompt, imageToProcess, aspectRatio, modelId, suggestedEditMode);
        if (!modifiedImageUrl) throw new Error('Failed to retrieve modified image URL.');

        // Generate follow-up suggestions based on BOTH the edit prompt and the modified image
        const followUpPrompts = await generateFollowUpPrompts(finalPrompt, modifiedImageUrl).catch(() => []);

        // 💰 Deduct credits on successful output
        if (req.creditMeta && req.creditMeta.cost > 0) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.status(200).json({ success: true, data: modifiedImageUrl, followUpPrompts });
    } catch (error) {
        console.error(`[Image Editing] Error: ${error.message}`);
        res.status(500).json({ success: false, message: `Image editing failed: ${error.message}` });
    }
};
