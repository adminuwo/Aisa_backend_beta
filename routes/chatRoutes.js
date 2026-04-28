import express from "express";
import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import ChatSession from "../models/ChatSession.js";
import { generativeModel, genAIInstance, modelName as primaryModelName } from "../config/vertex.js";
import userModel from "../models/User.js";
import Guest from "../models/Guest.js";
import { verifyToken, optionalVerifyToken } from "../middleware/authorization.js";
import { identifyGuest } from "../middleware/guestMiddleware.js";
import { upload } from "../services/cloudinary.service.js";
import { uploadToGCS, gcsFilename, getSignedUrl } from "../services/gcs.service.js";
import mammoth from "mammoth";
import { detectMode, getModeSystemInstruction } from "../utils/modeDetection.js";
import { detectIntent, extractReminderDetails, detectLanguage, getVoiceSystemInstruction } from "../utils/voiceAssistant.js";
import Reminder from "../models/Reminder.js";
import { requiresWebSearch, extractSearchQuery, processSearchResults, getWebSearchSystemInstruction, getCachedSearch, setCachedSearch } from "../utils/webSearch.js";
import { performWebSearch } from "../services/searchService.js";
import { convertFile } from "../utils/fileConversion.js";
import officeParser from 'officeparser';
import { generateVideoFromPrompt } from "../controllers/videoController.js";
import { generateImageFromPrompt } from "../controllers/image.controller.js";
import { generateFollowUpPrompts } from "../utils/imagePromptController.js";
import { executeImagePipeline, executeVideoPipeline } from "../services/generationPipeline.js";
import { selectVideoModel } from "../services/modelSelector.js";
import { getMemoryContext, extractUserMemory, updateMemory } from "../utils/memoryService.js";
import { subscriptionService, checkPremiumAccess } from '../services/subscriptionService.js';
import { retrieveContextFromRag, detectRAGNeed } from "../services/vertex.service.js";
import * as configService from "../services/configService.js";
import Knowledge from "../models/Knowledge.model.js";
import * as webSearchService from "../services/webSearch.service.js";
import * as deepSearchService from "../services/deepSearch.service.js";
import memoryService from "../services/memory.service.js";
import * as aiService from "../services/ai.service.js";
import axios from "axios";

const router = express.Router();

// Helper to check guest limits
const checkGuestLimits = async (req, sessionId) => {
  const guestId = req.guest?.guestId;
  if (!guestId && !req.user) return { allowed: true };

  if (req.user) return { allowed: true };

  const guest = await Guest.findOne({ guestId });
  if (!guest) return { allowed: true };

  const count = await ChatSession.countDocuments({ guestId });
  if (count >= 10) return { allowed: false, reason: "GUEST_LIMIT_REACHED" };

  return { allowed: true };
};

