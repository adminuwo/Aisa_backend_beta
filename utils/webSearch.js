/**
 * Web Search Utility for AISA™
 * Handles intelligent web search decision logic and result processing
 */

// Simple in-memory cache for search results (3-minute TTL)
const searchCache = new Map();
const CACHE_TTL = 3 * 60 * 1000;

/**
 * Get cached search results if available and not expired
 */
export function getCachedSearch(query) {
    const cached = searchCache.get(query);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[CACHE] Found cached results for: "${query}"`);
        return cached.data;
    }
    return null;
}

/**
 * Set search results in cache
 */
export function setCachedSearch(query, data) {
    searchCache.set(query, {
        timestamp: Date.now(),
        data: data
    });
}

// Keywords that trigger web search
const REAL_TIME_KEYWORDS = [
    // News & Events
    'latest', 'breaking', 'news', 'today', 'current', 'recent', 'now',
    'trending', 'viral', 'happening', 'update', 'new',

    // Market & Finance
    'price', 'stock', 'crypto', 'bitcoin', 'market', 'gold', 'silver',
    'fuel', 'petrol', 'diesel', 'exchange rate', 'dollar', 'rupee',

    // Sports & Entertainment
    'score', 'match', 'live', 'winner', 'ranking', 'leaderboard',
    'release', 'launch', 'premiere',

    // Weather & Time-sensitive
    'weather', 'forecast', 'temperature', 'rain', 'date', 'time', 'clock',
    'samay', 'din', 'waqt', 'tareekh', 'dinank',

    // Hindi/Hinglish equivalents
    'aaj', 'abhi', 'taaza', 'naya', 'khabar', 'samachar', 'bhav', 'rate',
    'आज', 'अभी', 'ताजा', 'खबर', 'समाचार', 'भाव', 'समय', 'दिन', 'वक्त', 'तारीख', 'दिनांक'
];

const GENERAL_KNOWLEDGE_INDICATORS = [
    'what is', 'who is', 'define', 'explain', 'how does', 'why does',
    'history of', 'meaning of', 'concept of', 'theory of'
];

/**
 * Determine if query requires web search
 */
export function requiresWebSearch(query) {
    const lowerQuery = query.toLowerCase();

    // Check for real-time keywords
    const hasRealTimeKeyword = REAL_TIME_KEYWORDS.some(keyword =>
        lowerQuery.includes(keyword)
    );

    // Check if it's a general knowledge question
    const isGeneralKnowledge = GENERAL_KNOWLEDGE_INDICATORS.some(indicator =>
        lowerQuery.startsWith(indicator)
    );

    // If general knowledge question, don't search
    if (isGeneralKnowledge && !hasRealTimeKeyword) {
        return false;
    }

    // If has real-time keywords, search
    if (hasRealTimeKeyword) {
        return true;
    }

    // Check for specific patterns
    const patterns = [
        /price of .+/i,
        /cost of .+/i,
        /\d+ (stock|share)/i,
        /.+ (today|now|currently)/i,
        /latest .+/i,
        /current .+/i
    ];

    return patterns.some(pattern => pattern.test(query));
}

/**
 * Extract search query from user message
 */
export function extractSearchQuery(message) {
    // Remove common prefixes
    let query = message
        .replace(/^(aisa|hey|hi|hello|tell me|what is|what's|whats)/i, '')
        .trim();

    return query || message;
}

/**
 * Process web search results with prioritization for trusted domains
 */
export function processSearchResults(searchData, limit = 5) {
    if (!searchData || !searchData.results || searchData.results.length === 0) {
        return null;
    }

    const TRUSTED_DOMAINS = ['.gov', '.org', 'reuters.com', 'bbc.com', 'bloomberg.com', 'finance.yahoo.com', 'espn.com', 'wikipedia.org'];

    // Sort: Trusted domains first
    const sorted = [...searchData.results].sort((a, b) => {
        const aTrusted = TRUSTED_DOMAINS.some(d => a.link.includes(d));
        const bTrusted = TRUSTED_DOMAINS.some(d => b.link.includes(d));
        if (aTrusted && !bTrusted) return -1;
        if (!aTrusted && bTrusted) return 1;
        return 0;
    });

    const results = sorted.slice(0, limit);

    return {
        snippets: results.map(r => ({
            title: r.title,
            snippet: r.snippet || r.description,
            source: r.source || extractDomain(r.link),
            link: r.link
        })),
        summary: results.map(r => r.snippet || r.description).join(' ')
    };
}

/**
 * Extract domain from URL
 */
function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace('www.', '');
    } catch {
        return 'Unknown Source';
    }
}

/**
 * Format sources for citation
 */
export function formatSources(snippets) {
    if (!snippets || snippets.length === 0) {
        return '';
    }

    const uniqueSources = [...new Set(snippets.map(s => s.source))];

    if (uniqueSources.length === 1) {
        return `\n\n*Source: ${uniqueSources[0]}*`;
    }

    if (uniqueSources.length === 2) {
        return `\n\n*Sources: ${uniqueSources[0]} and ${uniqueSources[1]}*`;
    }

    const firstTwo = uniqueSources.slice(0, 2).join(', ');
    const remaining = uniqueSources.length - 2;
    return `\n\n*Sources: ${firstTwo}, and ${remaining} other${remaining > 1 ? 's' : ''}*`;
}

import { getConfig } from '../services/configService.js';

/**
 * Generate web search system instruction
 */
export function getWebSearchSystemInstruction(searchResults, language = 'English', isDeepSearch = false) {
    const responseLanguage = language === 'Hindi' || language === 'Hinglish' ? 'Hindi' : 'English';
    const currentDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

    const conversationalRules = getConfig('AISA_CONVERSATIONAL_RULES', '');
    const brandRules = getConfig('BRAND_SYSTEM_RULES', '');
    const searchRules = getConfig('WEB_SEARCH_RULES', `### WEB SEARCH GUIDELINES:
- Task: Provide a comprehensive, accurate answer to the user's query using the live data provided.
- Citations: Cite your sources clearly using [1], [2], etc.
- Identity: You are AISA™, an advanced IT assistant created by UWO™ with real-time web search capabilities.`);

    return `${conversationalRules}\n${brandRules}\n\n${searchRules}
\nTODAY'S DATE & TIME: ${currentDate} (India Standard Time)

WEB SEARCH DATA PROVIDED:
${searchResults.snippets.map((s, i) => `${i + 1}. [${s.source}] ${s.title}: ${s.snippet} (Link: ${s.link})`).join('\n\n')}

CRITICAL INSTRUCTIONS:
- You are responding with real-time information.
- Use the language: ${responseLanguage}.
- If user writes in Hindi, translate and summarize search results in Hindi.
- Highlight numbers, prices, and dates in **bold**.
`;
}

export { REAL_TIME_KEYWORDS, GENERAL_KNOWLEDGE_INDICATORS };
