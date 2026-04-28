import logger from '../utils/logger.js';
import * as vertexService from './vertex.service.js';
import { AskOpenAIRaw } from './openai.service.js';
import { AskVertexRaw } from './vertex.service.js';
import * as socialAgentService from './socialAgent.service.js';
import SocialAgentWorkspace from '../models/SocialAgentWorkspace.js';
import BrandProfile from '../models/BrandProfile.js';
import ContentCalendar from '../models/ContentCalendar.js';
import CalendarEntry from '../models/CalendarEntry.js';
import PlanUsage from '../models/PlanUsage.js';
import GeneratedPost from '../models/GeneratedPost.js';
import GeneratedAsset from '../models/GeneratedAsset.js';
import GenerationJob from '../models/GenerationJob.js';
import GenerationPromptLog from '../models/GenerationPromptLog.js';
import mongoose from 'mongoose';
import { generateImageFromPrompt } from '../controllers/image.controller.js';
import { GoogleGenAI, Modality } from '@google/genai';
import axios from 'axios';
import { uploadToGCS, gcsFilename } from './gcs.service.js';
import sharp from 'sharp';

// --- JSON RECOVERY SYSTEM ---
function safeParse(content) {
  if (!content || typeof content !== 'string') return typeof content === 'object' ? content : [];
  
  let clean = content.replace(/```json\s*|\s*```/g, '').trim();

  // Step 1: Regex-based extraction (more robust than basic indexOf/lastIndexOf)
  // Look for the outermost {} or [] pair
  const jsonRegex = /({[\s\S]*}|\[[\s\S]*\])/;
  const match = clean.match(jsonRegex);
  
  if (match) {
    const candidate = match[0].trim();
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // Proceed to aggressive fixing if match exists but is slightly broken
      clean = candidate;
    }
  }

  try {
    return JSON.parse(clean);
  } catch (e) {
    logger.warn(`[JSON Fixer] Standard parse failed (${e.message}). Attempting recovery...`);
    
    try {
      // Step 2: Fix trailing commas, quotes and control characters
      let aggressive = clean
        .replace(/,\s*}/g, "}") 
        .replace(/,\s*]/g, "]") 
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); 
      
      // Fix unescaped newlines in strings
      aggressive = aggressive.replace(/(?<=[:\s])"(.*?)"(?=[,\s}])|(?<=\[)"(.*?)"(?=[,\s\]])/gs, (match) => {
         return match.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
      });

      return JSON.parse(aggressive);
    } catch (lastE) {
      // Step 3: Handle truncation and unterminated strings
      let truncated = clean;
      
      const quotes = (truncated.match(/(?<!\\)"/g) || []).length;
      if (quotes % 2 !== 0) truncated += '"';

      let temp = truncated;
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

      // Final attempt: If there's garbage AFTER a valid JSON object, find the FIRST valid object
      // This solves the 'Unexpected non-whitespace character' error
      if (lastE.message.includes('Unexpected non-whitespace character')) {
        for (let j = clean.length - 1; j > 0; j--) {
          if (clean[j] === '}' || clean[j] === ']') {
            try {
              return JSON.parse(clean.substring(0, j + 1));
            } catch (f) { /* continue */ }
          }
        }
      }
      
      console.error("[JSON Fixer] CRITICAL FAILURE. Raw content that failed parse:", content);
      logger.error(`[JSON Recovery] Final attempt failed. Raw sample: ${content?.substring(0, 200)}...`);
      throw new Error(`AI response invalid: ${lastE.message}`);
    }
  }
}

// --- PROMPT TEMPLATES ---
const PROMPTS = {
  CONTEXT_DISTILLATION: (brand) => `
    You are a Senior Brand Strategist. Distill the following brand profile into a dense "Marketing Core".
    BRAND: ${brand.companyName || 'Our Brand'}
    TONE: ${brand.toneOfVoice || brand.structuredIdentity?.tone || 'Professional'}
    CORE OBJECTIVES: ${brand.contentObjective || 'Awareness'}
    KNOWLEDGE BASE: ${brand.extractedBrandSummary || brand.companyOverviewText || 'N/A'}
    IDENTITY: ${JSON.stringify(brand.structuredIdentity)}
    
    OUTPUT JSON:
    {
      "persona": "Core vibe",
      "voiceGuidelines": ["rule1", "rule2"],
      "visualDirectives": "Image theme",
      "primaryHashtags": ["tag1", "tag2"]
    }
  `,

  COPY_GENERATION: (context, entry, platform) => `
    You are an expert Social Media Copywriter and Growth Strategist for ${platform}.
    Create a highly engaging post based on this strategy row:
    TOPIC: ${entry.title || entry.heading_hook || 'Update'}
    CONTEXT: ${JSON.stringify(context)}
    STRATEGY: ${entry.phase} - ${entry.format}
    
    OUTPUT JSON (STRICT):
    {
      "hook": "Master CTA-optimized hook",
      "captionShort": "Concise version",
      "captionLong": "Deep educational/storytelling version",
      "cta": "Primary call to action",
      "hashtags": ["A comprehensive array of 30 hashtags: 10 industry-wide, 10 niche-community, 10 viral-action"],
      "onAssetText": "Key text for the visual",
      "variations": [
        { "type": "Storytelling Angle", "text": "Hook + Story + CTA" },
        { "type": "Hook-Centric / Problem", "text": "Problem + Solution + CTA" },
        { "type": "Direct / Educational", "text": "Tip 1, 2, 3 + CTA" }
      ]
    }
  `,

  REGENERATE_WITH_INTENT: (original, intent) => `
    Regenerate this social post focusing on: "${intent}".
    ORIGINAL HOOK: ${original.hook}
    ORIGINAL CAPTION: ${original.captionLong}
    
    OUTPUT JSON:
    {
      "hook": "...", "captionShort": "...", "captionLong": "...", "cta": "...", "hashtags": [], "onAssetText": "..."
    }
  `
};

/**
 * STAGE 2: 30-Day STRATEGY & CONTENT CALENDAR GENERATION
 */
