import * as vertexService from './services/vertex.service.js';
import logger from './utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

async function testModel() {
    try {
        console.log("Testing gemini-2.5-flash...");
        const response = await vertexService.AskVertexRaw("What are 3 questions about RAG?", { 
            modelOverride: 'gemini-2.5-flash',
            maxOutputTokens: 100 
        });
        console.log("Response:", response);
    } catch (error) {
        console.error("FAILED with gemini-2.5-flash:", error.message);
        
        console.log("\nTesting gemini-1.5-flash fallback...");
        try {
            const response15 = await vertexService.AskVertexRaw("What are 3 questions about RAG?", { 
                modelOverride: 'gemini-1.5-flash',
                maxOutputTokens: 100 
            });
            console.log("Response 1.5:", response15);
        } catch (err15) {
            console.error("FAILED with gemini-1.5-flash too:", err15.message);
        }
    }
}

testModel();
