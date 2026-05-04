import axios from 'axios';
import dotenv from 'dotenv';
import { AskVertexRaw } from './vertex.service.js';

dotenv.config();

// ─── ANSI color codes ────────────────────────────────────────────────────────
const C = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    cyan:    '\x1b[36m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    red:     '\x1b[31m',
    magenta: '\x1b[35m',
    blue:    '\x1b[34m',
    white:   '\x1b[37m',
    bgBlue:  '\x1b[44m',
    bgGreen: '\x1b[42m',
    bgRed:   '\x1b[41m',
};

// Timestamp helper
const ts = () => {
    const now = new Date();
    return `${C.dim}${now.toTimeString().split(' ')[0]}.${String(now.getMilliseconds()).padStart(3, '0')}${C.reset}`;
};

// ─── Deep Search Logger ───────────────────────────────────────────────────────
const ds = {
    banner: (text) => {
        const line = '═'.repeat(60);
        console.log(`\n${C.cyan}${C.bold}${line}${C.reset}`);
        console.log(`${C.cyan}${C.bold}  🔍 ${text}${C.reset}`);
        console.log(`${C.cyan}${C.bold}${line}${C.reset}`);
    },
    step: (num, label) => {
        console.log(`\n${C.blue}${C.bold}  ┌─ STEP ${num}: ${label}${C.reset}`);
    },
    info: (msg) => {
        console.log(`${ts()} ${C.cyan}[DeepSearch]${C.reset} ${msg}`);
    },
    ok: (msg) => {
        console.log(`${ts()} ${C.green}[DeepSearch] ✓${C.reset} ${msg}`);
    },
    warn: (msg) => {
        console.warn(`${ts()} ${C.yellow}[DeepSearch] ⚠${C.reset}  ${msg}`);
    },
    error: (msg) => {
        console.error(`${ts()} ${C.red}[DeepSearch] ✗${C.reset} ${msg}`);
    },
    result: (label, value) => {
        console.log(`${ts()} ${C.magenta}[DeepSearch]${C.reset} ${C.bold}${label}:${C.reset} ${value}`);
    },
    source: (index, title, url) => {
        console.log(`${ts()} ${C.green}[DeepSearch]${C.reset}   ${C.bold}[${index}]${C.reset} ${title}`);
        console.log(`${ts()} ${C.dim}        └── ${url}${C.reset}`);
    },
    timing: (label, ms) => {
        const color = ms < 3000 ? C.green : ms < 8000 ? C.yellow : C.red;
        console.log(`${ts()} ${C.cyan}[DeepSearch]${C.reset} ⏱  ${label}: ${color}${C.bold}${ms}ms${C.reset}`);
    },
    divider: () => {
        console.log(`${C.dim}  ${'─'.repeat(55)}${C.reset}`);
    },
    done: (totalMs, sourceCount, summaryLen) => {
        const line = '═'.repeat(60);
        console.log(`\n${C.green}${C.bold}${line}`);
        console.log(`  ✅ DEEP SEARCH COMPLETE`);
        console.log(`     Total Time : ${totalMs}ms`);
        console.log(`     Sources    : ${sourceCount}`);
        console.log(`     Summary    : ${summaryLen} chars`);
        console.log(`${line}${C.reset}\n`);
    }
};

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

/**
 * Deep Search Service
 * Implements a multi-step research pipeline:
 * 1. Query Planning   (via Gemini 2.5 Flash)
 * 2. Multi-Search     (via Tavily — sequential, rate-limit safe)
 * 3. Synthesis        (via Gemini 2.5 Flash)
 */
