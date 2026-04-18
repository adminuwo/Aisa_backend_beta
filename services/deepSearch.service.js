import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const logger = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`)
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

/**
 * Deep Search Service
 * Implements a multi-step research pipeline:
 * 1. Query Planning
 * 2. Multi-Search Execution
 * 3. Content Extraction & Synthesis
 */
export const performDeepSearch = async (query, userLanguage = 'English') => {
    try {
        logger.info(`[DeepSearch] Starting deep research for: "${query}"`);

        if (!TAVILY_API_KEY) {
            logger.error('[DeepSearch] TAVILY_API_KEY is missing!');
            return {
                summary: "Deep Search requires a Tavily API Key. Please configure TAVILY_API_KEY in the environment.",
                sources: []
            };
        }

        // --- STEP 1: QUERY PLANNING ---
        logger.info('[DeepSearch] Step 1: Query Planning');
        const planPrompt = `
        You are a research planner. Given a user query, break it down into 3-5 distinct, specific search queries that will help gather comprehensive information.
        USER QUERY: "${query}"
        
        Respond ONLY with a JSON object containing a key "queries" which is an array of strings.
        Example: {"queries": ["query 1", "query 2", "query 3"]}
        `;

        const planResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: planPrompt }],
            response_format: { type: "json_object" }
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });

        const planContent = planResponse.data.choices[0].message.content;
        logger.info(`[DeepSearch] Planner Response Raw: ${planContent}`);

        let queries = [query]; // Fallback
        try {
            const parsed = JSON.parse(planContent);
            queries = parsed.queries || Object.values(parsed)[0];
            if (!Array.isArray(queries)) {
                logger.warn('[DeepSearch] Planner did not return an array, using root values.');
                queries = Object.values(parsed).filter(v => Array.isArray(v))[0] || [query];
            }
        } catch (e) {
            logger.warn('[DeepSearch] Query planning parsing failed, using original query.');
        }

        logger.info(`[DeepSearch] Final Queries to Execute: ${JSON.stringify(queries)}`);

        // --- STEP 2 & 3: MULTI-SEARCH & EXTRACTION ---
        logger.info('[DeepSearch] Step 2: Executing Multi-Search via Tavily');
        const searchPromises = queries.map(q =>
            axios.post('https://api.tavily.com/search', {
                api_key: TAVILY_API_KEY,
                query: q,
                search_depth: "advanced",
                include_answer: true,
                include_raw_content: true,
                max_results: 3
            }).then(res => {
                logger.info(`[DeepSearch] Tavily Success for "${q}": Found ${res.data.results?.length || 0} results`);
                return res;
            }).catch(err => {
                logger.error(`[DeepSearch] Tavily Search Error for "${q}": ${err.response?.data?.error || err.message}`);
                return { data: { results: [] } };
            })
        );

        const searchResults = await Promise.all(searchPromises);

        let allResults = [];
        let aggregatedContent = "";
        let sources = [];

        searchResults.forEach((res, index) => {
            if (res.data && res.data.results) {
                res.data.results.forEach(item => {
                    allResults.push(item);
                    aggregatedContent += `\n\n--- Source: ${item.title} ---\n${item.raw_content || item.content}`;
                    sources.push({
                        title: item.title,
                        url: item.url,
                        description: item.content
                    });
                });
            } else {
                logger.warn(`[DeepSearch] No data in results for query index ${index}`);
            }
        });

        logger.info(`[DeepSearch] Aggregated Source Count: ${sources.length}`);

        if (sources.length === 0) {
            logger.warn('[DeepSearch] Zero sources found across all queries.');
            return {
                summary: "I'm sorry, my research yielded no results for this query. Please try rephrasing or checking the topic.",
                sources: []
            };
        }

        // Dedup sources by URL
        const uniqueSources = Array.from(new Map(sources.map(s => [s.url, s])).values()).slice(0, 15);
        logger.info(`[DeepSearch] Unique Sources: ${uniqueSources.length}`);

        // Limit context to ~30k tokens (roughly 120k chars)
        const truncatedContent = aggregatedContent.substring(0, 120000);

        const structureTitles = {
            'Hinglish': {
                intro: 'Intro/Puri Summary',
                insights: 'Khaas Baatein',
                facts: 'Zaroori Facts',
                sources: 'Sources/Links'
            },
            'Hindi': {
                intro: 'परिचय और सारांश',
                insights: 'मुख्य बिंदु',
                facts: 'महत्वपूर्ण तथ्य',
                sources: 'स्रोत'
            },
            'English': {
                intro: 'Overview',
                insights: 'Key Insights',
                facts: 'Important Facts',
                sources: 'Sources'
            },
            'Arabic': {
                intro: 'نظرة عامة',
                insights: 'أبرز الأفكار الأساسية',
                facts: 'حقائق هامة',
                sources: 'المصادر'
            }
        };

        const titles = structureTitles[userLanguage] || structureTitles['English'];

        const synthesisPrompt = `
        You are AISA Deep Research Agent. You have been provided with raw data from multiple sources.
        
        USER QUERY: "${query}"
        TARGET LANGUAGE: ${userLanguage}
        
        DATA:
        ${truncatedContent}
        
        Your task is to synthesize this into a structured but natural-sounding response that feels like a conversation with an expert in ${userLanguage}.
        
        ### REQUIRED STRUCTURE (In ${userLanguage}):
        1.  **${titles.intro}**: Summarize the situation naturally in ${userLanguage}.
        2.  **${titles.insights}**: Clear details extracted from the data, written in ${userLanguage}.
        3.  **${titles.facts}**: Precise details, names, stats, written in ${userLanguage}.
        4.  **${titles.sources}**: Bulleted list of URLs.
        
        ### RULES:
        - **Citations**: Cite sources in-text using [1], [2], etc.
        - **TONE (CRITICAL)**: Respond in a natural, empathetic, and human-like conversational tone.
        - **LANGUAGE MATCH (MANDATORY)**: You MUST respond entirely in ${userLanguage}. Even if the source data is English or Hindi, translate EVERYTHING into ${userLanguage} for the user.
        - **NO CODE-SWITCHING**: Do not use languages other than ${userLanguage} for headers or explanations.
        - **NO ENGLISH LABELS**: All headers MUST be in ${userLanguage}.
        `;

        try {
            const finalReport = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o-mini', // Switched to mini for better reliability/speed
                messages: [{ role: 'user', content: synthesisPrompt }],
                temperature: 0.3
            }, {
                headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                timeout: 60000 // Increased to 60s
            });

            logger.info('[DeepSearch] Synthesis Successful.');
            return {
                summary: finalReport.data.choices[0].message.content,
                sources: uniqueSources
            };
        } catch (synthError) {
            logger.error(`[DeepSearch] Synthesis Step Failed: ${synthError.response?.data?.error?.message || synthError.message}`);
            if (synthError.response?.data) console.error("Synthesis Error Detail:", JSON.stringify(synthError.response.data));
            throw synthError;
        }

    } catch (error) {
        logger.error(`[DeepSearch] Critical Research Error: ${error.response?.data?.error?.message || error.message}`);
        return {
            summary: "I encountered a problem performing a Deep Search research phase. This could be due to a service timeout or API credit limits. Please try again with a more specific query.",
            sources: []
        };
    }
};
