import express from 'express';
import multer from 'multer';
import { verifyToken } from '../middleware/authorization.js';
import { creditMiddleware } from '../middleware/creditSystem.js';
import { subscriptionService } from '../services/subscriptionService.js';
import { GoogleGenAI, Modality } from '@google/genai';
import { uploadToGCS, gcsFilename } from '../services/gcs.service.js';
import { refineAdvancedEditPrompt } from '../utils/imagePromptController.js';
const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            return cb(new Error('Invalid file type. Only JPG, PNG, and WEBP are allowed.'), false);
        }
        cb(null, true);
    }
});

router.post('/', verifyToken, upload.single('image'), creditMiddleware, async (req, res) => {
    try {
        const { prompt } = req.body;
        const file = req.file;

        if (!prompt) {
            return res.status(400).json({ success: false, message: 'Prompt is required' });
        }
        if (!file) {
            return res.status(400).json({ success: false, message: 'Image file is required' });
        }

        console.log(`[Magic Image Edit] Processing: "${prompt}"`);

        const client = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
            location: 'us-central1', // Force us-central1 because preview models aren't available in asia-south1
        });

        const imageBase64 = file.buffer.toString('base64');
        const { prompt: refinedPrompt } = await refineAdvancedEditPrompt(prompt, "", imageBase64);
        const finalContentPrompt = refinedPrompt || prompt;

        const systemInstruction = `You are a professional Creative Image Transformation engine.
You are given a reference image and a USER TRANSFORMATION REQUEST.

YOUR CORE TASK:
1. "Anchor on Identity": Identify the primary person/subject in the reference image.
2. "Total Scene Reconstruction": If the user request implies a new setting, outfit, or action (like riding a horse or being in a forest), you MUST REGENERATE the entire scene from scratch.
3. "Identity Transfer": Transfer the EXACT facial features, hairstyle, and identity from the reference image onto the subject in the new generated scene.
4. "Discard Original Context": Completely ignore the original background, clothing, and pose of the reference image if they conflict with the request.

=== USER TRANSFORMATION REQUEST ===
${finalContentPrompt}

CRITICAL: DO NOT JUST MODIFY THE ORIGINAL IMAGE. Create a cinematic, 8k, photorealistic masterpiece that places the person from the reference into the requested scene. If they should be on a horse, they MUST be on a horse. If they should be in a forest, the background MUST be a majestic forest.`;

        const response = await client.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType: file.mimetype,
                                data: imageBase64,
                            },
                        },
                        { 
                            text: systemInstruction 
                        },
                    ],
                },
            ],
            config: {
                responseModalities: [Modality.TEXT, Modality.IMAGE],
            },
        });

        let modifiedImageUrl = null;
        let responseText = null;

        const candidates = response.candidates || [];
        if (candidates.length > 0 && candidates[0].content && candidates[0].content.parts) {
            for (const part of candidates[0].content.parts) {
                if (part.text) {
                    console.log(`[Magic Image Edit] AI Says: ${part.text}`);
                    responseText = part.text;
                } else if (part.inlineData && part.inlineData.data) {
                    const imageBytes = Buffer.from(part.inlineData.data, 'base64');
                    const gcsResult = await uploadToGCS(imageBytes, {
                        folder: 'generated_images',
                        filename: gcsFilename('aisa_magic_edit'),
                        mimeType: part.inlineData.mimeType || 'image/png',
                        isPublic: false,
                        useSignedUrl: true,
                    });

                    if (gcsResult?.publicUrl) {
                        modifiedImageUrl = gcsResult.publicUrl;
                        console.log(`[IMAGE SUCCESS] ${modifiedImageUrl}`);
                    }
                }
            }
        }

        if (!modifiedImageUrl) {
            throw new Error("Failed to retrieve modified image URL from GenAI response.");
        }

        // 💰 Deduct credits on successful output
        if (req.creditMeta && req.creditMeta.cost > 0) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.status(200).json({
            success: true,
            data: modifiedImageUrl,
            message: responseText || "Image successfully edited."
        });

    } catch (error) {
        console.error(`[Magic Image Edit] Critical Error: ${error.message}`);
        res.status(500).json({
            success: false,
            message: `Image editing failed: ${error.message}`
        });
    }
});

export default router;
