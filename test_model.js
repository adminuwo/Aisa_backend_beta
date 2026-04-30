import * as vertexService from './services/vertex.service.js';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
    try {
        console.log("Testing gemini-2.5-flash...");
        const response = await vertexService.AskVertexRaw("Hello", { modelOverride: 'gemini-2.5-flash' });
        console.log("Response:", response);
    } catch (err) {
        console.error("Error Message:", err.message);
        if (err.response) {
            console.error("Error Response Data:", JSON.stringify(err.response.data, null, 2));
        }
    }
}

test();
