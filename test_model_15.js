import * as vertexService from './services/vertex.service.js';
import logger from './utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

async function testModel() {
    console.log("--- START TEST ---");
    try {
        console.log("Testing gemini-1.5-flash...");
        const response = await vertexService.AskVertexRaw("Write 'HELLO WORLD' in uppercase.", { 
            modelOverride: 'gemini-1.5-flash',
            maxOutputTokens: 100 
        });
        console.log("SUCCESS! Response:", response);
    } catch (error) {
        console.error("FAILED with gemini-1.5-flash:", error.message);
    }
    console.log("--- END TEST ---");
}

testModel();
