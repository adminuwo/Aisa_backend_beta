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
import { getLegalPrompt, LEGAL_DISCLAIMER } from './legal/legalPrompts.js';


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
    let finalResponseData = { text: "" };
    try {
        if (!message || typeof message !== 'string') {
            message = String(message || "");
        }

        const { systemInstruction, mode, images, documents, userName, language, conversationId, userId, model, history, toolName } = options;

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
            toolRestrictions = "\n\n### MODE: IMAGE GENERATION ENABLED. You can generate images using JSON action strictly if explicitly asked.";
        } else if (isActuallyVideoMode) {
            toolRestrictions = "\n\n### MODE: VIDEO GENERATION ENABLED. You can generate videos using JSON action strictly if explicitly asked.";
        } else if (isActuallySearchMode) {
            toolRestrictions = "\n\n### MODE: WEB SEARCH ENABLED. Answer based on real-time data.";
        } else if (isActuallyCodeMode) {
            toolRestrictions = `
\n\n### MODE: CODE WRITER ENABLED.
- ROLE: You are an expert Software Architect and Senior Lead Developer. Your goal is to provide highly structured, technical, and implementation-ready architecture.
- FORMATTING OVERRIDE: Ignore general rules about "Using bullet points for lists" when displaying project structures.
- UNIFIED TREE: You MUST display the entire project/folder architecture inside ONE SINGLE markdown code block using a visual tree format (e.g., \`\`\`text).
- CODE SNIPPETS: Wrap ALL code snippets in proper multi-line markdown code blocks with the correct language tag.
- NO INLINE PATHS: Do not use single backticks for file names inside paragraphs if they are part of a structure.
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
- CLEAN OUTPUT: Provide the unified Directory Tree first, then explain specific components or code snippets below the tree.
`;
        } else if (isActuallyConvertMode) {
            toolRestrictions = "\n\n### MODE: FILE CONVERSION ENABLED. You can extract data or convert between formats.";
        } else if (mode === 'LEGAL_TOOLKIT') {
            toolRestrictions = "\n\n### MODE: LEGAL SYSTEM ACTIVE. You are a Senior Legal Assistant specialist. Provide professional, structured legal guidance based on Indian Law unless otherwise specified. DO NOT include any legal disclaimers, warnings, or professional advice notices. The system will append these automatically.";
        } else {

            toolRestrictions = "\n\n### MODE: NORMAL CHAT. Strictly avoid executing magic actions. Answer questions using text only. If the user wants to generate media, tell them to use the AISA Magic Tools menu.";
        }

        // --- INTENT CLASSIFICATION (NEW: STOCK & LEGAL SMART) ---
        let classification = null;
        let legalInstruction = "";
        try {
            // Build simple conversation summary for classifier
            const chatSummary = (combinedHistory || []).slice(-3).map(m => `${m.role}: ${m.content || m.text}`).join(' | ');
            classification = await classifyIntent(message, images || documents || [], chatSummary);
            
            // 1. LEGAL SMART ROUTING
            if (classification && classification.intent && classification.intent.startsWith('legal_')) {
                // Only apply specialized prompt if we aren't ALREADY in LEGAL_TOOLKIT mode with this tool
                const isRedundant = mode === 'LEGAL_TOOLKIT' && (toolName === classification?.intent);
                if (!isRedundant) {
                   logger.info(`[AI-Service] Legal Intent Detected: ${classification.intent}. Applying specialized prompts.`);
                   legalInstruction = `\n\n### SPECIALIZED LEGAL TOOL: ${classification.intent}\n${getLegalPrompt(classification.intent)}`;
                }
            }
        } catch (intentErr) {
            logger.warn(`[AI-Service] Intent classification failed: ${intentErr.message}`);
        }

        // --- INTENT-BASED TOOL ROUTING (NEW: STOCKS) ---
        if (classification && (classification.intent === 'stock_researcher' || classification.tools?.includes('stock_researcher'))) {
            logger.info(`[AI-Service] Stock Researcher intent detected. Triggering Snapshot...`);
            
            // Try to extract symbol from metadata or message
            let symbol = classification.metadata?.stock_symbol || null;
            if (!symbol) {
                // Secondary extraction: find words in CAPS like RELIANCE, TCS, AAPL
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
                    return finalResponseData;
                }
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
            const docCount = await Knowledge.countDocuments();
            let ragContext = null;
            let rewrittenQuery = message;
            let hasCompanyKeyword = false;
            let needsRAG = false;

            const manualCorpusId = process.env.VERTEX_RAG_CORPUS_ID;
            if (docCount > 0 || manualCorpusId) {
                // Step 0: Robust Detection (Only use RAG for company-specific or capability queries)
                const lowerMsg = message.toLowerCase().trim();
                const companyKeywords = ['uwo', 'aisa', 'ai mall', 'unified web', 'what can you do', 'your features', 'your capabilities', 'who are you', 'how can you help', 'tell me about your services'];
                const generalPhrases = ['what is', 'how to', 'explain', 'define', 'meaning of', 'tell me about', 'why is', 'suggest', 'give me', 'who is'];
                
                // If it looks like a general question and lacks company keywords, SKIP RAG immediately (No Resources)
                hasCompanyKeyword = companyKeywords.some(k => lowerMsg.includes(k));
                const startsWithGeneral = generalPhrases.some(p => lowerMsg.startsWith(p));
                
                logger.info(`[RAG-Logic] Msg: "${lowerMsg}" | hasKeyword: ${hasCompanyKeyword} | startsGen: ${startsWithGeneral}`);

                if (mode === 'LEGAL_TOOLKIT' || legalInstruction) {
                    needsRAG = true;
                    logger.info(`[RAG-Logic] LEGAL MODE detected. Forcing RAG.`);
                } else if (hasCompanyKeyword) {
                    needsRAG = true; // High confidence it's about the company or its abilities
                    logger.info(`[RAG-Logic] Decision: YES (Keyword/Capability match) for: "${lowerMsg}"`);
                } else if (startsWithGeneral && !hasCompanyKeyword) {
                    // USER REQUIREMENT: Normal questions like "What is..." should NEVER trigger RAG unless brands are mentioned.
                    needsRAG = false;
                    logger.warn(`[RAG-Logic] FORCED NO for generic question: "${lowerMsg}"`);
                } else {
                    // Ambiguous - ask the AI detector for a decision
                    needsRAG = await vertexService.detectRAGNeed(message);
                    logger.info(`[RAG-Logic] Decision: ${needsRAG ? 'YES' : 'NO'} (AI Detector) for: "${lowerMsg}"`);
                }

                if (needsRAG) {
                    // Step 1: Query Rewriting
                    rewrittenQuery = await vertexService.rewriteQuery(message);
                    
                    // Step 2: Retrieval using Rewritten Query and Category Isolation
                    const targetCategory = (mode === 'LEGAL_TOOLKIT' || legalInstruction) ? 'LEGAL' : 'GENERAL';
                    logger.info(`[RAG-Logic] Target Category: ${targetCategory}`);
                    
                    ragContext = await vertexService.retrieveContextFromRag(rewrittenQuery, 8, targetCategory);
                    
                    // Step 3: Strict Isolation Rule (Relaxed: allow fallback if no context found)
                    if (needsRAG && !ragContext) {
                        logger.warn(`[RAG-Logic] No context found for ${targetCategory}. Allowing fallback to general model.`);
                    }

                    
                    // --- Step 3: Logging (Optional but requested) ---
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
            suggestions = await generateRelatedQuestions(message, finalResponseData.text, userLanguage);
        } catch (suggestionErr) {
            logger.error(`[RelatedQuestions] Failed: ${suggestionErr.message}`);
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
        return { 
            text: "I'm having trouble connecting to my brain right now. Please try again later.", 
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

export const generateRelatedQuestions = async (userMessage, aiResponse, language = 'English') => {
    try {
        const prompt = `Based on the following conversation, generate 3 follow-up questions that the user might want to ask next.
        
User Message: "${userMessage}"
AI Response: "${aiResponse}"

Rules:
- Questions must be relevant and helpful.
- Language: Respond in ${language}.
- Format: Return ONLY a JSON array of 3 strings.
- Example: ["Question 1?", "Question 2?", "Question 3?"]`;

        const response = await vertexService.AskVertexRaw(prompt, { 
            maxOutputTokens: 150, 
            temperature: 0.7 
        });
        
        const cleanJson = response.replace(/```json\s*|\s*```/g, '').trim();
        const questions = JSON.parse(cleanJson);
        return Array.isArray(questions) ? questions.slice(0, 3) : [];
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
            temperature: 0.1
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
