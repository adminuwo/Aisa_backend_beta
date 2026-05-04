import Precedent from '../../../models/Precedent.js';
import * as vertexService from '../../../services/vertex.service.js';
import { performSearch } from '../../../services/webSearch.service.js';
import logger from '../../../utils/logger.js';
import { safeParseLLMJson } from '../../../utils/jsonUtils.js';

/**
 * findPrecedents
 * Main entry point for finding precedents.
 * Supports Dual Mode: MANUAL if userQuery exists, else CURRENT CASE.
 */
export const findPrecedents = async (userQuery, caseContext = null, language = 'English') => {
    const isManualMode = !!userQuery;
    const modeLabel = isManualMode ? "Manual Search Mode" : "Using Current Case";

    logger.info(`[Precedents] Mode: ${modeLabel}`);

    let searchQuery = userQuery;
    if (!isManualMode && caseContext) {
        // Extract search query from case context (Issues/Summary)
        searchQuery = constructSearchQueryFromContext(caseContext);
    }

    if (!searchQuery) {
        throw new Error("No search query or case context provided.");
    }

    // 1. Retrieve Candidate Cases
    // Try Internal DB first
    let candidates = await searchInternalDB(searchQuery);

    // If not enough internal results, fetch from Web Search
    if (candidates.length < 5) {
        const externalResults = await searchExternal(searchQuery);
        candidates = [...candidates, ...externalResults];
    }

    // 2. Normalize and Rank
    const rankedCandidates = rankPrecedents(candidates, searchQuery, caseContext);

    // 3. Process top 5 with AI for detailed structured data
    const topCandidates = rankedCandidates.slice(0, 5);
    const processedPrecedents = await Promise.all(
        topCandidates.map(async (c) => await processPrecedentWithAI(c, caseContext, language))
    );

    return {
        mode: modeLabel,
        precedents: processedPrecedents.filter(p => p !== null),
        query: searchQuery
    };
};

const constructSearchQueryFromContext = (context) => {
    const issues = context.legalIssues ? context.legalIssues.join(' ') : '';
    const type = context.caseType || '';
    const summary = context.summary || context.caseSummary || '';
    return `${type} ${issues} ${summary}`.trim();
};

const searchInternalDB = async (query) => {
    try {
        // Simple text search or keyword match
        const cases = await Precedent.find(
            { $text: { $search: query } },
            { score: { $meta: "textScore" } }
        ).sort({ score: { $meta: "textScore" } }).limit(10);

        return cases.map(c => ({
            ...c.toObject(),
            source: 'Internal'
        }));
    } catch (error) {
        logger.error(`[Precedents] Internal DB search failed: ${error.message}`);
        return [];
    }
};

const searchExternal = async (query) => {
    try {
        logger.info(`[Precedents] Searching external for: ${query}`);
        const result = await performSearch(`Find top 5 landmark legal judgements, case laws, and precedents related to: "${query}". Focus on Supreme Court and High Court cases with complete citations (AIR, SCC, etc.) and brief reasoning.`, 'English');

        if (!result || !result.summary) return [];

        // Parse external summary into structured candidate objects
        const extractionPrompt = `
        Extract a list of 5-10 legal cases from the following text.
        Return ONLY a valid JSON array of objects.
        Each object MUST have: case_name, court, year, citation, district (if mentioned), area (if mentioned), text (a detailed description of the case facts and judgment if present).
        
        TEXT:
        ${result.summary}
        `;

        const extractionResponse = await vertexService.AskVertexRaw(extractionPrompt, {
            isJson: true,
            modelOverride: 'gemini-2.5-flash',
            temperature: 0
        });

        const extractedCases = safeParseLLMJson(extractionResponse, []);
        return extractedCases.map(c => ({ ...c, source: 'API' }));
    } catch (error) {
        logger.error(`[Precedents] External search failed: ${error.message}`);
        return [];
    }
};

const rankPrecedents = (precedents, query, context) => {
    // Basic ranking: Internal sources get a boost, then keyword overlap
    const queryTerms = query.toLowerCase().split(' ');

    return precedents.map(p => {
        let score = 0;
        const pText = `${p.case_name} ${p.text} ${p.tags ? p.tags.join(' ') : ''}`.toLowerCase();

        // Keyword overlap
        queryTerms.forEach(term => {
            if (pText.includes(term)) score += 10;
        });

        // Source boost
        if (p.source === 'Internal') score += 20;

        // Year boost (prefer recent)
        if (p.year) score += (p.year - 2000) / 10;

        return { ...p, rankScore: score };
    }).sort((a, b) => b.rankScore - a.rankScore);
};

