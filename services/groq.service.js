import axios from 'axios';
import logger from '../utils/logger.js';
import { AISA_CONVERSATIONAL_RULES, BRAND_SYSTEM_RULES } from '../utils/brandIdentity.js';

class GroqService {
    constructor() {
        this.apiKey = process.env.GROQ_API_KEY;
        this.baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
    }

    async askGroq(prompt, context = null, options = {}) {
        // Enhanced API key validation
        if (!this.apiKey) {
            logger.error("GROQ_API_KEY is not set in environment variables");
            throw new Error("Groq API Key is missing");
        }

        logger.info(`[GROQ] API Key present: YES (length: ${this.apiKey.length})`);
        logger.info(`[GROQ] Prompt length: ${prompt.length}, Has context: ${!!context}`);

        const messages = [];

        // Hybrid System Prompt
        let systemPrompt = options.systemInstruction || `${AISA_CONVERSATIONAL_RULES}
${BRAND_SYSTEM_RULES}

### CONTEXTUAL INSTRUCTIONS:
1. Analyze the provided CONTEXT.
2. If the Context starts with "SOURCE: COMPANY KNOWLEDGE BASE":
   - Answer the question using this company context.
3. If the Context contains text but NO special header (meaning it's a User Upload):
   - Answer the question using this user context.
4. If NO Context is provided (or it's empty):
   - Answer using general knowledge.`;

        if (options.userName) {
            systemPrompt += `\n\n### USER IDENTIFICATION:\nThe user's name is ${options.userName}. You MUST use their name to address them directly and naturally in your responses (e.g., "Yes, Sakshi", or "Here is the information, ${options.userName}"). Make the conversation feel personalized by acknowledging their name.\n`;
        }

        messages.push({
            role: "system",
            content: systemPrompt
        });

        // Add Context if available
        if (context) {
            messages.push({
                role: "system",
                content: `CONTEXT:\n${context}`
            });
        }

        messages.push({
            role: "user",
            content: prompt
        });

        try {
            logger.info(`[GROQ] Sending request to Groq API...`);
            const response = await axios.post(this.baseUrl, {
                model: "llama-3.1-8b-instant",
                messages: messages,
                temperature: 0.3,
                max_tokens: 1024
            }, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            });

            if (response.data && response.data.choices && response.data.choices.length > 0) {
                const aiResponse = response.data.choices[0].message.content;
                logger.info(`[GROQ] Response received successfully (${aiResponse.length} chars)`);
                return aiResponse;
            } else {
                logger.error(`[GROQ] Invalid response format: ${JSON.stringify(response.data)}`);
                throw new Error("Invalid response format from Groq");
            }

        } catch (error) {
            logger.error(`[GROQ] API Error: ${error.message}`);
            logger.error(`[GROQ] Error stack: ${error.stack}`);

            if (error.response) {
                logger.error(`[GROQ] Response status: ${error.response.status}`);
                logger.error(`[GROQ] Response data: ${JSON.stringify(error.response.data)}`);
            }

            if (error.code === 'ECONNABORTED') {
                logger.error(`[GROQ] Request timeout after 30s`);
            }

            throw new Error(`Groq API failed: ${error.message}`);
        }
    }
}

export default new GroqService();
