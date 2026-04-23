import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import Knowledge from "../models/Knowledge.model.js";
import { Worker } from 'worker_threads';
import path from 'path';
import * as vertexService from './vertex.service.js';
import * as openaiService from './openai.service.js';
import * as webSearchService from './webSearch.service.js';
import * as deepSearchService from './deepSearch.service.js';
import groqService from './groq.service.js';
import memoryService from './memory.service.js';
import QueryLog from '../models/QueryLog.model.js';
import userIntelligenceService from './userIntelligence.service.js';
import * as configService from './configService.js';
import { detectLanguage } from '../utils/languageDetector.js';
import { classifyIntent } from './intent/intentClassifier.js';
import { getLegalPrompt, LEGAL_DISCLAIMER } from '../Tools/AI_Legal/legalPrompts.js';


// Real RAG Storage (MongoDB Atlas)
let vectorStore = null;
let embeddings = null;

// Web Search Cache
const searchCache = new Map();
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

const initializeVectorStore = async () => {
    if (!embeddings) {
        logger.info("Initializing Local Embeddings (Xenova/all-MiniLM-L6-v2) for Chat...");
        embeddings = new HuggingFaceTransformersEmbeddings({
            modelName: "Xenova/all-MiniLM-L6-v2",
        });
    }
    if (!vectorStore) {
        if (mongoose.connection.readyState !== 1) {
            throw new Error("MongoDB not connected yet");
        }
        const collection = mongoose.connection.db.collection("knowledge_vectors");
        vectorStore = new MongoDBAtlasVectorSearch(embeddings, {
            collection: collection,
            indexName: "default",
            textKey: "text",
            embeddingKey: "embedding",
        });
        logger.info("MongoDB Atlas Vector Store initialized.");
    }
};

export const storeDocument = async (text, docId = null) => {
    try {
        await initializeVectorStore();
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });
        const docs = await splitter.createDocuments([text]);
        logger.info(`[RAG] Split into ${docs.length} chunks.`);
        if (docs.length === 0) {
            logger.warn("[RAG] No chunks to embed.");
            return false;
        }
        const vectors = await embeddings.embedDocuments(docs.map(d => d.pageContent));
        logger.info(`[RAG] Generated ${vectors.length} vectors.`);
        await vectorStore.addVectors(vectors, docs);
        logger.info("[RAG] SUCCESSFULLY called vectorStore.addVectors().");
        return true;
    } catch (error) {
        logger.error(`[RAG UPLOAD ERROR] ${error.message}`);
        return false;
    }
};

