import axios from 'axios';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';
import * as configService from './configService.js';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export const askOpenAI = async (prompt, context = null, options = {}) => {
    try {
        if (!OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY is missing in environment variables.");
        }

        const { systemInstruction, userName } = options;

        let messages = [];

        // 1. Add System Instruction if provided
        const currentDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const dateContext = `\n### CURRENT DATE & TIME:\nToday is ${currentDate} (India Standard Time). (Aaj ki date aur samay: ${currentDate})\n`;

        if (systemInstruction) {
            messages.push({ role: 'system', content: systemInstruction + dateContext });
        } else {
            messages.push({
                role: 'system',
                content: configService.getFullSystemInstruction() + dateContext + `
### PERSONALIZATION:
Understand the user's expertise level and topic preference implicitly from their messages. Adjust your language to be slightly more technical or simple as needed, while maintaining the primary goal of being direct and professional.
`
            });
        }




        // 2. Add Context if provided
        let finalPrompt = prompt;
        if (context) {
            finalPrompt = `CONTEXT:\n${context}\n\nUSER QUESTION:\n${prompt}`;
        }

        const userContent = [{ type: 'text', text: finalPrompt }];
        
        // Handle image input for Vision capabilities
        const imageToUse = options.image || options.imageUrl;
        if (imageToUse) {
            let finalImageUrl = imageToUse;
            // If it's a raw base64 string (no prefix), add it
            if (typeof imageToUse === 'string' && !imageToUse.startsWith('http') && !imageToUse.startsWith('data:')) {
                finalImageUrl = `data:image/png;base64,${imageToUse}`;
            }
            userContent.push({
                type: 'image_url',
                image_url: { url: finalImageUrl }
            });
        }

        messages.push({ role: 'user', content: userContent });

        logger.info(`[OPENAI] Sending text request to GPT-4o-mini...`);

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: options.model || 'gpt-4o-mini',
                messages: messages,
                max_tokens: options.max_tokens || 4096,
                temperature: options.temperature || 0.7,
                response_format: options.jsonMode ? { type: 'json_object' } : undefined
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000 // 60s timeout
            }
        );

        if (response.data && response.data.choices && response.data.choices[0]) {
            const text = response.data.choices[0].message.content;
            logger.info(`[OPENAI] Response received successfully (${text.length} chars).`);
            return text;
        }

        throw new Error('OpenAI did not return valid response data.');

    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        logger.error(`[OPENAI] Error: ${errorMsg}`);
        throw new Error(`OpenAI request failed: ${errorMsg}`);
    }
};

export const AskOpenAIRaw = askOpenAI;

