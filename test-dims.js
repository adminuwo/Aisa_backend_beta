import dotenv from 'dotenv';
import { GoogleGenAI, Modality } from '@google/genai';
import fs from 'fs';
import sizeOf from 'image-size';

dotenv.config();

async function testDims() {
    try {
        const client = new GoogleGenAI({
            vertexai: true,
            project: process.env.GCP_PROJECT_ID,
            location: 'global'
        });

        // Try 9:16 aspect ratio
        const config = {
            responseModalities: [Modality.TEXT, Modality.IMAGE],
            imageConfig: {
                aspectRatio: '9:16'
            }
        };

        console.log("Generating with config:", config);

        const response = await client.models.generateContentStream({
            model: 'gemini-3-pro-image-preview',
            contents: "A simple red square",
            config
        });

        let base64Data = null;
        for await (const chunk of response) {
            if (chunk.data) {
                base64Data = Buffer.from(chunk.data).toString('base64');
            }
            const parts = chunk.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
                if (part.inlineData?.data) {
                    base64Data = part.inlineData.data;
                }
            }
        }

        if (base64Data) {
            const buffer = Buffer.from(base64Data, 'base64');
            fs.writeFileSync('temp-test.png', buffer);
            const dimensions = sizeOf('temp-test.png');
            console.log(`Generated image dimensions: ${dimensions.width}x${dimensions.height}`);
            console.log(`Measured Ratio W:H = ${dimensions.width / dimensions.height}`);
        }

    } catch (e) {
        console.error("Test Failed:", e);
    }
}

testDims();