export const chat = async (message, activeDocContent = null, options = {}) => {
    logger.info(`[AI-Service] Chat request received. Mode: ${options.mode || 'NORMAL'}`);
    let finalResponseData = { text: "" };
    try {
        if (!message || typeof message !== 'string') {
            message = String(message || "");
        }

        const { systemInstruction, mode, images, documents, userName, language, conversationId, userId, model, history, toolName } = options;
        
        const lowerMsg = message.toLowerCase().trim();
        const companyKeywords = ['uwo', 'aisa', 'ai mall', 'unified web', 'what can you do', 'your features', 'your capabilities', 'who are you', 'how can you help', 'tell me about your services'];
        let hasCompanyKeyword = companyKeywords.some(k => lowerMsg.includes(k));

        // --- LANGUAGE DETECTION ---
        const detected = detectLanguage(message);
        // Special: If detected as English, we don't force it in the prompt as strictly
        // to allow the AI's internal detection to pick up subtle nuances (like French/Spanish)
        const userLanguage = detected; // Prioritize actual query language for response context
        const isDefaultEnglish = detected === 'English'; 
        
        const langSwitchRule = `### LANGUAGE BEHAVIOR: 
        1. If the user changes their script or language (e.g. from English to Arabic), you MUST immediately switch your entire response to that new language. 
        2. DO NOT use the previous language of the conversation if the current message is in a clear different script/tongue.
        3. Match the LATEST message's language 100%.`;

        logger.info(`[AI-Service] Lang Selection: ${userLanguage} (Detected: ${detected}, Option: ${language})`);

        // --- CONVERSATION MEMORY RAG ---
        // Combine history from frontend and retrieved memory from DB if available
        let retrievedHistory = [];
        if (conversationId) {
            logger.info(`[Memory] Retrieving memory for conversation: ${conversationId}`);
            retrievedHistory = await memoryService.retrieveMemory(conversationId, message, 5);
        }

        // Prepare context for non-Vertex models if history is provided
        const combinedHistory = history || []; // history from frontend is prioritized for multi-model consistency
        
        // Save User Message (async)
        if (conversationId) {
            memoryService.saveMessageWithEmbedding(conversationId, userId, 'user', message).catch(err => {
                logger.error(`[Memory] Failed to save user message: ${err.message}`);
            });
        }

        // PRIORITY -1: PERSONA INJECTION & TOOL RESTRICTIONS
        const personaContext = await userIntelligenceService.getPersonaInjection(userId);
        
        const isActuallyImageMode = mode === 'IMAGE_GEN' || mode === 'IMAGE_EDIT';
        const isActuallyVideoMode = mode === 'VIDEO_GEN' || mode === 'IMAGE_TO_VIDEO';
        const isActuallySearchMode = mode === 'web_search' || mode === 'DEEP_SEARCH';
        const isActuallyCodeMode = mode === 'CODE_WRITER' || mode === 'CODING_HELP';
        const isActuallyConvertMode = mode === 'FILE_CONVERSION' || mode === 'DOCUMENT_CONVERT';
        
        let toolRestrictions = "";
        if (isActuallyImageMode) {
            toolRestrictions = "\n\n### MODE: IMAGE GENERATION ENABLED. You can generate images using JSON action strictly if explicitly asked. CRITICAL: When creating the JSON action, your 'prompt' MUST preserve the exact main subject requested by the user. Do NOT change, replace, or creatively reimagine the core subject (e.g. if the user says 'panda' or misinterprets it as 'panada', use exactly what they intended or wrote). NEVER substitute the subject with a generic person or other unrelated concepts.";
        } else if (isActuallyVideoMode) {
            toolRestrictions = "\n\n### MODE: VIDEO GENERATION ENABLED. You can generate videos using JSON action strictly if explicitly asked.";
        } else if (isActuallySearchMode) {
            toolRestrictions = "\n\n### MODE: WEB SEARCH ENABLED. Answer based on real-time data.";
        } else if (isActuallyCodeMode) {
            toolRestrictions = `
\n\n### MODE: CODE WRITER ENABLED.
- ROLE: You are an expert Software Architect and Senior Lead Developer. Your goal is to provide highly structured, technical, and complete implementation-ready code.
- FORMATTING OVERRIDE: Ignore general rules about "Using bullet points for lists" when displaying project structures.
- UNIFIED TREE: You MUST display the entire project/folder architecture inside ONE SINGLE markdown code block using a visual tree format (e.g., \`\`\`text).
- FULL FILE CONTENT: After the tree structure, you MUST provide the COMPLETE, FULL code for each and every file listed in the tree. Do not just explain what the file does. Do not provide partial code or just the file name. Provide the actual, runnable code.
- CODE BLOCKS: Wrap ALL code in proper multi-line markdown code blocks with the correct language tag (e.g., \`\`\`javascript, \`\`\`python, \`\`\`html).
- FILE PATHS: Before every code block, clearly write the file path as a bold header (e.g., **src/server.js**). Do NOT place file names inside code blocks unless it's a comment inside the actual code.
- NO INLINE PATHS AS CODE: Never output just the file name or folder name inside a code block. Code blocks are STRICTLY for the directory tree and the actual code.
- EXAMPLE TREE FORMAT (MANDATORY):
\`\`\`text
ProjectRoot/
├── src/
│   ├── controllers/
│   │   ├── AuthController.js
│   │   └── UserController.js
│   ├── models/
│   │   ├── User.js
│   │   └── ChatSession.js
│   └── server.js
└── package.json
\`\`\`
- CLEAN OUTPUT: Provide the unified Directory Tree first, and then sequentially provide the bold file name followed by its complete code block for every file.
`;
        } else if (isActuallyConvertMode) {
            toolRestrictions = `
\n\n### MODE: FILE CONVERSION ENABLED. 
You can convert documents between formats (PDF to DOCX, DOCX to PDF). 
To perform a conversion, you MUST respond with a JSON action strictly in this format:
{
  "action": "file_conversion",
  "source_format": "docx",
  "target_format": "pdf"
}
Maintain any text response outside the JSON block.`;
        } else if (mode === 'LEGAL_TOOLKIT') {
            toolRestrictions = `\n\n### MODE: LEGAL SYSTEM ACTIVE — STRICT DOMAIN LOCK ⚖️
- You are a Senior Legal Assistant specialist EXCLUSIVELY for legal matters.
- 🚨 ABSOLUTE RESTRICTION: You MUST ONLY respond to queries related to: law, legal acts, IPC/CrPC/CPC sections, court procedures, legal documents, contracts, FIR, rights, legal strategy, affidavits, legal notices, evidence, case analysis, or any legal guidance.
- 🚫 STRICTLY REFUSE any query that is NOT related to law or legal topics (e.g., general knowledge, coding, entertainment, science, weather, math, jokes, recipes, sports, technology, etc.).
- IF the user asks a non-legal question, you MUST respond ONLY with this exact message (match the user's language):
  "⚖️ I am the AISA AI Legal Assistant. I can only assist with legal matters — law, acts, sections, court procedures, legal documents, and legal guidance. Please ask a legal question."
- DO NOT attempt to partially answer non-legal questions.
- DO NOT add any conversational filler or apologies beyond the refusal message above.
- DO NOT include any legal disclaimers, warnings, or professional advice notices in the response. The system appends these automatically.`;
        } else {

            toolRestrictions = "\n\n### MODE: NORMAL CHAT. Strictly avoid executing magic actions. Answer questions using text only. If the user wants to generate media, tell them to use the AISA Magic Tools menu.";
        }

        // --- INTENT CLASSIFICATION & RAG DETECTION (PARALLELIZED FOR SPEED) ---
        let classification = null;
        let needsRAG = false;
        let rewrittenQuery = message;
        

        try {
            // Strip [ACTIVE TOOL: ...] prefixes and legal disclaimers from history
            // to prevent prior legal-mode context from poisoning the intent classifier
            const chatSummary = (combinedHistory || []).slice(-3).map(m => {
                let text = m.content || m.text || '';
                // Remove [ACTIVE TOOL: ...] header (bold markdown variant too)
                text = text.replace(/^\*?\*?\[ACTIVE TOOL:[^\]]*\]\*?\*?\s*/i, '');
                // Remove legal disclaimer footer
                text = text.replace(/⚖️ \*\*Legal Disclaimer:\*\*.*$/is, '');
                return `${m.role}: ${text.trim()}`;
            }).join(' | ');
            
            // Run independent pre-processing tasks in parallel
            const [intentResult, ragDecision] = await Promise.all([
                classifyIntent(message, images || documents || [], chatSummary).catch(() => null),
                // Only detect RAG if we have documents or might need company info
                (async () => {
                    const docCount = await Knowledge.countDocuments();
                    const manualCorpusId = process.env.VERTEX_RAG_CORPUS_ID;
                    if (docCount > 0 || manualCorpusId) {
                        if (mode === 'LEGAL_TOOLKIT') return true;
                        if (hasCompanyKeyword) return true;
                        return await vertexService.detectRAGNeed(message).catch(() => false);
                    }
                    return false;
                })()
            ]);

            classification = intentResult;
            needsRAG = ragDecision;

            // Trigger parallel rewrite if RAG is needed
            if (needsRAG) {
                rewrittenQuery = await vertexService.rewriteQuery(message).catch(() => message);
            }
        } catch (preProcessErr) {
            logger.warn(`[AI-Service] Pre-processing failed: ${preProcessErr.message}`);
        }

        let legalInstruction = "";
        // CRITICAL GUARD: Only auto-inject legal prompt if user is explicitly in LEGAL_TOOLKIT mode.
        // Prevents intent classifier from accidentally triggering the legal persona in normal chat.
        if (mode === 'LEGAL_TOOLKIT' && classification && classification.intent && classification.intent.startsWith('legal_')) {
            const isRedundant = toolName === classification?.intent;
            if (!isRedundant) {
               logger.info(`[AI-Service] Legal Intent Detected: ${classification.intent}.`);
               legalInstruction = `\n\n### SPECIALIZED LEGAL TOOL: ${classification.intent}\n${getLegalPrompt(classification.intent)}`;
            }
        }

        // --- INTENT-BASED TOOL ROUTING (STOCKS) ---
        if (classification && (classification.intent === 'stock_researcher' || classification.tools?.includes('stock_researcher'))) {
            logger.info(`[AI-Service] Stock Researcher intent detected.`);
            let symbol = classification.metadata?.stock_symbol || null;
            if (!symbol) {
                const capsMatch = message.match(/\b[A-Z]{2,10}\b/);
                if (capsMatch) symbol = capsMatch[0];
            }
            if (symbol) {
                const { getAiSnapshot } = await import('./stockService.js');
                const snapshot = await getAiSnapshot(symbol);
                if (snapshot) {
                    finalResponseData = { 
                        text: `Here is my detailed analysis for **${symbol}**. I've compiled an AI Snapshot with risk analysis, performance metrics, and professional recommendations.`,
                        snapshot: snapshot,
                        type: 'stock_snapshot'
                    };
                }
            }
        }

        // --- GMAIL ASSISTANT ROUTING ---
        if (!finalResponseData.text && classification && (classification.intent === 'gmail_assistant' || classification.tools?.includes('gmail_assistant'))) {
            logger.info(`[AI-Service] Gmail Assistant intent detected. Triggering Gmail Service...`);
            const { handleGmailIntent } = await import('./intent/gmailService.js');
            const gmailResponse = await handleGmailIntent(userId, message);
            if (gmailResponse) {
                finalResponseData = { 
                    text: gmailResponse.text,
                    type: 'gmail_assistant_action'
                };
            }
        }

        // Construct dynamic instruction without legal rule (it will be added at the absolute end)
        const dynamicSystemInstruction = (systemInstruction || "") + personaContext + toolRestrictions;

        // Helper to build context-aware prompt
        const buildMemoryPrompt = (query) => {
            if (retrievedHistory.length > 0) {
                return memoryService.buildContext(dynamicSystemInstruction, retrievedHistory, query);
            }
            return query;
        };

        // PRIORITY 0: REAL-TIME WEB SEARCH
        if (message.length > 5 && !images?.length && !documents?.length && !activeDocContent?.length) {
            const cacheKey = message.toLowerCase().trim();
            if (searchCache.has(cacheKey)) {
                const cached = searchCache.get(cacheKey);
                if (Date.now() - cached.timestamp < CACHE_TTL) {
                    logger.info(`[WebSearch] Cache HIT for: ${message}`);
                    finalResponseData = { text: cached.result.summary, isRealTime: true, sources: cached.result.sources };
                }
            }

            if (!finalResponseData.text) {
                const isForcedSearch = mode === 'web_search' || mode === 'DEEP_SEARCH' || mode === 'SEARCH';
                // Only perform web search if explicitly requested via mode.
                // This ensures "normal questions" go to Vertex AI without extra resources.
                if (isForcedSearch) {
                    logger.info(`[WebSearch] ROUTING TO LIVE SEARCH (Mode: ${mode}) for: ${message}`);
                    let searchResult;
                    
                    if (mode === 'DEEP_SEARCH') {
                        searchResult = await deepSearchService.performDeepSearch(message, userLanguage);
                    } else {
                        searchResult = await webSearchService.performSearch(message, userLanguage);
                    }

                    if (searchResult && (searchResult.summary || searchResult.text)) {
                        const summary = searchResult.summary || searchResult.text;
                        searchCache.set(cacheKey, { result: { summary, sources: searchResult.sources }, timestamp: Date.now() });
                        finalResponseData = { text: summary, isRealTime: true, sources: searchResult.sources };
                    } else {
                        logger.warn("[WebSearch] Search yielded no results.");
                    }
                }
            }
        }

        if (finalResponseData.text) {
            // Memory save handled at end
        } else if ((activeDocContent && activeDocContent.length > 0) || (images && images.length > 0) || (documents && documents.length > 0)) {
            // PRIORITY 1: Chat-Uploaded Document / Images
            
            // --- NEW: Legal Context Merging ---
            let combinedContext = null;
            if (mode === 'LEGAL_TOOLKIT') {
                logger.info(`[LegalToolkit] Merging Case Context and RAG for Priority Rule.`);
                const rewrittenQuery = await vertexService.rewriteQuery(message);
                const ragContext = await vertexService.retrieveContextFromRag(rewrittenQuery, 8, 'LEGAL');
                
                combinedContext = `📄 CASE CONTEXT (PRIMARY):\n${activeDocContent || "Refer to attached file contents."}\n\n📚 LEGAL KNOWLEDGE (RAG - REFERENCE):\n${ragContext?.text || "No relevant legal references found."}`;
            }

            const promptWithMemory = buildMemoryPrompt(message);
            const vertexResponse = await vertexService.askVertex(promptWithMemory, combinedContext || activeDocContent, {
                systemInstruction: dynamicSystemInstruction, 
                mode, 
                images, 
                documents,
                userName
            });
            finalResponseData = { text: vertexResponse, isRealTime: false };
        } else {
            // PRIORITY 2: Company Knowledge Base (Vertex RAG)
            let ragContext = null;
            if (needsRAG) {
                const targetCategory = (mode === 'LEGAL_TOOLKIT' || legalInstruction) ? 'LEGAL' : 'GENERAL';
                logger.info(`[RAG-Logic] Target Category: ${targetCategory}`);
                ragContext = await vertexService.retrieveContextFromRag(rewrittenQuery, 8, targetCategory);
                
                if (!ragContext) {
                    logger.warn(`[RAG-Logic] No context found for ${targetCategory}. Allowing fallback to general model.`);
                }
                
                // Logging
                try {
                    await QueryLog.create({
                        user_question: message,
                        rewritten_query: rewrittenQuery,
                        retrieved_documents: ragContext?.sources?.map(s => ({
                            document_title: s.document_title,
                            source_type: s.source_type,
                            chunk_id: s.chunk_id,
                            snippet: s.snippet
                        })) || [],
                        userId: userId || 'admin'
                    });
                } catch (logErr) {
                    logger.error(`[QueryLog] Failed: ${logErr.message}`);
                }
            } else {
                logger.info(`[RAG] Skipping retrieval. Query "${message}" is generic.`);
            }

            // Step 4: Final Processing
            if (needsRAG || (ragContext && ragContext.text)) {
                // If context is missing but RAG was needed, we still proceed to provide a general AI response.
                if (!ragContext || !ragContext.sources || ragContext.sources.length === 0) {

                    if (hasCompanyKeyword) {
                        ragContext = ragContext || {};
                        ragContext.sources = [{
                            title: "Unified Web Options",
                            url: "https://uwo24.com/",
                            snippet: "Official information about AISA and UWO services.",
                            document_title: "Unified Web Options",
                            source_type: "URL",
                            chunk_id: `brand_${Date.now()}`
                        }];
                    }
                }

                const promptWithMemory = buildMemoryPrompt(message);
                // Step 4: Answer Generation (Context + Original Question)
                const ragInstructionWithLink = `${dynamicSystemInstruction}\n\n### WEBSITE CITATION RULE:\nWhenever you provide information about AISA or UWO based on the provided company documents, you MUST mention the official website: https://uwo24.com/`;

                const langContext = isDefaultEnglish 
                    ? "MANDATORY: You MUST detect and match the EXACT script and tongue used by the user. If they use ENGLISH, you MUST respond in ENGLISH. If they use a non-English language or script, respond ENTIRELY in that same language/script."
                    : `MANDATORY: You MUST match the EXACT script and tongue used by the user. If they use ${userLanguage} script, respond ENTIRELY in ${userLanguage} script. (Detected: ${userLanguage})`;

                // --- NEW: Unified Context Labeling for RAG-Only ---
                const labeledRagContext = (mode === 'LEGAL_TOOLKIT')
                    ? `📄 CASE CONTEXT: No specific document uploaded. Relying on legal principles.\n\n📚 LEGAL KNOWLEDGE (RAG):\n${ragContext?.text}`
                    : ragContext?.text;

                const ragResponse = await vertexService.askVertex(promptWithMemory, labeledRagContext, { 
                    userName, 
                    systemInstruction: `${ragInstructionWithLink}\n\n${langSwitchRule}\n\n### LANGUAGE RULE: ${langContext}`,
                    mode: 'RAG' 
                });
                finalResponseData = { text: ragResponse, isRealTime: false, sources: ragContext?.sources || [], mode: 'RAG' };
            } else {
                // PRIORITY 3: Multi-Model or Vertex AI General Chat
                const promptWithMemory = buildMemoryPrompt(message);
                
                const currentModel = model?.toLowerCase();
                let aiResponse = "";

                if (currentModel && (currentModel.includes('gpt') || currentModel.includes('openai'))) {
                    logger.info(`[AI-Service] Routing to OpenAI (${currentModel})`);
                    const langContext = isDefaultEnglish 
                        ? "MANDATORY: You MUST detect and match the EXACT script and tongue used by the user. If they use ENGLISH, you MUST respond in English. If they use a non-English language or script, respond ENTIRELY in that same language/script."
                        : `MANDATORY: You MUST match the EXACT script and tongue used by the user. If they use ${userLanguage} script, respond ENTIRELY in ${userLanguage} script. (Detected: ${userLanguage})`;

                    const finalSystemInstruction = `${dynamicSystemInstruction}\n\n${langSwitchRule}\n\n### LANGUAGE RULE: ${langContext}\n\n${legalInstruction}`;
                    aiResponse = await openaiService.askOpenAI(promptWithMemory, null, {
                        systemInstruction: finalSystemInstruction,
                        userName
                    });
                } else if (currentModel && (currentModel.includes('groq') || currentModel.includes('llama'))) {
                    logger.info(`[AI-Service] Routing to Groq (${currentModel})`);
                    aiResponse = await groqService.askGroq(promptWithMemory, null);
                } else {
                    // Default to Vertex AI (Gemini)
                    const lowerMsg = message.toLowerCase().trim();
                    const greetings = ['hi', 'hello', 'hii', 'hey', 'yo', 'namaste', 'greeting'];
                    const isGreeting = greetings.some(g => lowerMsg === g || lowerMsg.startsWith(g + ' '));

                    const basePersona = isGreeting 
                        ? configService.getGreetingSystemInstruction(personaContext)
                        : configService.getGeneralSystemInstruction(personaContext);

                    logger.info(`[AI-Service] Executing Chat (Greeting: ${isGreeting}) for: "${message}"`);

                    const langContext = isDefaultEnglish 
                        ? "MANDATORY: You MUST detect and match the EXACT script and tongue used by the user. If they use ENGLISH, you MUST respond in ENGLISH. If they use a non-English language or script, respond ENTIRELY in that same language/script."
                        : `MANDATORY: You MUST match the EXACT script and tongue used by the user. If they use ${userLanguage} script, respond ENTIRELY in ${userLanguage} script. (Detected: ${userLanguage})`;

                    const finalSystemInstruction = `${basePersona}\n\n${dynamicSystemInstruction}\n\n${langSwitchRule}\n\n### LANGUAGE RULE: ${langContext}\n\n${legalInstruction}`;

                    aiResponse = await vertexService.askVertex(promptWithMemory, null, { 
                        userName, 
                        systemInstruction: finalSystemInstruction,
                        mode: mode || 'GENERAL',
                        images,
                        documents
                    });
                }
                
                finalResponseData = { text: aiResponse, isRealTime: false };
            }
        }

        // --- Post-Processing: Trigger Intelligence Engine (Async) ---
        userIntelligenceService.processInteraction(userId, message, 'user').catch(err => {
            logger.error(`[Intelligence] Processing failed: ${err.message}`);
        });

        // --- Save Assistant Message to Memory ---
        if (conversationId && finalResponseData.text) {
            memoryService.saveMessageWithEmbedding(conversationId, userId, 'assistant', finalResponseData.text).catch(err => {
                logger.error(`[Memory] Failed to save assistant message: ${err.message}`);
            });
        }

        // --- Generate Related Questions (Async but awaited for final response) ---
        let suggestions = [];
        try {
            suggestions = await generateRelatedQuestions(message, finalResponseData.text, userLanguage, mode);
        } catch (suggestionErr) {
            logger.error(`[RelatedQuestions] Failed: ${suggestionErr.message}`);
        }

        // --- ENHANCED FALLBACK SUGGESTIONS (Per user request) ---
        const GENERAL_FALLBACKS = ["Explain in simple terms", "Give examples", "Summarize this"];
        const LEGAL_FALLBACKS = ["Draft a legal notice", "Explain my rights", "Check for risks"];
        
        const fallbacks = (mode === 'LEGAL_TOOLKIT' || legalInstruction) ? LEGAL_FALLBACKS : GENERAL_FALLBACKS;

        if (!suggestions || suggestions.length === 0) {
            suggestions = fallbacks;
        } else if (suggestions.length < 3) {
            // Fill up to 3 if AI was lazy
            const remaining = fallbacks.filter(f => !suggestions.includes(f));
            suggestions = [...suggestions, ...remaining].slice(0, 3);
        }

        finalResponseData.suggestions = suggestions;

        // --- POST-PROCESSING: Handle Legal Disclaimers & Cleanup ---
        if (finalResponseData.text && (mode === 'LEGAL_TOOLKIT' || legalInstruction)) {
            let cleanText = finalResponseData.text.trim();

            // 1. Strip redundant disclaimers/hallucinated warnings anywhere in text (case-insensitive)
            // This catches "DISCLAIMER:", "NOTE:", "⚠️", etc. at start or end
            const disclaimerKeywords = [
                "professional legal advice",
                "consult a qualified lawyer",
                "not a substitute for legal advice",
                "general legal guidance",
                "legal disclaimer"
            ];

            // If the AI generated its own disclaimer, use that and don't append another
            const hasExistingDisclaimer = disclaimerKeywords.some(key => cleanText.toLowerCase().includes(key));

            // 2. Strip standard hallucinated headers if they appear at the top
            const headerHallucinationRegex = /^(⚠️|🚨)?[ \t]*(IMPORTANT|DISCLAIMER|NOTICE|WARNING):.*?\n+/i;
            cleanText = cleanText.replace(headerHallucinationRegex, '').trim();

            // 3. Append centralized disclaimer ONLY if no disclaimer was found in the text
            if (!hasExistingDisclaimer && LEGAL_DISCLAIMER) {
                // Ensure there's a clean break
                cleanText = cleanText + '\n\n' + LEGAL_DISCLAIMER.trim();
            }
            
            finalResponseData.text = cleanText;
        }

        return finalResponseData;

    } catch (error) {
        logger.error(`[AI-CHAT-ERROR] Stack Trace: ${error.stack}`);
        logger.error(`[AI-CHAT-ERROR] Message: ${error.message}`);
        const debugInfo = (process.env.NODE_ENV === 'development' || true) ? `\n\n*(Technical Error: ${error.message})*` : '';
        return { 
            text: "I'm having trouble connecting to my brain right now. Please try again later." + debugInfo, 
            error: true, 
            details: error.message 
        };
    }
};