// --- CORE CHAT ENDPOINT ---
router.post("/", optionalVerifyToken, identifyGuest, async (req, res) => {
  const { content, history, systemInstruction, image, video, document, language, model, mode, sessionId, userMsgId, aiMsgId, aspectRatio, modelId: reqModelId, skipSession } = req.body;

  try {
    // 1. LIMIT & CREDIT CHECKS
    const limitCheck = await checkGuestLimits(req, sessionId);
    if (!limitCheck.allowed) {
      return res.status(403).json({ error: "LIMIT_REACHED", reason: limitCheck.reason });
    }

    let toolsRequested = ['chat'];
    if (mode === 'DEEP_SEARCH' || mode === 'web_search') toolsRequested.push(mode);
    if (mode === 'CODE_WRITER') toolsRequested.push('code_writer');
    if (mode === 'LEGAL_TOOLKIT') toolsRequested.push('legal_toolkit');
    if (document && (Array.isArray(document) ? document.length > 0 : document.base64Data)) toolsRequested.push('convert_document');

    if (req.user) {
      // Early Admin Bypass
      if (req.user.email && req.user.email.toLowerCase() === 'admin@uwo24.com') {
        console.log(`[Admin-Bypass] Granting immediate access to admin@uwo24.com`);
      } else {
        try {
          await subscriptionService.checkCredits(req.user.id || req.user._id, toolsRequested, req.body);
        } catch (subError) {
          return res.status(403).json({ success: false, code: subError.message === "PREMIUM_RESTRICTED" ? "PREMIUM_ONLY" : "OUT_OF_CREDITS", message: subError.message });
        }
      }
    }

    // 2. PRE-PROCESSING: Extract text from DOCX files (Gemini/Vertex AI does not support .docx natively)
    let activeDocContent = null;
    let filteredDocuments = document;
    
    if (document && Array.isArray(document) && document.length > 0) {
      const docTexts = [];
      const validDocs = [];
      
      for (const doc of document) {
        const isWord = doc.mimeType?.includes('word') || doc.name?.match(/\.(docx|doc)$/i);
        const isRtf = doc.mimeType?.includes('rtf') || doc.name?.match(/\.rtf$/i);
        
        if ((isWord || isRtf) && doc.base64Data) {
          try {
            const buffer = Buffer.from(doc.base64Data, 'base64');
            let extractedText = "";
            
            if (isWord) {
              const parser = (officeParser && officeParser.parseOfficeAsync) ? officeParser : (officeParser?.default || officeParser);
              try {
                if (parser && typeof parser.parseOfficeAsync === 'function') {
                  extractedText = await parser.parseOfficeAsync(buffer);
                } else {
                  throw new Error("officeParser not properly loaded");
                }
              } catch (officeErr) {
                console.warn("[Mammoth Fallback] officeparser failed or not loaded:", officeErr.message);
                const result = await mammoth.extractRawText({ buffer });
                extractedText = result.value;
              }
            } else if (isRtf) {
               // Basic RTF to Text Regex extraction
               const rtfContent = buffer.toString('utf-8');
               extractedText = rtfContent
                 .replace(/\\([a-z]{1,32})(-?\d+)? ?/g, '') // Strip RTF keywords
                 .replace(/\{[^}]+\}/g, '') // Strip RTF groups
                 .replace(/\r?\n/g, ' ') // Flatten newlines
                 .trim();
            }
            
            if (extractedText) {
              docTexts.push(`[${isRtf ? 'RTF' : 'Word'} Document Content: ${doc.name || 'Untitled'}]\n${extractedText}`);
            }
          } catch (mErr) {
            console.error("[Document Extraction Error]", mErr);
          }
        } else {
          validDocs.push(doc);
        }
      }
      
      if (docTexts.length > 0) {
        activeDocContent = docTexts.join('\n\n---\n\n');
      }
      filteredDocuments = validDocs;
    }

    // 3. UNIFIED AI SERVICE CALL
    const chatResponse = await aiService.chat(content, activeDocContent, {
      systemInstruction,
      mode,
      images: image,
      documents: filteredDocuments,
      userName: req.user?.name,
      language,
      conversationId: sessionId,
      userId: req.user?.id || req.user?._id,
      model,
      history
    });

    let reply = chatResponse.text || "";
    let isWebSearchResponse = chatResponse.isRealTime || false;
    let searchSources = chatResponse.sources || [];
    let detectedMode = mode || chatResponse.mode || 'CHAT';

    // 3. POST-PROCESSING: MAGIC TOOLS EXECUTION
    const finalResponse = {
      reply,
      detectedMode,
      isRealTime: isWebSearchResponse,
      sources: searchSources,
      language: language || 'English',
      suggestions: chatResponse.suggestions || []
    };

    try {
      let data = { action: 'chat', reply: reply };
      const jsonMatch = reply.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          data = JSON.parse(jsonMatch[0]);
          reply = (reply.replace(jsonMatch[0], '').trim()) || "Action processed.";
        } catch (e) { /* ignore parse error */ }
      }

      if (data.action === 'generate_image' && data.prompt) {
        try {
            const pipelineResult = await executeImagePipeline(
                data.prompt,
                async (finalPrompt, activeModel) => {
                    return await generateImageFromPrompt(finalPrompt, null, aspectRatio || '1:1', activeModel);
                },
                { modelId: reqModelId || 'gemini-2.5-flash-image', enhance: true }
            );
            
            if (pipelineResult.url) {
                finalResponse.imageUrl = pipelineResult.url;  
                finalResponse.reply = reply;

                // 🧠 Generate Smart Prompts for the Image
                const followUpPrompts = await generateFollowUpPrompts(data.prompt, pipelineResult.url).catch(() => []);
                finalResponse.suggestions = followUpPrompts;
            }
        } catch (pipeErr) {
            console.error("[MediaGen] generate_image pipeline error:", pipeErr);
        }
      } else if (data.action === 'modify_image' && data.prompt) {
        let sourceImage = (Array.isArray(image) && image.length > 0) ? image[0] : (image || null);
        if (sourceImage) {
          try {
            const pipelineResult = await executeImagePipeline(
                data.prompt,
                async (finalPrompt, activeModel) => {
                    return await generateImageFromPrompt(finalPrompt, sourceImage, aspectRatio || '1:1', activeModel);
                },
                { modelId: reqModelId || 'gemini-2.5-flash', enhance: true }
            );

            if (pipelineResult.url) {
              finalResponse.imageUrl = pipelineResult.url;
              finalResponse.reply = reply;

              // 🧠 Generate Smart Prompts for the Edited Image
              const followUpPrompts = await generateFollowUpPrompts(data.prompt, pipelineResult.url).catch(() => []);
              finalResponse.suggestions = followUpPrompts;
            }
          } catch (pipeErr) {
              console.error("[MediaGen] modify_image pipeline error:", pipeErr);
          }
        }
      } else if (data.action === 'generate_video' && data.prompt) {
        try {
          const resolvedVideoModel = selectVideoModel(reqModelId, 'fast', req.user?.isPremium || false);
          const pipelineResult = await executeVideoPipeline(
            data.prompt,
            async (refinedPrompt, activeModel) => {
              return await generateVideoFromPrompt(refinedPrompt, 5, 'fast', '16:9', activeModel, '1080p');
            },
            { modelId: resolvedVideoModel, enhance: true }
          );
          if (pipelineResult?.url) {
            finalResponse.videoUrl = pipelineResult.url;
            finalResponse.reply = reply;
          }
        } catch (videoErr) {
          console.error('[MediaGen] generate_video pipeline error:', videoErr);
        }
      } else if (data.action === 'file_conversion' && (image || document)) {
        try {
          const docToConvert = (Array.isArray(document) ? document[0] : document) || (Array.isArray(image) ? image[0] : image);
          
          if (docToConvert && docToConvert.base64Data) {
            const buffer = Buffer.from(docToConvert.base64Data, 'base64');
            const sourceFormat = data.source_format || (docToConvert.mimeType?.includes('pdf') ? 'pdf' : 'docx');
            const targetFormat = data.target_format || (sourceFormat === 'pdf' ? 'docx' : 'pdf');
            
            const convertedBuffer = await convertFile(buffer, sourceFormat, targetFormat);
            
            if (convertedBuffer) {
              finalResponse.conversion = {
                file: convertedBuffer.toString('base64'),
                fileName: `aisa_converted_${Date.now()}.${targetFormat}`,
                mimeType: targetFormat === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              };
              finalResponse.reply = `I have successfully converted **${docToConvert.name || 'your file'}** to **${targetFormat.toUpperCase()}** format. 📄 You can download it using the icon above.`;
            }
          }
        } catch (convErr) {
          console.error("[FILE CONVERSION ERROR]", convErr);
          finalResponse.reply = reply + `\n\n*(Error: Conversion failed - ${convErr.message})*`;
        }
      }
    } catch (e) {
      console.warn("[MediaGen] Setup failed", e);
    }

    finalResponse.reply = finalResponse.reply || reply;

    // 4. SESSION MANAGEMENT
    // skipSession=true means this is an internal call (e.g. follow-up suggestions) — never persist to DB
    if (skipSession) {
      return res.status(200).json(finalResponse);
    }

    console.log(`[BACKEND-CHAT] Session ID: ${sessionId} | Content Len: ${content?.length}`);
    let session = await ChatSession.findOne({ sessionId });
    const isGenericTitle = !session ||
      session.title === "New Chat" ||
      session.title === "Greeting" ||
      session.title === "General Chat" ||
      (session.title && session.title.includes('...'));
      
    console.log(`[BACKEND-CHAT] Session found: ${!!session} | Generic Title: ${isGenericTitle} | Title: ${session?.title}`);
    const userId = req.user ? req.user.id : null;

    if (!session) {
      const aiTitle = await aiService.generateConversationTitle(content);
      session = new ChatSession({
        sessionId: sessionId || `temp_${Date.now()}`,
        userId: userId || null,
        guestId: req.guest?.guestId || null,
        projectId: (req.body.projectId === 'default' || req.body.projectId === 'all') ? null : (req.body.projectId || null),
        title: aiTitle || "New Chat",
        messages: []
      });
      if (userId) await userModel.findByIdAndUpdate(userId, { $addToSet: { chatSessions: session._id } });
    } else if (session && isGenericTitle) {
      const aiTitle = await aiService.generateConversationTitle(content);
      if (aiTitle) session.title = aiTitle;
      session.lastModified = Date.now();
      await session.save();
      finalResponse.title = session.title;
      finalResponse.sessionId = session.sessionId;
    }

    // 5. ATOMIC DB SYNC (Critical Fallback for Chat Persistence)
    // Check if user message already pushed by frontend sync endpoint to prevent duplicates
    const hasUserMsg = session.messages.some(m => m.id === userMsgId || (m.role === 'user' && m.content === content));
    if (!hasUserMsg) {
      session.messages.push({
        id: userMsgId || `be_${Date.now()}`,
        role: 'user',
        content: content || (image ? "Image interaction" : "Action"),
        timestamp: Date.now()
      });
    }

    // Always push the AI response generated in this turn
    session.messages.push({
      id: aiMsgId || `be_ai_${Date.now() + 1}`,
      role: 'model',
      content: finalResponse.reply || "Thinking...",
      timestamp: Date.now() + 1,
      isRealTime: finalResponse.isRealTime,
      sources: finalResponse.sources,
      imageUrl: finalResponse.imageUrl,
      videoUrl: finalResponse.videoUrl,
      conversion: finalResponse.conversion,
      suggestions: finalResponse.suggestions
    });

    session.lastModified = Date.now();
    await session.save();
    finalResponse.title = session.title;
    finalResponse.sessionId = session.sessionId;

    const finalUserId = req.user?.id || req.user?._id;
    if (finalUserId) {
        // Skip deduction for admin
        if (!(req.user.email && req.user.email.toLowerCase() === 'admin@uwo24.com')) {
            await subscriptionService.deductCredits(finalUserId, toolsRequested, sessionId, req.body);
        }
    }

    return res.status(200).json(finalResponse);

  } catch (err) {
    if (mongoose.connection.readyState !== 1) {
      return res.status(200).json({ reply: "dbDemoModeMessage", detectedMode: 'NORMAL_CHAT' });
    }
    console.error("Interaction failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- SESSION LIST ---
router.get('/', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const userId = req.user?.id;
    const guestId = req.guest?.guestId;

    if (!userId && !guestId) return res.json([]);
    if (mongoose.connection.readyState !== 1) return res.json([]);

    let sessions = [];
    const projectId = req.query.projectId;

    if (userId) {
      const query = { userId: userId };
      if (projectId && projectId !== 'null' && projectId !== 'undefined' && projectId !== 'default' && projectId !== 'all') {
        query.projectId = projectId;
      } else {
        // If no projectId or 'null', return chats where projectId is null or doesn't exist
        query.projectId = { $in: [null, undefined] };
      }

      sessions = await ChatSession.find(query)
        .select('sessionId title lastModified userId projectId')
        .sort({ lastModified: -1 });
    } else if (guestId) {
      sessions = await ChatSession.find({ guestId: guestId })
        .select('sessionId title lastModified guestId')
        .sort({ lastModified: -1 });
    }
    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// --- SESSION HISTORY ---
router.get('/:sessionId', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id || req.user?._id;
    const guestId = req.guest?.guestId;

    if (mongoose.connection.readyState !== 1) return res.json({ sessionId, messages: [] });

    let session = await ChatSession.findOne({ sessionId });
    if (!session) return res.status(404).json({ message: 'Session not found' });

    // Ownership check
    if (userId) {
      const currentUserId = userId.toString();
      if (session.userId && session.userId.toString() !== currentUserId) {
        console.warn(`[AUTH] Access denied for user ${currentUserId} on session ${sessionId} owned by ${session.userId}`);
        return res.status(403).json({ error: "Access denied" });
      }
      
      // Auto-claim unowned sessions if logged in
      if (!session.userId) {
        console.log(`[AUTH] User ${currentUserId} claiming unowned guest session ${sessionId}`);
        session.userId = userId;
        await session.save();
        await userModel.findByIdAndUpdate(userId, { $addToSet: { chatSessions: session._id } });
      }
    } else if (guestId) {
      if (session.guestId && session.guestId !== guestId) {
         console.warn(`[AUTH] Access denied for guest ${guestId} on session ${sessionId} owned by guest ${session.guestId}`);
         return res.status(403).json({ error: 'Access denied' });
      }
    }

    if (session) {
      // 🔄 Dynamic Re-signing of expired media URLs
      // This ensures that images/videos stored with ephemeral 6-hour URLs are refreshed on load
      let needsSave = false;
      const bucketName = 'aisa_objects';

      for (let msg of session.messages) {
        // Refreash Image URLs
        if (msg.imageUrl && msg.imageUrl.includes(bucketName)) {
           // Extract path: everything between 'aisa_objects/' and the '?' (if present) or end of string
           const pathPart = msg.imageUrl.split(`${bucketName}/`)[1]?.split('?')[0];
           if (pathPart) {
             const newUrl = await getSignedUrl(decodeURIComponent(pathPart));
             if (newUrl !== msg.imageUrl) {
               msg.imageUrl = newUrl;
               needsSave = true;
             }
           }
        }
        // Refresh Video URLs
        if (msg.videoUrl && msg.videoUrl.includes(bucketName)) {
           const pathPart = msg.videoUrl.split(`${bucketName}/`)[1]?.split('?')[0];
           if (pathPart) {
             const newUrl = await getSignedUrl(decodeURIComponent(pathPart));
             if (newUrl !== msg.videoUrl) {
               msg.videoUrl = newUrl;
               needsSave = true;
             }
           }
        }
      }

      if (needsSave) {
        await session.save();
      }
    }

    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// --- GENERATE CONVERSATION TITLE ---
router.post('/:sessionId/generate-title', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { message } = req.body;

    if (!message) return res.status(400).json({ error: 'Message is required' });

    const title = await aiService.generateConversationTitle(message);
    if (!title) return res.status(500).json({ error: 'Failed to generate title' });

    const session = await ChatSession.findOne({ sessionId });
    if (session) {
      session.title = title;
      session.lastModified = Date.now();
      await session.save();
    }

    res.json({ title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate title' });
  }
});

// --- ADD MESSAGE MANUALLY (SYNC FROM FRONTEND) ---
router.post('/:sessionId/message', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { message, title } = req.body;
    const userId = req.user?.id;
    const guestId = req.guest?.guestId;

    if (!message) return res.status(400).json({ error: 'Message is required' });

    let session = await ChatSession.findOne({ sessionId });

    if (!session) {
      // Create new session if it doesn't exist
      session = new ChatSession({
        sessionId,
        userId: userId || null,
        guestId: guestId || null,
        projectId: (req.body.projectId === 'default' || req.body.projectId === 'all') ? null : (req.body.projectId || null),
        title: title || "New Chat",
        messages: []
      });
      if (userId) await userModel.findByIdAndUpdate(userId, { $addToSet: { chatSessions: session._id } });
    } else {
      // Ownership check for existing session
      if (userId) {
        const currentUserId = userId.toString();
        if (session.userId && session.userId.toString() !== currentUserId) {
          return res.status(403).json({ error: 'Access denied' });
        }
      } else if (guestId) {
        if (session.guestId && session.guestId !== guestId) return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Upsert message
    const existingIndex = session.messages.findIndex(m => m.id === message.id || (m._id && m._id.toString() === message.id));
    if (existingIndex !== -1) {
      session.messages[existingIndex] = { ...session.messages[existingIndex].toObject(), ...message, timestamp: message.timestamp || Date.now() };
    } else {
      session.messages.push({ ...message, timestamp: message.timestamp || Date.now() });
    }

    if (title && title !== "New Chat" && session.title === "New Chat") {
      session.title = title;
    }

    session.lastModified = Date.now();
    await session.save();

    res.json({ success: true, message: 'Message synced successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to sync message' });
  }
});

// --- DELETE MESSAGE ---
router.delete('/:sessionId/message/:messageId', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { sessionId, messageId } = req.params;
    const userId = req.user?.id;
    const guestId = req.guest?.guestId;

    const session = await ChatSession.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Ownership check
    if (userId) {
      if (session.userId && session.userId.toString() !== userId) return res.status(403).json({ error: 'Access denied' });
    } else if (guestId) {
      if (session.guestId !== guestId) return res.status(403).json({ error: 'Access denied' });
    }

    await ChatSession.findOneAndUpdate(
      { sessionId },
      { $pull: { messages: { _id: messageId } } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// --- RENAME SESSION ---
router.patch('/:sessionId/title', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title } = req.body;
    const userId = req.user?.id;
    const guestId = req.guest?.guestId;

    if (!title) return res.status(400).json({ error: 'Title is required' });

    const session = await ChatSession.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Ownership check
    if (userId) {
      if (session.userId && session.userId.toString() !== userId) return res.status(403).json({ error: 'Access denied' });
    } else if (guestId) {
      if (session.guestId !== guestId) return res.status(403).json({ error: 'Access denied' });
    }

    session.title = title;
    session.lastModified = Date.now();
    await session.save();

    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to rename session' });
  }
});

// --- DELETE SESSION ---
router.delete('/:sessionId', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id;
    const guestId = req.guest?.guestId;

    const session = await ChatSession.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Ownership check
    if (userId) {
      if (session.userId && session.userId.toString() !== userId) return res.status(403).json({ error: 'Access denied' });
    } else if (guestId) {
      if (session.guestId !== guestId) return res.status(403).json({ error: 'Access denied' });
    }

    await ChatSession.deleteOne({ sessionId });
    if (userId) {
      await userModel.findByIdAndUpdate(userId, { $pull: { chatSessions: session._id } });
    }
    res.json({ message: 'History cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// --- SHARE SESSION ---
router.post('/:sessionId/share', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id || req.user?._id;
    const guestId = req.guest?.guestId;
 
    const session = await ChatSession.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: 'Session not found' });
 
    // Ownership check
    if (userId) {
      const currentUserId = userId.toString();
      if (session.userId && session.userId.toString() !== currentUserId) {
        console.warn(`[SHARE] Access denied for user ${currentUserId} on session ${sessionId} owned by ${session.userId}`);
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Auto-claim session if unowned
      if (!session.userId) {
        console.log(`[SHARE] User ${currentUserId} claiming unowned session ${sessionId} during share`);
        session.userId = userId;
        session.guestId = null; // Clean up guest ref
      }
    } else if (guestId) {
      if (session.guestId && session.guestId !== guestId) {
        console.warn(`[SHARE] Access denied for guest ${guestId} on session ${sessionId} owned by guest ${session.guestId}`);
        return res.status(403).json({ error: 'Access denied' });
      }
    }
 
    if (!session.shareId) {
      session.shareId = uuidv4();
    }
    session.isShared = true;
    await session.save();
 
    res.json({ success: true, shareId: session.shareId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to share session' });
  }
});

// --- SHARE SESSION VIA EMAIL (INTEGRATED) ---
router.post('/:sessionId/share/email', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { targetEmail, shareLink, title } = req.body;
    const userId = req.user?.id || req.user?._id;
    const guestId = req.guest?.guestId;

    if (!targetEmail || !shareLink) {
      return res.status(400).json({ error: 'Target email and share link are required' });
    }

    const session = await ChatSession.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Ownership check
    if (userId) {
      const currentUserId = userId.toString();
      if (session.userId && session.userId.toString() !== currentUserId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } else if (guestId) {
      if (session.guestId && session.guestId !== guestId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { sendShareLinkEmail } = await import('../services/emailService.js');
    const senderName = req.user?.name || "A user";
    
    const result = await sendShareLinkEmail(targetEmail, shareLink, title || session.title, senderName);
    
    if (result.success) {
      res.json({ success: true, message: 'Share link sent successfully via email' });
    } else {
      res.status(500).json({ error: 'Failed to send email', details: result.error });
    }
  } catch (err) {
    console.error('[EMAIL SHARE ERROR]', err);
    res.status(500).json({ error: 'Shared email failed' });
  }
});

 
// --- DUPLICATE SHARED SESSION ---
router.post('/duplicate', optionalVerifyToken, identifyGuest, async (req, res) => {
  try {
    const { shareId } = req.body;
    const userId = req.user?.id || req.body.userId; // Fallback to body userId if token missing
    const guestId = req.guest?.guestId;

    console.log(`[DUPLICATE REQUEST] shareId: ${shareId}, userId: ${userId}`);

    if (!shareId) return res.status(400).json({ error: 'shareId is required' });

    // Find the source session
    const sourceSession = await ChatSession.findOne({ shareId, isShared: true });
    if (!sourceSession) {
      console.warn(`[DUPLICATE] Source chat not found for shareId: ${shareId}`);
      return res.status(404).json({ error: 'Source chat not found' });
    }

    // Create a new session for the current user/guest
    const newSessionId = uuidv4();
    
    // Safety check for messages
    const messagesToClone = Array.isArray(sourceSession.messages) ? sourceSession.messages : [];
    
    // Copy and transform messages
    const clonedMessages = messagesToClone.map(m => ({
      id: uuidv4(),
      role: m.role || 'assistant',
      content: m.content || m.text || " ", // Ensure non-empty string for required field
      timestamp: Date.now(),
      mode: m.mode,
      isRealTime: m.isRealTime || false,
      sources: m.sources || [],
      attachments: m.attachments || []
    }));

    const newSession = new ChatSession({
      sessionId: newSessionId,
      userId: userId || null,
      guestId: userId ? null : (guestId || uuidv4()),
      title: sourceSession.title || 'New Chat',
      projectId: sourceSession.projectId || null,
      messages: clonedMessages,
      detectedMode: sourceSession.detectedMode || 'NORMAL_CHAT',
      lastModified: Date.now()
    });

    await newSession.save();

    // If user is logged in, link to their profile
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      await userModel.findByIdAndUpdate(userId, { $push: { chatSessions: newSession._id } });
    }

    console.log(`[DUPLICATE] Success: ${shareId} -> ${newSessionId} (${clonedMessages.length} messages)`);
    res.json({ success: true, sessionId: newSessionId });
  } catch (err) {
    console.error("[DUPLICATE ERROR]", err);
    res.status(500).json({ error: 'Failed to duplicate chat', details: err.message });
  }
});

// --- GET SHARED SESSION (PUBLIC) ---
router.get('/share/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;
    console.log(`[SHARE] Accessing shared chat: ${shareId}`);
 
    const session = await ChatSession.findOne({ shareId });
    if (!session || !session.isShared) {
      return res.status(404).json({ error: 'Shared chat not found' });
    }
 
    // Return only necessary fields for public view
    const publicSession = {
      title: session.title,
      messages: session.messages,
      lastModified: session.lastModified,
      detectedMode: session.detectedMode
    };
 
    res.json(publicSession);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shared chat' });
  }
});

// --- PDF UPLOAD ---
router.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF provided' });
    const result = await uploadToGCS(req.file.buffer, {
      folder: 'aisa_pdfs',
      filename: gcsFilename('aisa_pdf', 'pdf'),
      mimeType: 'application/pdf',
    });
    return res.status(200).json({ url: result.publicUrl });
  } catch (err) {
    console.error('[PDF UPLOAD ERROR]', err);
    return res.status(500).json({ error: 'PDF upload failed' });
  }
});

export default router;
