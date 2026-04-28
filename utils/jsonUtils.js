import logger from './logger.js';

/**
 * safeParseLLMJson
 * Gold-standard robust JSON parser for AI outputs.
 * Handles markdown fences, surrounding text, trailing commas, 
 * unescaped control characters, and common truncation errors.
 * 
 * @param {string} content - Raw AI output string
 * @param {any} fallback - Fallback value if parsing fails completely
 * @returns {any} Parsed object/array or fallback
 */
export const safeParseLLMJson = (content, fallback = null) => {
    if (!content) return fallback;
    if (typeof content !== 'string') return content;
    
    let clean = content.replace(/```json\s*|\s*```/g, '').trim();

    // 1. Regex-based extraction of outermost {} or []
    const jsonRegex = /({[\s\S]*}|\[[\s\S]*\])/;
    const match = clean.match(jsonRegex);
    
    if (match) {
        clean = match[0].trim();
    }

    // 2. Direct parse attempt
    try {
        return JSON.parse(clean);
    } catch (e) {
        // Proceed to repairs
    }

    // 3. Repair strategy: Remove trailing commas and control characters
    try {
        let aggressive = clean
            .replace(/,\s*}/g, "}") 
            .replace(/,\s*]/g, "]") 
            .replace(/[\n\r\t]/g, " ") // Structural newlines replaced with spaces is safe for JSON
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); // Remove non-printable control chars
        
        return JSON.parse(aggressive);
    } catch (e) {
        // 4. Handle truncation and unterminated structures
        try {
            let truncated = clean;
            
            // Fix unclosed quotes
            const quotes = (truncated.match(/(?<!\\)"/g) || []).length;
            if (quotes % 2 !== 0) truncated += '"';

            let temp = truncated;
            // Attempt to close up to 15 nested levels
            for (let i = 0; i < 15; i++) {
                try {
                    return JSON.parse(temp);
                } catch (stepE) {
                    const openBrackets = (temp.match(/\[/g) || []).length;
                    const closeBrackets = (temp.match(/\]/g) || []).length;
                    const openBraces = (temp.match(/{/g) || []).length;
                    const closeBraces = (temp.match(/}/g) || []).length;

                    if (openBraces > closeBraces) temp += '}';
                    else if (openBrackets > closeBrackets) temp += ']';
                    else break;
                }
            }
        } catch (truncE) {
            // Ignore truncation repair errors and fall through
        }

        // 5. Final attempt: Handle 'Unexpected non-whitespace character' (garbage after valid JSON)
        try {
            for (let j = clean.length - 1; j > 0; j--) {
                if (clean[j] === '}' || clean[j] === ']') {
                    try {
                        return JSON.parse(clean.substring(0, j + 1));
                    } catch (f) { /* continue */ }
                }
            }
        } catch (fE) {
            // Ignore
        }

        logger.warn(`[JSON-Fixer] Critical failure parsing AI response. Snippet: ${content.substring(0, 100)}...`);
        return fallback;
    }
};