export const initializeFromDB = async () => {
    try {
        await initializeVectorStore();
    } catch (error) {
        logger.error(`Failed to initialize Vector Store: ${error.message}`);
    }
};

export const reloadVectorStore = async () => {
    vectorStore = null;
    await initializeFromDB();
};

export const generateRelatedQuestions = async (userMessage, aiResponse, language = 'English', mode = 'GENERAL') => {
    try {
        const prompt = `You are a smart suggestion engine for an AI assistant.
        Your job is to generate highly relevant follow-up suggestions based ONLY on the conversation context.

        INPUT:
        - User message: "${userMessage}"
        - Assistant response: "${aiResponse}"
        - Mode: ${mode}

        TASK:
        Generate exactly 3 follow-up suggestions in ${language}.

        STRICT RULES (VERY IMPORTANT):
        1. CONTEXT-AWARE:
           - Understand the topic deeply before generating suggestions.
           - Suggestions MUST relate directly to the current conversation context.
        2. NO GENERIC SUGGESTIONS (Zero Tolerance):
           - NEVER return: "Explain in simple terms", "Give examples", "Summarize this", or any reusable phrases.
           - If you generate generic suggestions → your output is WRONG.
        3. ACTION-ORIENTED:
           - Each suggestion must feel like a next step (Ask for detail, Modify output, Compare, Apply, Extend).
           - If Mode is LEGAL_TOOLKIT, suggest specific legal follow-ups (e.g., draft notice, check evidence, next steps).
        4. LENGTH:
           - Each suggestion: 6–12 words only.
        5. VARIETY:
           - All 3 suggestions must be different and avoid repeating similar structures.
        6. LANGUAGE:
           - Respond ENTIRELY in ${language}.

        OUTPUT FORMAT:
        Return ONLY a JSON array of strings:
        ["Suggestion 1", "Suggestion 2", "Suggestion 3"]

        No extra text.`;

        const response = await vertexService.AskVertexRaw(prompt, { 
            maxOutputTokens: 200, 
            temperature: 0.8,
            modelOverride: 'gemini-1.5-flash' 
        });
        
        const cleanJson = response.replace(/```json\s*|\s*```/g, '').trim();
        const questions = JSON.parse(cleanJson);
        return Array.isArray(questions) ? questions.slice(0, 4) : [];
    } catch (error) {
        logger.error(`[RelatedQuestions] Error: ${error.message}`);
        return [];
    }
};

