import dotenv from 'dotenv';
import { generateImageFromPrompt } from './controllers/image.controller.js';

dotenv.config();

async function testAspectRatio() {
    try {
        console.log("Testing 9:16 aspect ratio generation with gemini-3-pro-image-preview...");
        const url = await generateImageFromPrompt("Otter, raccoon dog, butterfly in sunlit forest", null, "9:16", "gemini-3-pro-image-preview");
        console.log("Success! Image URL:", url);
    } catch (e) {
        console.error("Test Failed:", e.message);
    }
}

testAspectRatio();