const processPrecedentWithAI = async (caseData, context = null, language = 'English') => {
    const isHindi = language === 'Hindi' || language === 'hi';
    const langRule = isHindi
        ? "\n\n### MANDATORY LANGUAGE RULE:\n- Generate ALL text in HINDI.\n- Use 'Simple Hindi + English term in brackets' for all legal concepts (e.g. 'अनुबंध (Contract)', 'शपथ पत्र (Affidavit)').\n- Maintain professional legal tone."
        : `\n\n### MANDATORY LANGUAGE RULE:\n- Respond entirely in ${language}.`;

    const prompt = `
    You are a Senior Legal Research Intelligence System. 
    Analyze the following case law and provide a complete, structured landmark judgment report.
    ${langRule}
    
    CASE DATA:
    Name: ${caseData.case_name}
    Citation: ${caseData.citation}
    Court: ${caseData.court}
    Year: ${caseData.year}
    Text: ${caseData.text}
    
    ${context ? `CONTEXT OF MY CURRENT CASE:
    Summary: ${context.summary || context.caseSummary}
    Issues: ${context.legalIssues ? context.legalIssues.join(', ') : 'N/A'}` : ''}

    REQUIRED JSON FORMAT (STRICT):
    {
        "case_identity": {
            "case_name": "...",
            "court": "...",
            "year": "...",
            "citation": "...",
            "bench": "...",
            "district": "...",
            "area": "..."
        },
        "case_context": {
            "facts": "Short & clear key facts",
            "legal_issue": "The specific question decided"
        },
        "judgment_outcome": {
            "final_decision": "Who won and what was the result",
            "type": "Allowed / Dismissed / Partially Allowed / etc."
        },
        "judgment_basis": {
            "legal_reasoning": "Detailed logic for the decision",
            "principles_applied": ["e.g., Natural Justice", "Contractual Obligation"],
            "relevant_laws": ["e.g., Article 21", "Section 138 of NI Act"]
        },
        "landmark_value": {
            "importance": "Why this case is a landmark",
            "precedent_status": "Whether it set a new precedent or followed one",
            "impact": "How it affects future cases"
        },
        "similarity": {
            "relevance_score": 0-100,
            "matching_factors": ["Fact matching", "Law matching", "Issue matching"]
        },
        "key_takeaways": [
            "3-5 bullet insights from the judgment"
        ],
        "tags": ["Tag1", "Tag2"]
    }

    RULES:
    - Focus on decision logic and legal reasoning, not just description.
    - Prioritize high-authority interpretations.
    - Use scannable, structured text. Avoid long paragraphs.
    - If my current case context is provided, explain the similarity precisely.
    - DO NOT hallucinate citations.
    `;

    try {
        const response = await vertexService.AskVertexRaw(prompt, {
            modelOverride: 'gemini-2.5-flash',
            temperature: 0.1,
            isJson: true
        });

        return safeParseLLMJson(response);
    } catch (error) {
        logger.error(`[Precedents] AI processing failed for ${caseData.case_name}: ${error.message}`);
        return null;
    }
};

/**
 * analyzePrecedent
 * Performs specific AI tasks like Summarization or Comparison.
 */
export const analyzePrecedent = async (actionType, precedentData, activeCaseData = null, language = 'English') => {
    const isHindi = language === 'Hindi' || language === 'hi';
    const langRule = isHindi
        ? "\n\n### MANDATORY LANGUAGE RULE:\n- Generate ALL text in HINDI.\n- Use professional legal Hindi terminology.\n- Maintain high formal tone."
        : `\n\n### MANDATORY LANGUAGE RULE:\n- Respond entirely in ${language}.`;

    let prompt = "";

    if (actionType === 'summarize') {
        prompt = `
        You are a Senior Legal Counsel. Provide a "Master Summary" of the following legal judgment.
        ${langRule}

        PRECEDENT DATA:
        Case: ${precedentData.case_identity?.case_name || precedentData.case_name}
        Reasoning: ${precedentData.judgment_basis?.legal_reasoning || precedentData.reasoning}
        Outcome: ${precedentData.judgment_outcome?.final_decision || precedentData.decision}

        STRUCTURE YOUR RESPONSE (SCANNABLE MARKDOWN):
        ### ⚖️ Judgment Overview
        (Provide a 2-sentence high-level overview)

        ### 🔍 Critical Findings
        - Bullet points of the most important findings of the court.
        
        ### 📖 Legal Principle (Ratio Decidendi)
        - Clear statement of the law established.

        ### 🏛️ Conclusion & Impact
        - Final result and why it matters to the legal field.
        `;
    } else if (actionType === 'compare') {
        prompt = `
        You are a Legal Strategy Expert. Compare the following "Landmark Precedent" with my "Active Case" to find strategic overlaps.
        ${langRule}

        LANDMARK PRECEDENT:
        Case: ${precedentData.case_identity?.case_name || precedentData.case_name}
        Facts: ${precedentData.case_context?.facts || precedentData.facts}
        Decision: ${precedentData.judgment_outcome?.final_decision || precedentData.decision}

        MY ACTIVE CASE:
        Type: ${activeCaseData?.caseType || 'N/A'}
        Facts: ${activeCaseData?.summary || activeCaseData?.caseSummary || activeCaseData?.facts || 'N/A'}
        Issues: ${activeCaseData?.legalIssues?.join(', ') || 'N/A'}

        STRUCTURE YOUR RESPONSE (SCANNABLE MARKDOWN):
        ### 🤝 Key Overlaps
        - Highlight specific factual or legal similarities.

        ### ⚖️ Strategic Advantage
        - Explain how this precedent supports our side.
        
        ### ⚠️ Potential Distinctions
        - Note any differences that the opposing counsel might use to distinguish this case.

        ### 💡 Strategic Advice
        - Practical next steps based on this comparison.
        `;
    }

    try {
        const response = await vertexService.AskVertexRaw(prompt, {
            modelOverride: 'gemini-2.5-flash',
            temperature: 0.2
        });

        return response;
    } catch (error) {
        logger.error(`[Precedents] AI Analysis failed for ${actionType}: ${error.message}`);
        throw error;
    }
};