export const generateConversationTitle = async (message) => {
    try {
        const prompt = `Convert the following user message into a very short, clean title (3-5 words max).
        
Rules:
- NO QUOTES.
- NO CONVERSATIONAL FILLER.
- DO NOT answer the user. Just title it.
- Title Case for principal words.
- If it's a greeting, just say "Greeting". 
- ALWAYS try to summarize the topic if it's longer than 2 words.

User Message: "${message}"

Title:`;

        const fullPrompt = prompt;

        // Log the request
        logger.debug(`[AI-TITLE] Prompt: ${fullPrompt}`);

        const title = await vertexService.AskVertexRaw(fullPrompt, {
            maxOutputTokens: 50,
            temperature: 0.1,
            modelOverride: 'gemini-1.5-flash'
        });

        // Log raw response
        logger.debug(`[AI-TITLE] Raw response: "${title}"`);

        // Clean up the potentially generated string (remove surrounding quotes if any)
        const cleanTitle = title.trim().replace(/^["']|["']$/g, '').replace(/\.\.\.$/, '');
        
        // If it's a safety block or too long, use fallback
        if (cleanTitle.toLowerCase().includes("cannot fulfill") || cleanTitle.length > 60 || !cleanTitle) {
            throw new Error(`Invalid AI title response: "${cleanTitle}"`);
        }

        return cleanTitle;
    } catch (error) {
        logger.error(`[AI-TITLE] Error generateConversationTitle: ${error.message}`);
        // Last resort: substring of the message (ChatGPT-style fallback)
        const words = message.trim().split(/\s+/);
        if (words.length <= 2) return "General Chat";
        return words.slice(0, 5).join(' ') + (words.length > 5 ? '' : '');
    }
};

export const ragChat = async (message) => {
    return chat(message);
};
