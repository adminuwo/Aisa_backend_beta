import logger from '../utils/logger.js';
import axios from 'axios';
import dotenv from 'dotenv';
import * as configService from './configService.js';
import { performWebSearch } from './searchService.js';
import { askVertex } from '../services/vertex.service.js';

dotenv.config();

/**
 * Detects if a query requires real-time information.
 * Uses a small model to save costs.
 */
export const shouldSearch = async (query) => {
    try {
        const lower = query.toLowerCase();
        
        // Fast-pass: Check for common real-time keywords to skip AI detection and save time
        const searchKeywords = [
            'today', 'match', 'score', 'weather', 'price', 'news', 'latest', 'live', 
            'stock', 'cricket', 'ipl', 'football', 'result', 'upcoming'
        ];
        
        if (searchKeywords.some(keyword => lower.includes(keyword))) {
            logger.info(`[WebSearch] Fast-pass YES for: "${query}"`);
            return true;
        }

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return false;

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `You are a real-time information detector. 
                        Today is ${new Date().toDateString()}.
                        Analyze if the query requires up-to-date, live, or real-time information.
                        Respond ONLY "YES" or "NO".`
                    },
                    { role: 'user', content: query }
                ],
                max_tokens: 5,
                temperature: 0
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const decision = response.data.choices[0].message.content.trim().toUpperCase();
        return decision === 'YES';
    } catch (error) {
        logger.error(`[WebSearch] Detection Error: ${error.message}`);
        return false;
    }
};

/**
 * Performs search using OpenAI GPT-4o Search Preview.
 * This model inherently does the search and returns a grounded response.
 */
export const performSearch = async (query, userLanguage = 'English') => {
    try {
        logger.info(`[WebSearch] Calling OpenAI Search for query: "${query}"`);

        const currentDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
        const targetLang = userLanguage === 'Hinglish' ? 'Hinglish (Romanized Hindi)' : userLanguage;

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            logger.error('[WebSearch] OPENAI_API_KEY is missing!');
            return null;
        }

        const modelName = 'gpt-4o-search-preview';
        logger.info(`[WebSearch] Calling OpenAI with model: ${modelName}`);

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: modelName,
                messages: [
                    {
                        role: 'system',
                        content: configService.getConfig('WEB_SEARCH_RULES') + `
                        TODAY'S DATE: ${currentDate}
                        LANGUAGE: ${targetLang}
                        MANDATORY RULE: You MUST match the EXACT script and tongue used by the user. If the user asks in ${targetLang}, you MUST respond 100% in ${targetLang}.`
                    },
                    { role: 'user', content: query }
                ]
                // Note: No 'tools' parameter needed for gpt-4o-search-preview as it's built-in
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 90000 // 90s timeout for search
            }
        );

        if (response.data && response.data.choices && response.data.choices[0]) {
            const message = response.data.choices[0].message;
            const content = message.content;

            // Extract sources from citations or sources field
            let sources = [];
            const rawSources = message.sources || message.citations;

            if (rawSources && Array.isArray(rawSources)) {
                sources = rawSources.map(c => ({
                    title: c.title || "Source",
                    url: c.url,
                    description: c.snippet || c.description || ""
                }));
            }

            return {
                summary: content,
                sources: sources
            };
        }

        throw new Error('No response from search-preview model');

    } catch (error) {
        logger.error(`[WebSearch] Primary Search Failed: ${error.response?.data?.error?.message || error.message}`);

        // --- FALLBACK MECHANISM ---
        try {
            logger.info(`[WebSearch] Attempting fallback search for: "${query}"`);
            const searchData = await performWebSearch(query, 5);

            if (!searchData || !searchData.results || searchData.results.length === 0) {
                logger.warn('[WebSearch] Fallback search also yielded no results.');
                return null;
            }

            const formattedSources = searchData.results.map(r => ({
                title: r.title,
                url: r.link,
                description: r.snippet
            }));

            const snippetsText = searchData.results.map((r, i) => `${i + 1}. [${r.title}] ${r.snippet} (Source: ${r.link})`).join('\n\n');

            const systemPrompt = configService.getConfig('WEB_SEARCH_RULES') + `
            TODAY'S DATE: ${new Date().toDateString()}
            
            Below are search results for the query: "${query}"
            ${snippetsText}
            
            Task: Using ONLY the data above, provide a clear and concise answer in ${userLanguage}. Keep it helpful and direct.`;

            // Use Gemini for summarization via askVertex
            const summary = await askVertex(query, null, {
                systemInstruction: systemPrompt
            });

            return {
                summary: summary,
                sources: formattedSources
            };
        } catch (fallbackError) {
            logger.error(`[WebSearch] Fallback Search also failed: ${fallbackError.message}`);
            return null;
        }
    }
};

/**
 * Compatibility wrapper for existing ai.service.js calls.
 */
export const summarizeResults = async (query, searchResponse) => {
    if (searchResponse && searchResponse.summary) {
        return searchResponse;
    }
    return { summary: "Live search results could not be summarized.", sources: [] };
};