export const performDeepSearch = async (query, userLanguage = 'English') => {
    const globalStart = Date.now();

    try {
        ds.banner(`DEEP SEARCH  |  lang: ${userLanguage}`);
        ds.info(`Query    : "${C.bold}${query}${C.reset}"`);
        ds.info(`Language : ${userLanguage}`);
        ds.info(`Tavily   : ${TAVILY_API_KEY ? `${C.green}KEY PRESENT${C.reset}` : `${C.red}KEY MISSING${C.reset}`}`);

        if (!TAVILY_API_KEY) {
            ds.error('TAVILY_API_KEY is not set in .env — aborting Deep Search.');
            return {
                summary: "Deep Search requires a Tavily API Key. Please configure TAVILY_API_KEY in the environment.",
                sources: []
            };
        }

        // ── STEP 1: INSTANT QUERY EXPANSION (no LLM call — saves 20-25s) ─────
        ds.step(1, 'Query Expansion  (instant — no LLM call)');
        const step1Start = Date.now();

        // Generate 3 targeted query variants from the user's query programmatically.
        // This avoids a slow 22s Gemini call for what is a simple text manipulation task.
        const baseQuery = query.trim();
        const currentYear = new Date().getFullYear();
        const queries = [
            baseQuery,                                                          // exact user query
            `${baseQuery} ${currentYear} latest update`,                        // recency-focused
            `${baseQuery} detailed explained facts analysis`                    // depth-focused
        ];

        ds.timing('Query expansion', Date.now() - step1Start);
        ds.divider();
        ds.ok(`Generated ${queries.length} search queries (instant):`);
        queries.forEach((q, i) => ds.info(`  [${i + 1}] "${q}"`));

        // ── STEP 2: TAVILY MULTI-SEARCH (sequential) ─────────────────────────
        ds.step(2, 'Tavily Multi-Search  (sequential, rate-limit safe)');
        const step2Start = Date.now();

        let aggregatedContent = "";
        let sources = [];

        for (let i = 0; i < queries.length; i++) {
            const q = queries[i];
            const qStart = Date.now();
            ds.info(`[${i + 1}/${queries.length}] Searching → "${q}"`);
            try {
                const res = await axios.post('https://api.tavily.com/search', {
                    api_key: TAVILY_API_KEY,
                    query: q,
                    search_depth: "advanced",
                    include_answer: true,
                    include_raw_content: false,
                    max_results: 3
                }, { timeout: 20000 });

                const results = res.data?.results || [];
                ds.ok(`[${i + 1}/${queries.length}] Found ${C.bold}${results.length}${C.reset} results in ${Date.now() - qStart}ms`);

                results.forEach(item => {
                    aggregatedContent += `\n\n--- Source: ${item.title} ---\n${item.content}`;
                    sources.push({
                        title: item.title,
                        url: item.url,
                        description: item.content?.substring(0, 200) || ''
                    });
                    ds.info(`    ↳ ${item.title} (${item.url?.substring(0, 60)}...)`);
                });
            } catch (err) {
                const status = err.response?.status;
                const errMsg = err.response?.data?.error || err.response?.data?.message || err.message;
                ds.error(`[${i + 1}/${queries.length}] Tavily failed for "${q}"`);
                ds.error(`    Status: ${status || 'N/A'} | Reason: ${errMsg}`);
                if (status === 429) {
                    ds.warn('Rate limit hit (429) — stopping Tavily early to protect quota.');
                    break;
                }
            }
        }

        ds.timing('Tavily total', Date.now() - step2Start);
        ds.divider();

        const uniqueSources = Array.from(new Map(sources.map(s => [s.url, s])).values()).slice(0, 12);
        ds.result('Raw sources collected', sources.length);
        ds.result('Unique sources (deduped)', uniqueSources.length);
        ds.result('Aggregated content', `${aggregatedContent.length.toLocaleString()} chars`);

        if (sources.length === 0) {
            ds.warn('Zero sources returned from all queries — returning empty result.');
            return {
                summary: "I'm sorry, my research yielded no results for this query. The search service may be temporarily unavailable. Please try rephrasing your query.",
                sources: []
            };
        }

        // Truncate to safe context window for Gemini Flash
        const truncatedContent = aggregatedContent.substring(0, 40000);
        if (aggregatedContent.length > 40000) {
            ds.warn(`Content truncated from ${aggregatedContent.length.toLocaleString()} → 40,000 chars to fit Gemini context window.`);
        }

        // ── STEP 3: SYNTHESIS via Gemini ──────────────────────────────────────
        ds.step(3, 'Synthesis  (Gemini 2.5 Flash)');
        const step3Start = Date.now();

        const structureTitles = {
            'Hinglish': { intro: 'Intro/Puri Summary', insights: 'Khaas Baatein', facts: 'Zaroori Facts', sources: 'Sources/Links' },
            'Hindi':    { intro: 'परिचय और सारांश', insights: 'मुख्य बिंदु', facts: 'महत्वपूर्ण तथ्य', sources: 'स्रोत' },
            'English':  { intro: 'Overview', insights: 'Key Insights', facts: 'Important Facts', sources: 'Sources' },
            'Arabic':   { intro: 'نظرة عامة', insights: 'أبرز الأفكار الأساسية', facts: 'حقائق هامة', sources: 'المصادر' }
        };

        const titles = structureTitles[userLanguage] || structureTitles['English'];

        const synthesisPrompt = `You are AISA Deep Research Agent. You have been provided with raw data from multiple web sources.

USER QUERY: "${query}"
TARGET LANGUAGE: ${userLanguage}

DATA FROM SOURCES:
${truncatedContent}

Your task is to synthesize this into a structured, natural-sounding response in ${userLanguage} that feels like advice from an expert.

### REQUIRED STRUCTURE (In ${userLanguage}):
1. **${titles.intro}**: Summarize the topic naturally in ${userLanguage}.
2. **${titles.insights}**: Clear, actionable details extracted from the data, in ${userLanguage}.
3. **${titles.facts}**: Precise names, stats, or key data points, in ${userLanguage}.
4. **${titles.sources}**: Bulleted list of the source URLs.

### RULES:
- **NO CITATIONS IN TEXT**: Do not use [1], [2] or any inline reference numbers in the text.
- **TONE**: Natural, empathetic, human-like, conversational.
- **LANGUAGE MATCH (MANDATORY)**: Respond ENTIRELY in ${userLanguage}. Translate everything — even if sources are in a different language.
- **NO CODE-SWITCHING**: Do NOT mix languages for headers or explanations.
`;

        try {
            const synthesisText = await AskVertexRaw(synthesisPrompt, {
                maxOutputTokens: 2048,
                temperature: 0.3,
                modelOverride: 'gemini-2.5-flash'
            });

            ds.timing('Gemini synthesis', Date.now() - step3Start);
            ds.ok('Synthesis complete.');

            ds.divider();
            ds.ok('Final sources included in response:');
            uniqueSources.slice(0, 5).forEach((s, i) => ds.source(i + 1, s.title, s.url));

            ds.done(Date.now() - globalStart, uniqueSources.length, synthesisText?.length || 0);

            return {
                summary: synthesisText,
                sources: uniqueSources
            };

        } catch (synthError) {
            ds.timing('Gemini synthesis (FAILED)', Date.now() - step3Start);
            ds.error(`Synthesis step failed: ${synthError.message}`);
            if (synthError.stack) ds.error(`Stack: ${synthError.stack.split('\n')[1]}`);

            // Graceful fallback — return raw snippets
            ds.warn('Falling back to raw snippet summaries.');
            const fallbackSummary = uniqueSources
                .slice(0, 5)
                .map((s, i) => `**[${i + 1}] ${s.title}**\n${s.description}`)
                .join('\n\n');

            return {
                summary: `Here are the top results I found for your query:\n\n${fallbackSummary}`,
                sources: uniqueSources
            };
        }

    } catch (error) {
        const elapsed = Date.now() - globalStart;
        ds.error(`CRITICAL ERROR after ${elapsed}ms: ${error.response?.data?.error?.message || error.message}`);
        if (error.stack) {
            error.stack.split('\n').slice(0, 4).forEach(line => ds.error(line));
        }
        return {
            summary: "I encountered a problem performing the Deep Search. This could be due to a service timeout or API credit limits. Please try again with a more specific query.",
            sources: []
        };
    }
};
