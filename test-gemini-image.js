import { GoogleGenAI, Modality } from '@google/genai';
import fs from 'fs';

const client = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID || 'ai-mall-484810',
    location: 'global',
});

async function main() {
    console.log('Sending request to gemini-3.1-flash-image-preview...');
    const response = await client.models.generateContentStream({
        model: 'gemini-3.1-flash-image-preview',
        contents: 'generate image of the super hero who ware black suit with black dog',
        config: {
            responseModalities: [Modality.TEXT, Modality.IMAGE],
            personGeneration: 'ALLOW_ALL'
        },
    });

    let count = 0;
    for await (const chunk of response) {
        if (chunk.text) console.log('TEXT:', chunk.text);
        if (chunk.data) {
            console.log('IMAGE DATA chunk received, size:', chunk.data.length);
            fs.writeFileSync(`test-output-${count++}.png`, chunk.data);
        }
    }
    console.log('Done.');
}
main().catch(console.error);
