import logger from '../utils/logger.js';
import * as vertexService from './vertex.service.js';
import { safeParseLLMJson } from '../utils/jsonUtils.js';
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
// Use the centralized safeParseLLMJson utility
const safeParse = (content) => safeParseLLMJson(content, []);

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
export const generate30DayStrategy = async (workspaceId, { maxDays = null } = {}) => {
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
    let userSelectedDuration = 30; // Default full month

    if (freq.includes('7 days')) {
      postsPerWeek = 7; // Daily
      userSelectedDuration = 7;
    } else if (freq.includes('2x') || freq.includes('high')) {
      postsPerWeek = 14;
    } else if (freq === 'daily') {
      postsPerWeek = 7;
    } else if (freq.includes('3x')) {
      postsPerWeek = 3;
    } else if (freq.includes('1x')) {
      postsPerWeek = 1;
    }

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

    // Calculate actual days — cap by maxDays for free plan, otherwise use user's selected duration
    const totalDaysInMonth = new Date(currentYear, monthIndex + 1, 0).getDate();
    const effectiveDays = maxDays ? Math.min(maxDays, totalDaysInMonth) : Math.min(userSelectedDuration, totalDaysInMonth);
    const totalWeeks = Math.ceil(effectiveDays / 7);

    console.log(`[Stage 2] Generating ${postsPerWeek} posts/week for ${brand.campaignMonth} (${effectiveDays}/${totalDaysInMonth} days, ${totalWeeks} week chunks) starting ${startDate.toDateString()}${maxDays ? ` [FREE PLAN: capped at ${maxDays} days]` : ''}`);

    const weekPromises = Array.from({ length: totalWeeks }).map(async (_, weekNum) => {
      const startDayIdx = weekNum * 7;
      const remainingDays = effectiveDays - startDayIdx;
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

// Helper: escape special characters for safe SVG text embedding
const escapeXml = (str = '') => str
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')
  .substring(0, 120); // cap length to avoid SVG overflow

/**
 * STEP 2.5 — BRAND OVERLAY (Sharp-based, 100% local, no external API)
 * ─────────────────────────────────────────────────────────────────────
 * Composites the brand logo (top-left) and a text banner (bottom) onto
 * the generated image using Sharp — no Gemini call, no region issues,
 * no quota errors. Runs in ~1-2s vs ~30s for the old Gemini path.
 *
 * Gracefully returns the original imageUrl if any step fails.
 */
const applyVisualOverlays = async (imageUrl, logoUrl, headingText, subheadingText, aspectRatio = '1:1') => {
  if (!logoUrl && !headingText && !subheadingText) {
    console.log('    [SharpOverlay] ⏩  Skipping — no text or logo to overlay.');
    return imageUrl;
  }

  console.log('    [SharpOverlay] 🎨 Compositing overlays locally via Sharp...');
  const overlayStart = Date.now();

  try {
    // ── 1. Download the main generated image ────────────────────────
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 45000 });
    const imageBuffer = Buffer.from(imageResponse.data);

    if (!imageBuffer || imageBuffer.byteLength < 100) {
      console.warn('    [SharpOverlay] ⚠️  Downloaded image is empty — skipping overlay.');
      return imageUrl;
    }

    // Get image dimensions for proportional sizing
    const meta = await sharp(imageBuffer).metadata();
    const W = meta.width || 1024;
    const H = meta.height || 1024;
    console.log(`    [SharpOverlay] 📐 Image: ${W}×${H}px`);

    const compositeInputs = [];

    // ── 2. Logo — download, convert to PNG, resize, place top-left ──
    if (logoUrl) {
      try {
        let logoResponse = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 20000 });
        let rawLogoBuffer = Buffer.from(logoResponse.data);
        let rawContentType = (logoResponse.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

        // Handle ICO → PNG via Google Favicon API
        if (rawContentType.includes('icon') || logoUrl.toLowerCase().endsWith('.ico')) {
          try {
            const domain = new URL(logoUrl).hostname;
            const fallbackRes = await axios.get(`https://www.google.com/s2/favicons?domain=${domain}&sz=256`, { responseType: 'arraybuffer', timeout: 10000 });
            rawLogoBuffer = Buffer.from(fallbackRes.data);
            console.log('    [SharpOverlay] 🔄 ICO → PNG via Favicon API');
          } catch (e) {
            console.warn('    [SharpOverlay] ⚠️  ICO fallback failed:', e.message);
          }
        }

        // Resize logo to 12% of image width (max 160px), convert to PNG
        const logoTargetWidth = Math.min(Math.round(W * 0.12), 160);
        const logoPng = await sharp(rawLogoBuffer, { failOn: 'none' })
          .resize({ width: logoTargetWidth, withoutEnlargement: true })
          .png()
          .toBuffer();

        // Add white semi-transparent rounded background behind logo for visibility
        const logoPadding = 10;
        const logoMeta = await sharp(logoPng).metadata();
        const bgW = (logoMeta.width || logoTargetWidth) + logoPadding * 2;
        const bgH = (logoMeta.height || logoTargetWidth) + logoPadding * 2;

        const logoBgSvg = `<svg width="${bgW}" height="${bgH}" xmlns="http://www.w3.org/2000/svg">
          <rect rx="12" ry="12" width="${bgW}" height="${bgH}" fill="rgba(255,255,255,0.75)"/>
        </svg>`;

        const logoBgBuffer = await sharp(Buffer.from(logoBgSvg)).png().toBuffer();

        // Composite: white bg → logo on top
        const logoWithBg = await sharp(logoBgBuffer)
          .composite([{ input: logoPng, left: logoPadding, top: logoPadding }])
          .png()
          .toBuffer();

        compositeInputs.push({ input: logoWithBg, top: 20, left: 20 });
        console.log(`    [SharpOverlay] 🖼  Logo ready: ${logoTargetWidth}px wide`);
      } catch (e) {
        console.warn('    [SharpOverlay] ⚠️  Logo processing failed:', e.message, '— skipping logo.');
      }
    }

    // ── 3. Text banner — SVG composite at the bottom ────────────────
    if (headingText || subheadingText) {
      const bannerH = Math.round(H * 0.18); // 18% of image height
      const headingSize = Math.max(22, Math.round(W / 22));
      const subSize = Math.max(16, Math.round(W / 32));
      const headingY = Math.round(bannerH * 0.42);
      const subY = Math.round(bannerH * 0.78);

      const safeHeading = escapeXml(headingText || '');
      const safeSub = escapeXml(subheadingText || '');

      const bannerSvg = `<svg width="${W}" height="${bannerH}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(0,0,0,0)"/>
            <stop offset="100%" stop-color="rgba(0,0,0,0.72)"/>
          </linearGradient>
          <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="rgba(0,0,0,0.9)"/>
          </filter>
        </defs>
        <rect width="${W}" height="${bannerH}" fill="url(#bg)"/>
        ${safeHeading ? `<text x="24" y="${headingY}" font-family="Arial, Helvetica, sans-serif" font-size="${headingSize}" font-weight="bold" fill="white" filter="url(#shadow)">${safeHeading}</text>` : ''}
        ${safeSub ? `<text x="24" y="${subY}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" fill="rgba(255,255,255,0.88)" filter="url(#shadow)">${safeSub}</text>` : ''}
      </svg>`;

      const bannerBuffer = await sharp(Buffer.from(bannerSvg)).png().toBuffer();
      compositeInputs.push({ input: bannerBuffer, top: H - bannerH, left: 0 });
      console.log(`    [SharpOverlay] 📝 Text banner ready (${bannerH}px, heading: "${safeHeading.substring(0, 30)}")`);
    }

    // ── 4. Composite everything onto the base image ──────────────────
    const composited = await sharp(imageBuffer)
      .composite(compositeInputs)
      .png()
      .toBuffer();

    // ── 5. Upload branded image to GCS ───────────────────────────────
    const gcsResult = await uploadToGCS(composited, {
      folder: 'generated_images',
      filename: gcsFilename('aisa_branded_post'),
      mimeType: 'image/png',
    });

    if (!gcsResult?.publicUrl) {
      console.warn('    [SharpOverlay] ⚠️  GCS upload failed — returning original image.');
      return imageUrl;
    }

    console.log(`    [SharpOverlay] ✅ Overlay complete in ${Date.now() - overlayStart}ms → ${gcsResult.publicUrl.substring(0, 60)}...`);
    return gcsResult.publicUrl;

  } catch (err) {
    console.error(`    [SharpOverlay] ❌ Overlay failed (${err.message}) — using original image.`);
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

  const companyName = brand.companyName || 'Brand';
  const brandColors = (brand.brandColors || []).slice(0, 3).join(', ') || 'brand palette';
  const tone = brand.toneOfVoice || brand.structuredIdentity?.tone || 'professional';
  const platform = entry.platform || 'Instagram';
  const rawPostType = (entry.postType || entry.format || 'image').toLowerCase().trim();
  const title = entry.title || entry.heading_hook || 'Post';
  const hook = entry.hook || entry.captionShort || '';
  const phase = entry.phase || 'Awareness';
  const targetEthnicity = brand.targetEthnicity || 'Global';

  // Normalise any free-text calendar value to a valid GeneratedAsset enum
  // CalendarEntries can have values like "Informative", "Promotional", "Educational", "Shorts", etc.
  const normalizeAssetType = (raw) => {
    if (raw.includes('carousel') || raw.includes('slide')) return 'carousel';
    if (raw.includes('reel')) return 'reel';
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
    { role: 'Hook', prefix: '', suffix: '' },
    { role: 'Problem', prefix: 'The Real Problem: ', suffix: '' },
    { role: 'Solution', prefix: 'The Fix: ', suffix: '' },
    { role: 'Proof', prefix: 'Why It Works: ', suffix: '' },
    { role: 'CTA', prefix: '', suffix: ' — Act Now' },
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
      slideTexts.forEach((s, i) => console.log(`       Slide ${i + 1}: "${s.heading}" / "${s.subheading}"`));
    } catch (e) {
      console.warn(`    ⚠️ Vertex variation call failed (${e.message}) — using smart local fallback.`);
      slideTexts = buildLocalVariations(carouselSlides.length);
    }

    // ── PHASE 1: Sequential Image Generation (quota-safe, 1.2s stagger) ─────────
    // Imagen has concurrent quota limits — we generate one slide at a time.
    console.log(`\n    ⚡ [Phase 1/2] Rendering ${carouselSlides.length} slides sequentially (1.2s apart)...`);
    const rawSlideUrls = []; // Collect all raw URLs first

    for (let i = 0; i < carouselSlides.length; i++) {
      const p = carouselSlides[i];
      console.log(`       -> Rendering Slide ${i + 1}/${carouselSlides.length}: "${p.substring(0, 40)}..."`);
      try {
        const rawSlideUrl = await generateImageFromPrompt(p, null, aspectRatio, selectedModel);
        if (rawSlideUrl) {
          rawSlideUrls.push({ url: rawSlideUrl, index: i });
          // ── Update job progress for frontend polling ──
          await GenerationJob.findByIdAndUpdate(jobId, {
            completedCount: i + 1,
            currentPhase: 'rendering'
          }).catch(() => {});
          console.log(`       ✅ Slide ${i + 1} image ready. (completedCount: ${i + 1}/${carouselSlides.length})`);
        } else {
          console.warn(`       ⚠️  Slide ${i + 1} returned empty URL — skipping.`);
          rawSlideUrls.push(null);
        }
      } catch (err) {
        console.error(`       ❌ Slide ${i + 1} image generation failed: ${err.message}`);
        rawSlideUrls.push(null);
      }
      // Stagger 1.2s between slides to avoid hitting Imagen's concurrent quota limit
      if (i < carouselSlides.length - 1) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    // ── PHASE 2: Staggered-Parallel Overlays ─────────────────────────────────────
    // Firing all overlays at once causes 429 quota errors (concurrent Gemini limit).
    // Instead, stagger starts by 3s per slide so they overlap but don't compete.
    // e.g. 3 slides: overlay1 starts t=0, overlay2 t=3s, overlay3 t=6s → all done ~t=35s
    // vs fully sequential: 3 × 30s = 90s  |  vs simultaneous: 429 quota errors
    const validSlideCount = rawSlideUrls.filter(Boolean).length;
    const OVERLAY_STAGGER_MS = 3000; // 3s gap between each overlay start
    console.log(`\n    🏷️  [Phase 2/2] Running ${validSlideCount} overlay(s) staggered (${OVERLAY_STAGGER_MS / 1000}s apart)...`);
    const overlayPhaseStart = Date.now();

    const overlayResults = await Promise.all(
      rawSlideUrls.map(async (slide, i) => {
        if (!slide) return null;
        // Stagger: slide i waits i × 3s before starting its overlay
        if (i > 0) await new Promise(r => setTimeout(r, i * OVERLAY_STAGGER_MS));

        const slideHeading = slideTexts[i]?.heading || title;
        const slideSubheading = slideTexts[i]?.subheading || hook;
        console.log(`       🏷️  Overlay Slide ${i + 1} starting (stagger: ${i * OVERLAY_STAGGER_MS / 1000}s offset)...`);
        try {
          const branded = await applyVisualOverlays(slide.url, brand.logoUrl, slideHeading, slideSubheading, aspectRatio);
          await GenerationJob.findByIdAndUpdate(jobId, {
            completedCount: i + 1,
            currentPhase: 'compositing'
          }).catch(() => {});
          console.log(`       ✅ Overlay Slide ${i + 1} done.`);
          return branded;
        } catch (err) {
          console.error(`       ❌ Overlay Slide ${i + 1} failed: ${err.message} — using raw image.`);
          return slide.url; // Graceful fallback to un-composited image
        }
      })
    );

    generatedSlides = overlayResults.filter(Boolean);
    console.log(`    ✅ All ${generatedSlides.length} overlay(s) completed in ${Date.now() - overlayPhaseStart}ms (staggered-parallel).`);


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
    completedCount: isCarousel ? generatedSlides.length : 1, // actual slide count, not hardcoded 1
    currentPhase: 'saving',
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
