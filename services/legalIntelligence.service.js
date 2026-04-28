import * as vertexService from './vertex.service.js';
import logger from '../utils/logger.js';
import { safeParseLLMJson } from '../utils/jsonUtils.js';

/**
 * analyzeCaseDetails
 * Analyzes case details using AI and returns structured legal intelligence.
 */
export const analyzeCaseDetails = async (rawText, currentData = {}) => {
    const prompt = [
        'You are an advanced autonomous Legal Intelligence Engine.',
        'Your job is to fully analyze a legal case and generate COMPLETE structured output for a legal dashboard system.',
        '',
        '-------------------------------------',
        '⚠️ CRITICAL RULES (MUST FOLLOW):',
        '1. Output ONLY valid JSON',
        '2. Do NOT return any explanation or text outside JSON',
        '3. Do NOT leave any field empty',
        '4. If input data is incomplete, intelligently generate realistic legal assumptions',
        '5. NEVER return null or empty arrays',
        '6. Ensure all sections are filled with meaningful data',
        '7. If analysis fails, return fallback structured data (do NOT break JSON)',
        '-------------------------------------',
        '',
        'INPUT CASE:',
        `Case Summary: ${rawText}`,
        `Client: ${currentData.clientName || 'Not specified'}`,
        `Opponent: ${currentData.opponentName || 'Not specified'}`,
        `Case Type: ${currentData.caseType || 'Not specified'}`,
        '-------------------------------------',
        '',
        'OUTPUT FORMAT (STRICT):',
        JSON.stringify({
            executive_summary: "Clear summary of the case",
            case_strength: 0,
            win_probability: 0,
            timeline: [{ date: "DD Month YYYY", event: "Event title", description: "Explanation" }],
            parties: {
                plaintiff: { name: "Name", role: "Role" },
                defendant: { name: "Name", role: "Role" }
            },
            evidence: [{ title: "Evidence name", type: "document/email/witness", description: "Details", strength: "weak/medium/strong" }],
            legal_research: [{ law: "Law name", section: "Section", description: "Explanation" }],
            process_steps: [{ step: "Legal step", priority: "low/medium/high" }],
            risk_assessment: { level: "low/medium/high", reason: "Why" },
            critical_vulnerabilities: ["Weakness 1", "Weakness 2"],
            opponent_strategy: ["Possible opponent move"],
            primary_relief: "What the user wants legally",
            strategy_recommendation: ["Step 1", "Step 2"]
        }, null, 2),
        '',
        '-------------------------------------',
        '📊 QUALITY CONSTRAINTS:',
        '- timeline MUST have at least 3 events',
        '- evidence MUST have at least 2 items',
        '- legal_research MUST include real applicable laws (prefer Indian laws if relevant)',
        '- process_steps MUST be realistic legal workflow',
        '- risk_assessment MUST NOT be empty',
        '- strategy_recommendation MUST be actionable',
        '',
        '-------------------------------------',
        '🛑 FAILSAFE MODE:',
        'If you cannot analyze properly, STILL return full JSON using intelligent assumptions.',
        'Example fallback:',
        '- Generate reasonable timeline',
        '- Generate generic but realistic evidence',
        '- Assign medium risk',
        '- Provide general legal strategy',
        '',
        '-------------------------------------',
        'FINAL INSTRUCTION:',
        'Return ONLY JSON.',
        'No markdown.',
        'No explanation.',
        'No extra text.'
    ].join('\n');

    try {
        const response = await vertexService.AskVertexRaw(prompt, {
            maxOutputTokens: 3000,
            temperature: 0.1,
            modelOverride: 'gemini-2.5-flash',
            isJson: true
        });

        const fallback = {
            executive_summary: `AI Analysis Error: The system could not process the request. It returned: "${response.substring(0, 200)}..."`,
            case_strength: 0,
            win_probability: 0,
            timeline: [],
            parties: { plaintiff: { name: "Unknown", role: "Unknown" }, defendant: { name: "Unknown", role: "Unknown" } },
            evidence: [],
            legal_research: [],
            process_steps: [],
            risk_assessment: { level: "high", reason: "AI Analysis failed to return structured data." },
            critical_vulnerabilities: ["Data parsing failed."],
            opponent_strategy: [],
            primary_relief: "Unknown",
            strategy_recommendation: ["Please try running the analysis again or contact support if the issue persists."]
        };

        return safeParseLLMJson(response, fallback);
    } catch (error) {
        logger.error(`[LegalIntelligence] Analysis failed: ${error.message}`);
        logger.error(`[LegalIntelligence] Stack trace: ${error.stack}`);
        
        // Return fallback instead of throwing to prevent 500 error
        return {
            executive_summary: `AI Request Failed: ${error.message}`,
            case_strength: 0,
            win_probability: 0,
            timeline: [],
            parties: { plaintiff: { name: "Unknown", role: "Unknown" }, defendant: { name: "Unknown", role: "Unknown" } },
            evidence: [],
            legal_research: [],
            process_steps: [],
            risk_assessment: { level: "high", reason: "Backend request failed." },
            critical_vulnerabilities: [],
            opponent_strategy: [],
            primary_relief: "Unknown",
            strategy_recommendation: []
        };
    }
};

/**
 * analyzeDocumentContent
 * Extracts structured data from a specific document.
 */
export const analyzeDocumentContent = async (content, fileName) => {
    const prompt = [
        'Analyze the following legal document and extract key information.',
        `File: ${fileName}`,
        '',
        'Content:',
        content,
        '',
        'Return ONLY this JSON structure:',
        JSON.stringify({
            docType: "Notice",
            tags: ["tag1", "tag2"],
            summary: "Short summary of the document",
            keyClauses: [{ title: "Clause Name", description: "Why it matters" }]
        }, null, 2)
    ].join('\n');

    try {
        const response = await vertexService.AskVertexRaw(prompt, {
            maxOutputTokens: 1024,
            temperature: 0.1,
            modelOverride: 'gemini-2.5-flash',
            isJson: true
        });

        return safeParseLLMJson(response);
    } catch (error) {
        logger.error(`[LegalIntelligence] Document analysis failed: ${error.message}`);
        logger.error(`[LegalIntelligence] Stack trace: ${error.stack}`);
        return null;
    }
};
