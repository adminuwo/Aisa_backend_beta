import dotenv from 'dotenv';
import { generateImageFromPrompt } from './controllers/image.controller.js';

dotenv.config();

async function testAspectRatio() {
    try {
        console.log("Testing 9:16 aspect ratio generation...");
        // We will mock the GCS upload, so let's temporarily mock it by requiring the gcs service or just calling generateWithGeminiSDK but `generateImageFromPrompt` uploads to GCS natively.
        const url = await generateImageFromPrompt("A futuristic cityscape at night", null, "9:16", "gemini-3.1-flash-image-preview");
        console.log("Success! Image URL:", url);
    } catch (e) {
        console.error("Test Failed:", e.message);
    }
}

testAspectRatio();