export const generate30DayStrategy = async (workspaceId) => {
  try {
    const brand = await BrandProfile.findOne({ workspaceId });
    if (!brand) throw new Error("Run Brand Setup first.");

    let calendar = await ContentCalendar.findOne({ workspaceId });
    if (!calendar) calendar = await ContentCalendar.create({ workspaceId, currentPlan: [] });

    // 1. STRATEGY
    const strategistPrompt = `
      Create a high-performance social media content strategy for the month of ${brand.campaignMonth || 'Current'}.
      
      --- BRAND CORE ---
      BRAND NAME: ${brand.companyName || 'Not specified'}
      TARGET INDUSTRY: ${brand.targetIndustry || 'Not specified'}
      TARGET AUDIENCE: ${brand.targetAudience || 'Not specified'}
      REGION/ETHNICITY: ${brand.targetEthnicity || 'Global'}
      
      --- CONTENT GUIDELINES ---
      CONTENT OBJECTIVE (GOAL): ${brand.contentObjective || "Awareness"}
      POSTING FREQUENCY: ${brand.postingFrequency || '3x per week'}
      ARCHETYPE (VOICE/TONE): ${brand.toneOfVoice || 'Professional'}
      CONVERSION CTA STYLE: ${brand.ctaStyle || 'Direct & Authoritative'}
      
      --- BRAND KNOWLEDGE ---
      BRAND DNA: ${brand.extractedBrandSummary || 'Not specified'}
      DOCUMENT CONTEXT: ${brand.companyOverviewText ? brand.companyOverviewText.substring(0, 3000) : 'No documents uploaded'}

      OUTPUT JSON (STRICT):
      {
        "strategy_summary": "Concise summary",
        "content_distribution": {"educational": "40%", "promotional": "30%", "engagement": "30%", "emotional": "0%"},
        "platform_plan": [{"platform": "Instagram", "strategy": "Concise"}],
        "weekly_themes": ["Theme for Week 1", "Theme for Week 2", "Theme for Week 3", "Theme for Week 4", "Theme for Week 5 (if applicable)"]
      }
    `;

    const stratRes = await AskOpenAIRaw(strategistPrompt, null, { 
      jsonMode: true, 
      systemInstruction: "You are a Brand Strategist. Output ONLY the requested JSON object. No conversational text." 
    });
    const strategyDoc = safeParse(stratRes);

    await SocialAgentWorkspace.findByIdAndUpdate(workspaceId, {
      currentStrategy: {
        summary: strategyDoc.strategy_summary,
        distribution: strategyDoc.content_distribution,
        platform_plan: strategyDoc.platform_plan,
        weekly_themes: strategyDoc.weekly_themes
      }
    });

    // 2. CALENDAR (Respect Month & Frequency)
    const freq = (brand.postingFrequency || '3x per week').toLowerCase();
    let postsPerWeek = 3; // Default
    if (freq.includes('2x') || freq.includes('high')) postsPerWeek = 14;
    else if (freq === 'daily') postsPerWeek = 7;
    else if (freq.includes('3x')) postsPerWeek = 3;
    else if (freq.includes('1x')) postsPerWeek = 1;
    
    // Map Month String to Starting Date
    const monthMap = {
      'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
      'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11
    };
    const selectedMonth = (brand.campaignMonth || 'January').toLowerCase();
    const monthIndex = monthMap[selectedMonth] ?? 0;
    
    // Use current year as base
    const currentYear = new Date().getFullYear();
    const startDate = new Date(currentYear, monthIndex, 1);
    
    // Calculate actual days in this month
    const totalDaysInMonth = new Date(currentYear, monthIndex + 1, 0).getDate();
    const totalWeeks = Math.ceil(totalDaysInMonth / 7);
    
    console.log(`[Stage 2] Generating ${postsPerWeek} posts/week for ${brand.campaignMonth} (${totalDaysInMonth} days) starting ${startDate.toDateString()}`);

    const weekPromises = Array.from({ length: totalWeeks }).map(async (_, weekNum) => {
      const startDayIdx = weekNum * 7;
      const remainingDays = totalDaysInMonth - startDayIdx;
      const daysInThisChunk = Math.min(7, remainingDays);
      
      // Calculate how many posts to generate for this specific chunk (prorated for partial weeks)
      const postsForThisChunk = Math.ceil((daysInThisChunk / 7) * postsPerWeek);

      const builderPrompt = `
        Create exactly ${postsForThisChunk} content pipeline entries for ${weekNum === 0 ? 'the first part' : 'Part ' + (weekNum + 1)} of ${brand.campaignMonth} ${currentYear}.
        
        --- STRATEGIC CONTEXT ---
        BRAND: ${brand.companyName || 'Not specified'}
        TARGET AUDIENCE: ${brand.targetAudience || 'Not specified'}
        REGION: ${brand.targetEthnicity || 'Global'}
        TONE/VOICE: ${brand.toneOfVoice || 'Professional'}
        CTA STYLE: ${brand.ctaStyle || 'Direct & Authoritative'}
        THEME: ${strategyDoc.weekly_themes[weekNum] || strategyDoc.weekly_themes[0] || "General"}
        BRAND DNA: ${brand.extractedBrandSummary || 'Not specified'}
        DOCUMENT CONTEXT: ${brand.companyOverviewText ? brand.companyOverviewText.substring(0, 3000) : 'No documents uploaded'}
        STRATEGY CONTEXT: ${strategyDoc.strategy_summary}
        PLAN: Generate ${postsForThisChunk} high-quality, unique posts spread across this ${daysInThisChunk}-day period.

        OUTPUT JSON (STRICT):
        {
          "entries": [
            {
              "date": "YYYY-MM-DD", "phase": "...", "platform": "...", "format": "...", "post_type": "...",
              "heading_hook": "...", "sub_heading": "...", "short_caption": "...", "long_caption": "...",
              "hashtags": "...", "breakdown": "..."
            }
          ]
        }
        
        Important: All dates MUST be within ${brand.campaignMonth} ${currentYear}.
        Dates start: ${new Date(startDate.getTime() + startDayIdx * 86400000).toISOString().split('T')[0]}.
        Period length: ${daysInThisChunk} days.
        Entries priority: Spread these across the ${daysInThisChunk} days reasonably.
      `;

      try {
        const weekRes = await AskOpenAIRaw(builderPrompt, null, { 
          jsonMode: true, 
          systemInstruction: `You are a content writer for ${brand.campaignMonth}. Output ONLY a valid JSON object. No conversational text.` 
        });
        const parsed = safeParse(weekRes);
        return Array.isArray(parsed) ? parsed : (parsed.entries || parsed.calendar || []);
      } catch (weekErr) {
        logger.error(`[Stage 2] Week ${weekNum + 1} generation failed: ${weekErr.message}`);
        return [];
      }
    });

    const results = await Promise.all(weekPromises);
    // 3. SORT AND SAVE
    // Clear existing pending entries for this brand
    await CalendarEntry.deleteMany({ workspaceId, status: 'pending' });

    // SORT strategyArray by date string (YYYY-MM-DD) to ensure absolutely sequential order
    const sortedStrategy = results.flat()
      .filter(item => !!item.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    const entries = [];
    for (const item of sortedStrategy) {
      if (!item.date) continue;
      const entry = await CalendarEntry.create({
        workspaceId, calendarId: calendar._id, date: item.date, scheduledDate: new Date(item.date),
        platform: item.platform, format: item.format, postType: item.post_type,
        title: item.heading_hook, heading_hook: item.heading_hook, sub_heading: item.sub_heading,
        short_caption: item.short_caption, long_caption: item.long_caption, hashtags: item.hashtags, 
        breakdown: item.breakdown, status: 'pending'
      });
      entries.push(entry);
    }

    if (entries.length > 0) {
      const excelBuffer = await socialAgentService.generateCalendarExcel(entries);
      if (excelBuffer) {
        const gcsRes = await socialAgentService.uploadBufferToGCS(excelBuffer, `Plan_${workspaceId}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Calendar');
        calendar.excelUrl = gcsRes.url;
      }
    }
    
    calendar.status = 'generated';
    await calendar.save();

    return { status: "success", calendar_id: calendar._id, excel_url: calendar.excelUrl, calendar: entries };
  } catch (error) {
    logger.error(`[Stage 2] Failed: ${error.message}`);
    throw error;
  }
};

/**
 * Single Row Generation
 */
export const generateContentForSpecificRow = async (workspaceId, entryId) => {
  logger.info(`[GenerationService] Initializing specific row generation: EntryID=${entryId}, WorkspaceID=${workspaceId}`);
  
  const brand = await BrandProfile.findOne({ workspaceId });
  const entry = await CalendarEntry.findById(entryId);
  const usage = await PlanUsage.findOne({ workspaceId });

  if (!brand || !entry) {
    logger.error(`[GenerationService] Critical failure: Missing data for generation. BrandFound=${!!brand}, EntryFound=${!!entry}`);
    throw new Error("Data missing for brand or entry");
  }

  logger.debug(`[GenerationService] Distilling brand context for: ${brand.companyName}`);
  const brandContext = await callLLM('context_distillation', PROMPTS.CONTEXT_DISTILLATION(brand), workspaceId);
  
  logger.info(`[GenerationService] Synthesizing copy for entry: ${entry.title || entry.id}`);
  const copyOutput = await callLLM('copy_generation', PROMPTS.COPY_GENERATION(brandContext, entry, entry.platform || 'Instagram'), workspaceId);

  const platform = (entry.platform || 'instagram').toLowerCase();
  const format = (entry.format || 'image').toLowerCase();
  const type = format.includes('video') || format.includes('reel') ? 'video' : 
               format.includes('carousel') ? 'carousel' : 'image';

  logger.debug(`[GenerationService] Normalized attributes: platform=${platform}, type=${type}`);

  // 🛡️ Ensure complete isolation between Content and Hashtag regeneration.
  // If this is a regeneration (entry.status is already 'generated'), we strictly KEEP the old hashtags.
  // We also hard-cap the initial LLM output to 30 to prevent bloated lists on the first run.
  const isRegeneration = entry.status === 'generated';
  const finalHashtags = isRegeneration && Array.isArray(entry.hashtags) && entry.hashtags.length > 0 
    ? entry.hashtags 
    : (copyOutput.hashtags || []).slice(0, 30);

  const post = await GeneratedPost.create({
    workspaceId, calendarEntryId: entry._id, type, platform, version: 1,
    hook: copyOutput.hook, onAssetText: copyOutput.onAssetText, captionShort: copyOutput.captionShort,
    captionLong: copyOutput.captionLong, hashtags: finalHashtags, cta: copyOutput.cta, 
    variations: copyOutput.variations || [],
    scheduledDate: entry.scheduledDate,
    dateString: entry.scheduledDate ? new Date(entry.scheduledDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : entry.date,
    status: 'draft'
  });

  // Content generation only: Post record is created without a primary asset yet.
  // Visual assets are now isolated and generated only when 'Gen Post' is clicked.
  // await post.save(); // Not strictly needed as create() already saved, but good for clarity if modified later

  if (usage) {
    logger.debug(`[GenerationService] Updating plan usage for ${workspaceId}`);
    updateUsage(usage, type);
  }
  
  entry.status = 'generated';
  entry.hook = copyOutput.hook;
  entry.captionShort = copyOutput.captionShort;
  entry.captionLong = copyOutput.captionLong;
  entry.hashtags = finalHashtags;
  entry.breakdown = copyOutput.onAssetText; // Syncing visual text as breakdown
  await entry.save();

  logger.info(`[GenerationService] Successfully generated post ${post._id} for entry ${entryId}`);
  return post;
};

/**
 * Job Processing Logic
 */
export const startGenerationJob = async (workspaceId, mode, options = {}) => {
  const job = await GenerationJob.create({ workspaceId, generationMode: mode, status: 'pending' });
  processGenerationJob(job._id, options).catch(e => console.error(e));
  return job;
};

const processGenerationJob = async (jobId, options) => {
  logger.info(`[GenerationJob] Starting background processing for JobID=${jobId}`);
  const job = await GenerationJob.findById(jobId);
  if (!job) {
    logger.error(`[GenerationJob] Job record not found: JobID=${jobId}`);
    return;
  }
  
  job.status = 'processing';
  await job.save();

  try {
    const { count = 1, entryIds } = options;
    logger.debug(`[GenerationJob] Options: count=${count}, entryIds=${JSON.stringify(entryIds)}`);
    
    let entries;
    if (entryIds && entryIds.length > 0) {
      entries = await CalendarEntry.find({ _id: { $in: entryIds } });
    } else {
      entries = await CalendarEntry.find({ workspaceId: job.workspaceId, status: 'pending' }).limit(count);
    }
    
    logger.info(`[GenerationJob] Identified ${entries.length} entries for synthesis`);
    
    for (const entry of entries) {
      try {
        logger.debug(`[GenerationJob] Synthesizing entry: ${entry._id}`);
        await generateContentForSpecificRow(job.workspaceId, entry._id);
        job.completedCount++;
        await job.save();
        logger.info(`[GenerationJob] Entry ${entry._id} completed (${job.completedCount}/${entries.length})`);
      } catch (entryErr) {
        logger.error(`[GenerationJob] Specific entry failure: ${entry._id} - ${entryErr.message}`);
        await CalendarEntry.findByIdAndUpdate(entry._id, { status: 'failed' });
        // We continue the job for other entries, but mark the overall job as having issues if needed
        job.errorSummary = `Partial failure: ${entryErr.message}`;
      }
    }
    
    job.status = (job.completedCount === entries.length) ? 'completed' : 'failed';
    logger.info(`[GenerationJob] JobID=${jobId} finished with status: ${job.status}`);
  } catch (err) {
    logger.error(`[GenerationJob] JobID=${jobId} encountered a critical error: ${err.message}`);
    job.status = 'failed';
    job.errorSummary = err.message;
  }
  job.completedAt = new Date();
  await job.save();
};

/**
 * Regeneration
 */
export const regenerateCalendarEntry = async (workspaceId, entryId, toneNudge) => {
  const brand = await BrandProfile.findOne({ workspaceId });
  const entry = await CalendarEntry.findById(entryId);
  
  const prompt = `Regenerate this entry with tone nudge: ${toneNudge}. Entry: ${JSON.stringify(entry)}. Brand: ${JSON.stringify(brand.structuredIdentity)}`;
  const res = await AskOpenAIRaw(prompt);
  const updatedData = safeParse(res);
  
  Object.assign(entry, updatedData);
  await entry.save();
  return entry;
};

export const regeneratePost = async (postId, intent) => {
  const original = await GeneratedPost.findById(postId);
  const brand = await BrandProfile.findOne({ workspaceId: original.workspaceId });
  
  const copyOutput = await callLLM('regeneration', PROMPTS.REGENERATE_WITH_INTENT(original, intent), original.workspaceId);
  const newPost = await GeneratedPost.create({ ...original.toObject(), _id: new mongoose.Types.ObjectId(), version: original.version + 1, ...copyOutput, status: 'draft' });
  
  return { _id: newPost._id };
};

export const generateHashtags = async (workspaceId) => {
  const brand = await BrandProfile.findOne({ workspaceId });
  const res = await AskOpenAIRaw(`Generate hashtags for: ${JSON.stringify(brand.structuredIdentity)}`);
  return safeParse(res);
};

export const getHashtagInsights = async (workspaceId, topic) => {
  const brand = await BrandProfile.findOne({ workspaceId });
  const prompt = `
    Synthesize a comprehensive viral cluster of 30 high-growth social media hashtags.
    Include a strategic mix of:
    - 10 Broad Industry Tags (high reach)
    - 10 Niche Community Tags (high engagement)
    - 10 Trending Action Tags (viral potential)
    
    TOPIC: ${topic}
    BRAND CONTEXT: ${JSON.stringify(brand?.structuredIdentity || {})}
    
    OUTPUT: A JSON array of exactly 30 strings (hashtags).
  `;
  const res = await AskOpenAIRaw(prompt);
  return safeParse(res);
};

export const generateImagePrompt = async (workspaceId, userIdea) => {
  const brand = await BrandProfile.findOne({ workspaceId });
  const res = await AskOpenAIRaw(`Generate image prompt for: ${userIdea}. Brand: ${JSON.stringify(brand.structuredIdentity)}`);
  return safeParse(res);
};

// --- HELPERS ---
const callLLM = async (type, prompt, wsId) => {
  const res = await AskOpenAIRaw(prompt);
  return safeParse(res);
};

const validateQuota = (usage, type) => {
  if (type === 'image') return usage.imageUsed < usage.imageLimit;
  if (type === 'video') return usage.videoUsed < usage.videoLimit;
  return true;
};

const updateUsage = (usage, type) => {
  if (type === 'image') usage.imageUsed++;
  if (type === 'video') usage.videoUsed++;
  usage.save();
};

// --- REAL IMAGE GENERATION (AI Ads Agent pipeline) ---

/**
 * STEP 2.5 — BRAND LOGO OVERLAY
 * ─────────────────────────────────────────────────────
 * Takes a generated image URL + a brand logoUrl, downloads both,
 * and uses Gemini 2.5 Flash image editing to composite the logo
 * onto the top-left corner of the generated image.
 *
 * Gracefully returns the original imageUrl if:
 *   - No logoUrl is provided (brand hasn't uploaded a logo)
 *   - Logo/image download fails
 *   - Gemini overlay fails (pipeline must not crash due to this step)
 */
// Helper: normalise a raw Content-Type header into a Gemini-accepted image MIME type.
// GCS signed-URL downloads often return 'application/octet-stream' even for PNG files;
// Gemini rejects anything that isn't a recognised image/* type with INVALID_ARGUMENT.
const toImageMime = (contentType = '') => {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct.startsWith('image/')) return ct;
  return 'image/png';
};

// Gemini inlineData only accepts these image formats.
// SVG, GIF, BMP, TIFF etc. will cause INVALID_ARGUMENT for the ENTIRE request.
const GEMINI_SUPPORTED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/jpg',
  'image/webp', 'image/heic', 'image/heif',
]);

const isGeminiSupportedImage = (mime) => GEMINI_SUPPORTED_IMAGE_MIMES.has(mime.toLowerCase());

const applyVisualOverlays = async (imageUrl, logoUrl, headingText, subheadingText, aspectRatio = '1:1') => {
  if (!logoUrl && !headingText && !subheadingText) {
    console.log('    [VisualOverlay] ⏭️  Skipping — no text or logo to overlay.');
    return imageUrl;
  }

  console.log('    [VisualOverlay] 🏷️  Applying overlays (Logo + Text)...');
  const overlayStart = Date.now();

  try {
    // 1. Download the generated image as base64
    //    Use a longer timeout (45 s) — full-res Gemini images can be several MB.
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 45000 });
    const imageData = imageResponse.data;

    if (!imageData || imageData.byteLength < 100) {
      console.warn(`    [VisualOverlay] ⚠️  Downloaded image is empty/too small (${imageData?.byteLength ?? 0} bytes) — skipping overlay.`);
      return imageUrl;
    }

    const imageBase64 = Buffer.from(imageData).toString('base64');
    // Force a valid image MIME — GCS signed URLs often return application/octet-stream
    const imageMime = toImageMime(imageResponse.headers['content-type']);
    console.log(`    [VisualOverlay] 📦 Image downloaded: ${imageData.byteLength} bytes | MIME: ${imageMime}`);

    // 2. Download the brand logo as base64 (if available)
    let logoBase64 = null;
    let logoMime = null;

    // Gemini only accepts these image formats as inlineData input
    const GEMINI_SUPPORTED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];

    if (logoUrl) {
      try {
        let logoResponse = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 20000 });
        let rawBuffer = Buffer.from(logoResponse.data);
        let rawContentType = (logoResponse.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

        // If the logo is an ICO (unsupported by Gemini and sharp natively), convert it to PNG using Google Favicon API
        if (rawContentType.includes('icon') || logoUrl.toLowerCase().endsWith('.ico')) {
          try {
            console.log(`    [VisualOverlay] 🔄 ICO format detected. Fetching PNG equivalent via Favicon API...`);
            const urlObj = new URL(logoUrl);
            const domain = urlObj.hostname;
            const googleFaviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
            
            logoResponse = await axios.get(googleFaviconUrl, { responseType: 'arraybuffer', timeout: 10000 });
            rawBuffer = Buffer.from(logoResponse.data);
            rawContentType = (logoResponse.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            console.log(`    [VisualOverlay] ✅ Successfully converted ICO to ${rawContentType}`);
          } catch (e) {
            console.warn(`    [VisualOverlay] ⚠️ Failed to fetch PNG equivalent for ICO: ${e.message}`);
          }
        }

        if (rawBuffer.byteLength >= 100) {
          // Strategy 1: sharp direct conversion → always outputs PNG (Gemini-supported)
          try {
            const pngBuffer = await sharp(rawBuffer).png().toBuffer();
            logoBase64 = pngBuffer.toString('base64');
            logoMime = 'image/png';
            console.log(`    [VisualOverlay] 🖼  Logo converted to PNG via sharp: ${pngBuffer.byteLength} bytes`);
          } catch (sharpErr) {
            // Strategy 2: sharp with failOn:none — handles partially corrupt files
            try {
              const pngBuffer = await sharp(rawBuffer, { failOn: 'none' })
                .resize({ width: 400, withoutEnlargement: true })
                .png()
                .toBuffer();
              logoBase64 = pngBuffer.toString('base64');
              logoMime = 'image/png';
              console.log(`    [VisualOverlay] 🖼  Logo converted via resize fallback: ${pngBuffer.byteLength} bytes`);
            } catch (resizeErr) {
              // Strategy 3: Only send raw if Gemini natively supports the format
              if (GEMINI_SUPPORTED_MIMES.includes(rawContentType)) {
                logoBase64 = rawBuffer.toString('base64');
                logoMime = rawContentType;
                console.log(`    [VisualOverlay] 🖼  Logo sent as raw ${rawContentType}: ${rawBuffer.byteLength} bytes`);
              } else {
                // ICO, BMP, SVG, TIFF etc — Gemini rejects these, skip logo entirely
                console.warn(`    [VisualOverlay] ⚠️  Logo format "${rawContentType}" is not supported by Gemini — skipping logo, text overlay will still apply.`);
              }
            }
          }
        } else {
          console.warn('    [VisualOverlay] ⚠️  Logo downloaded but appears empty — skipping logo.');
        }
      } catch (e) {
        console.warn(`    [VisualOverlay] ⚠️  Logo download failed (${e.message}), continuing with text only.`);
      }
    }




    // 3. Use Gemini Flash image editing to composite
    //    IMPORTANT: use 'global' location — same as generateImageFromPrompt uses;
    //    sending to a regional endpoint that doesn't host the model causes INVALID_ARGUMENT.
    const client = new GoogleGenAI({
      vertexai: true,
      project: process.env.GCP_PROJECT_ID,
      location: 'global',
    });

    const parts = [
      { inlineData: { mimeType: imageMime, data: imageBase64 } }
    ];

    if (logoBase64) {
      parts.push({ inlineData: { mimeType: logoMime, data: logoBase64 } });
    }

    let overlayPrompt = `You are a professional image compositor and graphic designer for social media ads.
You are given ${logoBase64 ? 'two images' : 'an image'}:
- Image 1: A social media ad post (the main image)
${logoBase64 ? '- Image 2: A brand logo\n' : ''}
Your task is to overlay the following elements cleanly and beautifully without covering the main subject of the image:
`;

    if (logoBase64) {
      overlayPrompt += `
1. Place the brand logo (Image 2) neatly in the top-left corner.
2. Size the logo to approximately 10-15% of the image width.
3. Add a very subtle semi-transparent white padding around the logo for visibility if needed.
`;
    }

    if (headingText || subheadingText) {
      overlayPrompt += `
${logoBase64 ? '4' : '1'}. Carefully overlay the following text onto the image in a professional, highly readable marketing style:
   - HEADING: "${headingText || ''}"
   - SUBHEADING: "${subheadingText || ''}"
${logoBase64 ? '5' : '2'}. Use a clean, modern, sans-serif font. Make the HEADING bold and prominent, and the SUBHEADING slightly smaller.
${logoBase64 ? '6' : '3'}. Choose a contrasting color (e.g., white text on dark background or black text on light background) and use subtle shadows or a semi-transparent dark banner behind the text to ensure perfect typography legibility. Place it at the top, bottom, or the most empty space of the image.
`;
    }

    overlayPrompt += `
* Preserve the original ad image composition, colors, lighting, and quality.
* Do NOT alter any other part of the image.
* Output the final composited image ONLY. No conversational text.`;

    parts.push({ text: overlayPrompt });

    let geminiRatio = '1:1'; // safe default
    if (aspectRatio === '16:9')  geminiRatio = '16:9';
    else if (aspectRatio === '9:16')  geminiRatio = '9:16';
    else if (aspectRatio === '4:3')   geminiRatio = '4:3';
    else if (aspectRatio === '3:4')   geminiRatio = '3:4';
    else if (aspectRatio === '4:5')   geminiRatio = '4:5';
    else if (aspectRatio === '1:1')   geminiRatio = '1:1';

    let response;
    let retryCount = 0;
    const maxRetries = 3;
    while (true) {
      try {
        response = await client.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: [{ role: 'user', parts }],
          config: { 
            responseModalities: [Modality.TEXT, Modality.IMAGE],
            imageConfig: { aspectRatio: geminiRatio }
          }
        });
        break;
      } catch (err) {
        const isQuotaError = err.status === 429 || err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED') || err.message?.includes('quota');
        if (retryCount < maxRetries && isQuotaError) {
          retryCount++;
          console.warn(`    [VisualOverlay] ⚠️  Quota hit (429). Retrying ${retryCount}/${maxRetries} after ${retryCount * 4}s...`);
          await new Promise(r => setTimeout(r, retryCount * 4000));
        } else {
          throw err;
        }
      }
    }


    // 4. Extract the resulting image bytes
    let resultBase64 = null;
    let resultMime = 'image/png';
    const responseParts = response?.candidates?.[0]?.content?.parts || [];
    for (const part of responseParts) {
      if (part.inlineData?.data) {
        resultBase64 = part.inlineData.data;
        resultMime = part.inlineData.mimeType || 'image/png';
      } else if (part.text) {
        console.log(`    [VisualOverlay] Gemini note: \`${part.text.substring(0, 120)}`);
      }
    }

    if (!resultBase64) {
      console.warn('    [VisualOverlay] ⚠️  Gemini returned no image — falling back to original.');
      return imageUrl;
    }

    // 5. Upload composited image to GCS
    const buffer = Buffer.from(resultBase64, 'base64');
    const gcsResult = await uploadToGCS(buffer, {
      folder: 'generated_images',
      filename: gcsFilename('aisa_branded_post'),
      mimeType: resultMime,
    });

    if (!gcsResult?.publicUrl) {
      console.warn('    [VisualOverlay] ⚠️  GCS upload failed — falling back to original.');
      return imageUrl;
    }

    console.log(`    [VisualOverlay] ✅ Overlays composited in ${Date.now() - overlayStart}ms → ${gcsResult.publicUrl.substring(0, 60)}...`);
    return gcsResult.publicUrl;

  } catch (err) {
    console.error(`    [VisualOverlay] ❌ Overlay failed (${err.message}) — using original image.`);
    return imageUrl;
  }
};

/**
 * AI ADS AGENT — VISUAL POST GENERATION PIPELINE
 * ─────────────────────────────────────────────────
 * Step 1   │ GPT-4    → Brand-aware Imagen prompt engineering
 * Step 2   │ Vertex AI Imagen 3/4 → High-quality visual render
 * Step 2.5 │ Gemini 2.5 Flash → Brand logo overlay (top-left)
 * Step 3   │ GCS      → Secure cloud storage
 * Step 4   │ MongoDB  → GeneratedAsset + Job update
 * Step 5   │ Calendar → Entry status marked "generated"
 */
export const generateVisualPostForEntry = async (workspaceId, entryId, jobId, modelId = 'imagen-3.0-generate-001', postFormat = 'single', aspectRatio = '1:1', carouselCount = 3) => {
  const pipelineStart = Date.now();

  console.log('\n' + '═'.repeat(60));
  console.log('🎨  AI ADS AGENT — VISUAL POST PIPELINE STARTED');
  console.log('═'.repeat(60));
  console.log(`  📋 Entry ID    : ${entryId}`);
  console.log(`  🏢 Workspace   : ${workspaceId}`);
  console.log(`  🔧 Job ID      : ${jobId}`);
  console.log(`  🤖 Model       : ${modelId}`);
  console.log(`  🖼️  Format      : ${postFormat.toUpperCase()}`);
  console.log(`  ⏱  Started at  : ${new Date().toISOString()}`);
  console.log('─'.repeat(60));

  // ── LOAD: Brand Profile & Calendar Entry ────────────────────────
  console.log('\n[Step 0/5] 📂 Loading Brand Profile & Calendar Entry...');
  const dataLoadStart = Date.now();

  const brand = await BrandProfile.findOne({ workspaceId });
  const entry = await CalendarEntry.findById(entryId);

  if (!brand || !entry) {
    console.error(`[VisualPost] ❌ ABORT — Data missing: brand=${!!brand}, entry=${!!entry}`);
    throw new Error('Brand or CalendarEntry not found');
  }

  const companyName     = brand.companyName || 'Brand';
  const brandColors     = (brand.brandColors || []).slice(0, 3).join(', ') || 'brand palette';
  const tone            = brand.toneOfVoice || brand.structuredIdentity?.tone || 'professional';
  const platform        = entry.platform || 'Instagram';
  const rawPostType     = (entry.postType || entry.format || 'image').toLowerCase().trim();
  const title           = entry.title || entry.heading_hook || 'Post';
  const hook            = entry.hook || entry.captionShort || '';
  const phase           = entry.phase || 'Awareness';
  const targetEthnicity = brand.targetEthnicity || 'Global';

  // Normalise any free-text calendar value to a valid GeneratedAsset enum
  // CalendarEntries can have values like "Informative", "Promotional", "Educational", "Shorts", etc.
  const normalizeAssetType = (raw) => {
    if (raw.includes('carousel') || raw.includes('slide'))  return 'carousel';
    if (raw.includes('reel'))                               return 'reel';
    if (raw.includes('video') || raw.includes('short') || raw.includes('shorts')) return 'video';
    // Everything else (image, informative, promotional, educational, awareness, etc.) → image
    return 'image';
  };
  const postType = normalizeAssetType(rawPostType);

  console.log(`    ✅ Brand        : "${companyName}"`);
  console.log(`    ✅ Post title   : "${title}"`);
  console.log(`    ✅ Platform     : ${platform} | Type: ${postType} | Phase: ${phase}`);
  console.log(`    ✅ Brand colors : ${brandColors}`);
  console.log(`    ✅ Tone         : ${tone}`);
  console.log(`    ⏱  Loaded in ${Date.now() - dataLoadStart}ms`);

  // ── STEP 1: GPT-4 Prompt Engineering ────────────────────────────
  console.log(`\n[Step 1/5] 🧠 GPT-4 Prompt Engineering (format: ${postFormat})...`);
  const promptStart = Date.now();

  const isCarousel = postFormat === 'carousel';

  let slideStructure = '';
  if (isCarousel) {
    slideStructure = '- Slide 1: Bold, attention-grabbing opening visual representing the hook\n';
    if (carouselCount === 2) {
      slideStructure += '- Slide 2: CTA-driven closing — inspiring action with brand energy';
    } else if (carouselCount === 3) {
      slideStructure += '- Slide 2: Solution / product in context — aspirational lifestyle\n';
      slideStructure += '- Slide 3: CTA-driven closing — inspiring action with brand energy';
    } else if (carouselCount === 4) {
      slideStructure += '- Slide 2: Problem visualization — what challenge the audience faces\n';
      slideStructure += '- Slide 3: Solution / product in context — aspirational lifestyle\n';
      slideStructure += '- Slide 4: CTA-driven closing — inspiring action with brand energy';
    } else {
      slideStructure += '- Slide 2: Problem visualization — what challenge the audience faces\n';
      slideStructure += '- Slide 3: Solution / product in context — aspirational lifestyle\n';
      slideStructure += '- Slide 4: Key benefit or proof point — data, result, transformation\n';
      slideStructure += '- Slide 5: CTA-driven closing — inspiring action with brand energy';
    }
  }

  const promptEngineeringRequest = isCarousel
    ? `You are an expert AI Image Prompt Engineer for social media advertising.

Generate ${carouselCount} separate, distinct Imagen 3 image generation prompts for a CAROUSEL post.
Each slide must be visually different but tell a cohesive brand story.

BRAND: ${companyName}
PLATFORM: ${platform} (Carousel format)
ASPECT RATIO: ${aspectRatio}
CAMPAIGN PHASE: ${phase}
POST TITLE: ${title}
HOOK: ${hook}
BRAND TONE: ${tone}
BRAND COLORS: ${brandColors}
TARGET AUDIENCE: ${targetEthnicity}

Slide structure:
${slideStructure}

Requirements for each prompt:
- Photorealistic, studio-grade, high-quality
- Integrate brand colors naturally
- Match the required aspect ratio (${aspectRatio})
- NO text or logos in any image
- Distinct subject / scene per slide

Output ONLY ${carouselCount} numbered prompts (1. 2. 3. ...), nothing else. No JSON, no explanation.`
    : `You are an expert AI Image Prompt Engineer for social media advertising.

Generate a detailed, photorealistic Imagen 3 image generation prompt for the following social media post:

BRAND: ${companyName}
PLATFORM: ${platform} (single image format)
ASPECT RATIO: ${aspectRatio}
CAMPAIGN PHASE: ${phase}
POST TITLE: ${title}
HOOK: ${hook}
BRAND TONE: ${tone}
BRAND COLORS: ${brandColors}
TARGET AUDIENCE: ${targetEthnicity}

Requirements for the Imagen prompt:
- Make it photorealistic, high-quality, studio-grade
- Integrate the brand colors naturally into the composition
- Match the platform format and required aspect ratio (${aspectRatio})
- The visual must represent the post title and hook visually
- Add specific composition, lighting, and mood details
- NO text or logos in the image (clean visual only)
- Be specific about subject, setting, lighting, camera angle

Output ONLY the raw Imagen prompt text, nothing else. No JSON, no explanation.`;

  console.log(`    📤 Sending context to GPT-4 (${promptEngineeringRequest.length} chars)...`);

  const imagenPrompt = await AskOpenAIRaw(promptEngineeringRequest, null, {
    systemInstruction: 'You are an AI image prompt engineer. Output only the image generation prompt text.'
  });

  if (!imagenPrompt || imagenPrompt.trim().length < 20) {
    console.error('[VisualPost] ❌ GPT-4 returned empty/invalid prompt');
    throw new Error('GPT-4 returned an empty image prompt');
  }

  const trimmedPrompt = imagenPrompt.trim();
  console.log(`    ✅ Prompt received (${trimmedPrompt.length} chars) in ${Date.now() - promptStart}ms`);
  
  let finalImagePrompt = trimmedPrompt;
  let carouselSlides = [];

  if (isCarousel) {
    console.log(`    📑 Carousel mode — Parsing ${carouselCount} slide prompts...`);
    // Split by markers like "1. ", "2. ", or simply double newlines if markers aren't perfectly followed
    const slideMatches = trimmedPrompt.split(/\n?\d+\.\s*/).filter(s => s.trim().length > 10);
    
    // Take exactly carouselCount or whatever we have
    const slidePrompts = slideMatches.slice(0, carouselCount);
    if (slidePrompts.length < carouselCount) {
       console.warn(`    ⚠️  Only parsed ${slidePrompts.length}/${carouselCount} slides. Attempting line-split fallback.`);
       // Minimal fallback if the numbering was weird
       const fallback = trimmedPrompt.split('\n').filter(l => l.trim().length > 30).slice(0, carouselCount);
       if (fallback.length > slidePrompts.length) carouselSlides = fallback;
       else carouselSlides = slidePrompts;
    } else {
       carouselSlides = slidePrompts;
    }
    
    // Use the first slide as the representitive "cover" prompt for legacy single-image fields
    finalImagePrompt = carouselSlides[0] || trimmedPrompt;
    console.log(`    ✅ Successfully parsed ${carouselSlides.length} slides.`);
  }

  // ── STEP 2: Vertex AI Imagen Generation ─────────────────────────
  console.log(`\n[Step 2/5] 🖼  Vertex AI Imagen Generation (Format: ${postFormat})...`);
  const imagenStart = Date.now();

  const selectedModel = modelId || 'imagen-3.0-generate-001';
  console.log(`    🤖 Calling model: ${selectedModel}`);
  
  let imageUrl = '';
  let generatedSlides = [];

  let slideTexts = [];

  // --- Smart local fallback: always generates unique headings per slide ---
  const SLIDE_FRAMES = [
    { role: 'Hook',     prefix: '',         suffix: '' },
    { role: 'Problem',  prefix: 'The Real Problem: ', suffix: '' },
    { role: 'Solution', prefix: 'The Fix: ',          suffix: '' },
    { role: 'Proof',    prefix: 'Why It Works: ',     suffix: '' },
    { role: 'CTA',      prefix: '',                   suffix: ' — Act Now' },
  ];
  const buildLocalVariations = (count) => {
    return Array.from({ length: count }, (_, i) => {
      const frame = SLIDE_FRAMES[i % SLIDE_FRAMES.length];
      return {
        heading: `${frame.prefix}${title}${frame.suffix}`.trim(),
        subheading: i === 0 ? hook : (hook ? hook.split(' ').reverse().join(' ').substring(0, 60) : `Part ${i + 1} of ${count}`)
      };
    });
  };

  if (isCarousel && carouselSlides.length > 0) {
    console.log(`    ⚡ Staggered Rendering ${carouselSlides.length} slides (1.2s apart to manage quota)...`);

    // Generate unique text variations per slide via Vertex AI
    const variationsPrompt = `You are a professional social media copywriter creating a ${carouselCount}-slide carousel post.

Original Heading: ${title}
Original Hook/Subheading: ${hook || 'N/A'}

Generate ${carouselCount} UNIQUE and DISTINCT text overlays for each slide. The slides must flow as a logical story:
${slideStructure}
(Adjust the flow if fewer slides)

Rules:
- Each "heading" must be DIFFERENT from the others — no repetition
- Keep headings under 8 words — punchy, bold, suitable for image overlay
- Keep subheadings under 15 words

Output ONLY a raw JSON array (no markdown, no explanation) like this:
[
  { "heading": "...", "subheading": "..." },
  { "heading": "...", "subheading": "..." }
]`;

    try {
      console.log(`    🧠 Generating unique text variations for ${carouselSlides.length} slides via Vertex AI...`);
      const varsRes = await AskVertexRaw(variationsPrompt, { temperature: 0.85 });
      let parsed = safeParse(varsRes);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key in parsed) {
          if (Array.isArray(parsed[key])) { parsed = parsed[key]; break; }
        }
      }
      slideTexts = Array.isArray(parsed) && parsed.length >= carouselSlides.length
        ? parsed
        : buildLocalVariations(carouselSlides.length);
      console.log(`    ✅ Slide text variations ready (${slideTexts.length} slides):`);
      slideTexts.forEach((s, i) => console.log(`       Slide ${i+1}: "${s.heading}" / "${s.subheading}"`) );
    } catch(e) {
      console.warn(`    ⚠️ Vertex variation call failed (${e.message}) — using smart local fallback.`);
      slideTexts = buildLocalVariations(carouselSlides.length);
    }

    // Stagger calls 1.2s apart to avoid hitting Imagen's concurrent quota limit
    for (let i = 0; i < carouselSlides.length; i++) {
      const p = carouselSlides[i];
      console.log(`       -> Rendering Slide ${i+1}/${carouselSlides.length}: "${p.substring(0, 40)}..."`);
      try {
        const rawSlideUrl = await generateImageFromPrompt(p, null, aspectRatio, selectedModel);
        if (rawSlideUrl) {
          // ── STEP 2.5: Apply brand logo and text overlay to each slide ──
          const slideHeading = slideTexts[i]?.heading || title;
          const slideSubheading = slideTexts[i]?.subheading || hook;
          const brandedSlideUrl = await applyVisualOverlays(rawSlideUrl, brand.logoUrl, slideHeading, slideSubheading, aspectRatio);
          generatedSlides.push(brandedSlideUrl);
          
          // --- UPDATE JOB PROGRESS FOR FRONTEND POLL ---
          await GenerationJob.findByIdAndUpdate(jobId, { completedCount: i + 1 }).catch(() => {});
        } else {
          console.warn(`       ⚠️  Slide ${i+1} returned empty URL`);
        }
      } catch (err) {
        console.error(`       ❌ Slide ${i+1} failed: ${err.message}`);
      }
      // Wait 1.2s between slides to avoid rate limiting (except after last slide)
      if (i < carouselSlides.length - 1) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    imageUrl = generatedSlides[0] || '';
    console.log(`    ✅ ${generatedSlides.length}/${carouselSlides.length} slides rendered successfully.`);
  } else {
    // Single image generation
    console.log(`    📐 Aspect ratio : ${aspectRatio}`);
    const rawImageUrl = await generateImageFromPrompt(finalImagePrompt, null, aspectRatio, selectedModel);
    // ── STEP 2.5: Apply visual overlays (logo + text) ──
    imageUrl = await applyVisualOverlays(rawImageUrl, brand.logoUrl, title, hook, aspectRatio);
  }

  if (!imageUrl && generatedSlides.length === 0) {
    console.error('[VisualPost] ❌ Vertex AI returned no image URL');
    throw new Error('Vertex AI Imagen returned no image URL');
  }

  const imagenMs = Date.now() - imagenStart;
  console.log(`    ✅ Generation cycle complete in ${imagenMs}ms`);
  console.log(`    🏷️  Logo overlay : ${brand.logoUrl ? 'Applied' : 'Skipped (no logo)'}`);
  console.log(`    📐 Final images  : ${isCarousel ? generatedSlides.length + ' slides' : '1 single image'}`);

  // ── STEP 3: Save GeneratedAsset to DB ────────────────────────────
  console.log('\n[Step 3/5] 💾 Saving GeneratedAsset to MongoDB...');
  const assetStart = Date.now();

  const assetName = `visual_${title.replace(/\s+/g, '_').substring(0, 30)}_${Date.now()}.png`;
  const resolvedAssetType = postFormat === 'carousel' ? 'carousel' : postType;
  
  const asset = await GeneratedAsset.create({
    workspaceId,
    calendarEntryId: entry._id,
    assetType: resolvedAssetType,
    assetSource: 'generated',
    gcsUrl: imageUrl,
    mimeType: 'image/png',
    dateString: entry.scheduledDate ? new Date(entry.scheduledDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : entry.date,
    metadata: {
      prompt: finalImagePrompt,
      fullCarouselPrompt: isCarousel ? trimmedPrompt : undefined,
      slides: isCarousel ? generatedSlides : undefined, // Array of URLs for frontend carousel
      slidePrompts: isCarousel ? carouselSlides : undefined,
      originalName: assetName,
      platform,
      phase,
      postFormat,
      generatedAt: new Date(),
      modelUsed: selectedModel,
    }
  });

  console.log(`    ✅ GeneratedAsset saved: ${asset._id}`);
  console.log(`    📁 Asset name   : ${assetName} | Slides: ${generatedSlides.length}`);
  console.log(`    ⏱  Saved in ${Date.now() - assetStart}ms`);

  // ── STEP 4: Mark GenerationJob as Completed ──────────────────────
  console.log('\n[Step 4/5] 🔄 Updating GenerationJob status...');
  await GenerationJob.findByIdAndUpdate(jobId, {
    status: 'completed',
    completedAt: new Date(),
    completedCount: 1,
    resultAssetId: asset._id,
  });
  console.log(`    ✅ Job ${jobId} → status: "completed"`);

  // ── STEP 5: Mark CalendarEntry — LEAVE STATUS UNCHANGED FOR ISOLATION ────────────────
  console.log('\n[Step 5/5] 📅 Keeping CalendarEntry status isolated...');
  // entry.status = 'generated'; // Visual generation should not mark content as generated
  // await entry.save();
  console.log(`    ✅ Entry ${entryId} status preserved for content generation isolation`);

  // ── PIPELINE COMPLETE ────────────────────────────────────────────
  const totalMs = Date.now() - pipelineStart;
  const totalSec = (totalMs / 1000).toFixed(1);
  console.log('\n' + '═'.repeat(60));
  console.log('✅  AI ADS AGENT — PIPELINE COMPLETE');
  console.log('═'.repeat(60));
  console.log(`  🆔 Asset ID     : ${asset._id}`);
  console.log(`  🤖 Model used   : ${selectedModel}`);
  console.log(`  ⏱  Total time   : ${totalSec}s (${totalMs}ms)`);
  console.log(`  🔗 Image URL    : ${imageUrl.substring(0, 80)}...`);
  console.log('═'.repeat(60) + '\n');

  logger.info(`[VisualPost] ✅ Pipeline complete in ${totalSec}s | AssetID=${asset._id} | Model=${selectedModel}`);
  return asset;
};

// const mockMediaGeneration = async () => "https://storage.googleapis.com/social_media_agent_assets/mock/ai_post.png"; // Removed for isolation
