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
            'stock', 'cricket', 'ipl', 'football', 'result', 'upcoming', 'current'
        ];
        
        if (searchKeywords.some(keyword => lower.includes(keyword))) {
            logger.info(`[WebSearch] Fast-pass YES for: "${query}"`);
            return true;
        }

        // Use Gemini 1.5 Flash (faster than GPT-4o-mini for detection)
        const systemPrompt = `You are a real-time information detector. 
        Today is ${new Date().toDateString()}.
        Analyze if the query requires up-to-date, live, or real-time information.
        Respond ONLY "YES" or "NO".`;

        const decision = await askVertex(query, null, {
            systemInstruction: systemPrompt,
            modelOverride: 'gemini-2.5-flash',
            maxOutputTokens: 10,
            temperature: 0
        });

        return decision.trim().toUpperCase() === 'YES';
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
        logger.info(`[WebSearch] Level 1: super-fast Gemini search for: "${query}"`);
        const targetLang = userLanguage === 'Hinglish' ? 'Hinglish (Romanized Hindi)' : userLanguage;
        
        const systemPrompt = configService.getConfig('WEB_SEARCH_RULES') + `
        LANGUAGE: ${targetLang}
        MANDATORY: Respond strictly in ${targetLang}. Match user script/tone.`;

        // 1. Primary Engine: Gemini 1.5 Flash + Google Search Grounding
        const result = await askVertex(query, null, {
            systemInstruction: systemPrompt,
            useSearch: true,
            returnSources: true,
            modelOverride: 'gemini-2.5-flash'
        });

        if (result && result.text) {
            return { summary: result.text, sources: result.sources || [] };
        }
    } catch (e) {
        logger.warn(`[WebSearch] Gemini Search failed, falling back... ${e.message}`);
    }

    // --- FALLBACK 1: OpenAI Search Preview ---
    try {
        logger.info('[WebSearch] Level 2: OpenAI Search Preview fallback...');
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o-search-preview',
                messages: [{ role: 'user', content: query }]
            }, { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 45000 });

            if (response.data?.choices?.[0]?.message?.content) {
                const msg = response.data.choices[0].message;
                return {
                    summary: msg.content,
                    sources: (msg.sources || []).map(s => ({ title: s.title, url: s.url }))
                };
            }
        }
    } catch (e) {
        logger.warn(`[WebSearch] OpenAI Search failed: ${e.message}`);
    }

    // --- FALLBACK 2: Manual Web Search + Gemini Summarization ---
    try {
        logger.info('[WebSearch] Level 3: Manual search + AI summary fallback...');
        const searchData = await performWebSearch(query, 5);
        if (!searchData || !searchData.results || searchData.results.length === 0) return null;

        const snippets = searchData.results.map((r, i) => `${i+1}. [${r.title}] ${r.snippet} (${r.link})`).join('\n\n');
        const summary = await askVertex(`Answer "${query}" based on:\n${snippets}`, null, {
            systemInstruction: `Explain in ${userLanguage}. Be direct.`
        });

        return {
            summary: summary,
            sources: searchData.results.map(r => ({ title: r.title, url: r.link }))
        };
    } catch (e) {
        logger.error(`[WebSearch] All search levels failed: ${e.message}`);
        return null;
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
