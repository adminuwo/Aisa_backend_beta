import logger from '../utils/logger.js';
import * as vertexService from './vertex.service.js';
import { AskOpenAIRaw } from './openai.service.js';
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

// --- JSON RECOVERY SYSTEM ---
function safeParse(content) {
  if (!content || typeof content !== 'string') return typeof content === 'object' ? content : [];
  
  let clean = content.replace(/```json\s*|\s*```/g, '').trim();

  // Try to find the most likely JSON boundary
  const firstBrace = clean.indexOf('{');
  const firstBracket = clean.indexOf('[');
  const lastBrace = clean.lastIndexOf('}');
  const lastBracket = clean.lastIndexOf(']');

  let startIdx = -1;
  if (firstBrace !== -1 && firstBracket !== -1) startIdx = Math.min(firstBrace, firstBracket);
  else startIdx = Math.max(firstBrace, firstBracket);

  const endIdx = Math.max(lastBrace, lastBracket);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const candidate = clean.substring(startIdx, endIdx + 1).trim();
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // If the full span fails, maybe there is garbage between two valid JSONs? 
      // Or maybe the endIdx is wrong because of a brace in a string.
      // We'll proceed to the aggressive fixer with the candidate.
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
    if (!brand || !brand.structuredIdentity) throw new Error("Run Brand Setup first.");

    let calendar = await ContentCalendar.findOne({ workspaceId });
    if (!calendar) calendar = await ContentCalendar.create({ workspaceId, currentPlan: [] });

    // 1. STRATEGY
    const strategistPrompt = `
      Create a 30-day content strategy.
      BRAND: ${JSON.stringify(brand.structuredIdentity)}
      GOAL: ${brand.contentObjective || "Awareness"}
      
      OUTPUT JSON (STRICT):
      {
        "strategy_summary": "Concise summary",
        "content_distribution": {"educational": "40%", "promotional": "30%", "engagement": "30%", "emotional": "0%"},
        "platform_plan": [{"platform": "Instagram", "strategy": "Concise"}],
        "weekly_themes": ["Week 1 Theme", "Week 2 Theme", "Week 3 Theme", "Week 4 Theme"]
      }
    `;

    const stratRes = await AskOpenAIRaw(strategistPrompt);
    const strategyDoc = safeParse(stratRes);

    await SocialAgentWorkspace.findByIdAndUpdate(workspaceId, {
      currentStrategy: {
        summary: strategyDoc.strategy_summary,
        distribution: strategyDoc.content_distribution,
        platform_plan: strategyDoc.platform_plan,
        weekly_themes: strategyDoc.weekly_themes
      }
    });

    // 2. CALENDAR
    const daysPerWeek = [7, 7, 7, 9];
    const startDate = new Date();
    
    const weekPromises = daysPerWeek.map(async (daysToGen, i) => {
      const idx = i;
      const startDayIdx = i === 0 ? 0 : daysPerWeek.slice(0, i).reduce((a, b) => a + b, 0);
      const builderPrompt = `
        Create a ${daysToGen}-day calendar Week ${idx+1}.
        BRAND: ${JSON.stringify(brand.structuredIdentity)}
        THEME: ${strategyDoc.weekly_themes[idx] || "General"}

        OUTPUT JSON ARRAY:
        [
          {
            "date": "YYYY-MM-DD", "phase": "...", "platform": "...", "format": "...", "post_type": "...",
            "heading_hook": "...", "sub_heading": "...", "short_caption": "...", "long_caption": "...",
            "hashtags": "...", "breakdown": "..."
          }
        ]
        
        Dates start: ${new Date(startDate.getTime() + startDayIdx * 86400000).toISOString().split('T')[0]}.
      `;

      const weekRes = await AskOpenAIRaw(builderPrompt);
      return safeParse(weekRes);
    });

    const results = await Promise.all(weekPromises);
    const strategyArray = results.flat();

    await CalendarEntry.deleteMany({ workspaceId, status: 'pending' });
    const entries = [];
    for (const item of strategyArray) {
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

    const excelBuffer = await socialAgentService.generateCalendarExcel(entries);
    const gcsRes = await socialAgentService.uploadBufferToGCS(excelBuffer, `Plan_${workspaceId}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Calendar');

    calendar.excelUrl = gcsRes.url;
    calendar.status = 'generated';
    await calendar.save();

    // AUTO-TRIGGER: Generate first 3 posts immediately so the dashboard is functional
    startGenerationJob(workspaceId, 'today', { count: 3 })
      .catch(err => logger.error(`[Auto-Generate] Initial strategy batch failed for ws ${workspaceId}: ${err.message}`));

    return { status: "success", calendar_id: calendar._id, excel_url: gcsRes.url, calendar: entries };
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

  const post = await GeneratedPost.create({
    workspaceId, calendarEntryId: entry._id, type, platform, version: 1,
    hook: copyOutput.hook, onAssetText: copyOutput.onAssetText, captionShort: copyOutput.captionShort,
    captionLong: copyOutput.captionLong, hashtags: copyOutput.hashtags, cta: copyOutput.cta, 
    variations: copyOutput.variations || [],
    status: 'draft'
  });

  logger.info(`[GenerationService] Orchestrating visual asset generation for post ${post._id}`);
  const mediaUrl = await mockMediaGeneration();
  const asset = await GeneratedAsset.create({ postId: post._id, workspaceId, assetType: type, gcsUrl: mediaUrl });

  post.primaryAssetId = asset._id;
  await post.save();

  if (usage) {
    logger.debug(`[GenerationService] Updating plan usage for ${workspaceId}`);
    updateUsage(usage, type);
  }
  
  entry.status = 'generated';
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
import { generateImageFromPrompt } from '../controllers/image.controller.js';

/**
 * AI ADS AGENT — VISUAL POST GENERATION PIPELINE
 * ─────────────────────────────────────────────────
 * Step 1 │ GPT-4    → Brand-aware Imagen prompt engineering
 * Step 2 │ Vertex AI Imagen 3/4 → High-quality visual render
 * Step 3 │ GCS      → Secure cloud storage
 * Step 4 │ MongoDB  → GeneratedAsset + Job update
 * Step 5 │ Calendar → Entry status marked "generated"
 */
export const generateVisualPostForEntry = async (workspaceId, entryId, jobId, modelId = 'imagen-3.0-generate-001') => {
  const pipelineStart = Date.now();

  console.log('\n' + '═'.repeat(60));
  console.log('🎨  AI ADS AGENT — VISUAL POST PIPELINE STARTED');
  console.log('═'.repeat(60));
  console.log(`  📋 Entry ID    : ${entryId}`);
  console.log(`  🏢 Workspace   : ${workspaceId}`);
  console.log(`  🔧 Job ID      : ${jobId}`);
  console.log(`  🤖 Model       : ${modelId}`);
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
  console.log('\n[Step 1/5] 🧠 GPT-4 Prompt Engineering...');
  const promptStart = Date.now();

  const promptEngineeringRequest = `You are an expert AI Image Prompt Engineer for social media advertising.

Generate a detailed, photorealistic Imagen 3 image generation prompt for the following social media post:

BRAND: ${companyName}
PLATFORM: ${platform} (${postType} format)
CAMPAIGN PHASE: ${phase}
POST TITLE: ${title}
HOOK: ${hook}
BRAND TONE: ${tone}
BRAND COLORS: ${brandColors}
TARGET AUDIENCE: ${targetEthnicity}

Requirements for the Imagen prompt:
- Make it photorealistic, high-quality, studio-grade
- Integrate the brand colors naturally into the composition
- Match the platform format (e.g. square for Instagram, landscape for LinkedIn)
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
  console.log(`    📝 Prompt preview: "${trimmedPrompt.substring(0, 120)}..."`);

  // ── STEP 2: Vertex AI Imagen Generation ─────────────────────────
  console.log(`\n[Step 2/5] 🖼  Vertex AI Imagen Generation...`);
  const imagenStart = Date.now();

  const selectedModel = modelId || 'imagen-3.0-generate-001';
  console.log(`    🤖 Calling model: ${selectedModel}`);
  console.log(`    📐 Aspect ratio : 1:1`);

  const imageUrl = await generateImageFromPrompt(trimmedPrompt, null, '1:1', selectedModel);

  if (!imageUrl) {
    console.error('[VisualPost] ❌ Vertex AI returned no image URL');
    throw new Error('Vertex AI Imagen returned no image URL');
  }

  const imagenMs = Date.now() - imagenStart;
  console.log(`    ✅ Image rendered in ${imagenMs}ms`);
  console.log(`    🔗 GCS URL: ${imageUrl.substring(0, 80)}...`);

  // ── STEP 3: Save GeneratedAsset to DB ────────────────────────────
  console.log('\n[Step 3/5] 💾 Saving GeneratedAsset to MongoDB...');
  const assetStart = Date.now();

  const assetName = `visual_${title.replace(/\s+/g, '_').substring(0, 30)}_${Date.now()}.png`;
  const asset = await GeneratedAsset.create({
    workspaceId,
    calendarEntryId: entry._id,
    assetType: postType,
    assetSource: 'generated',
    gcsUrl: imageUrl,
    mimeType: 'image/png',
    metadata: {
      prompt: trimmedPrompt,
      originalName: assetName,
      platform,
      phase,
      generatedAt: new Date(),
      modelUsed: selectedModel,
    }
  });

  console.log(`    ✅ GeneratedAsset saved: ${asset._id}`);
  console.log(`    📁 Asset name   : ${assetName}`);
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

  // ── STEP 5: Mark CalendarEntry as Generated ──────────────────────
  console.log('\n[Step 5/5] 📅 Updating CalendarEntry status...');
  entry.status = 'generated';
  await entry.save();
  console.log(`    ✅ Entry ${entryId} → status: "generated"`);

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

/**
 * AI ADS AGENT — BRANDED MAGIC CREATE PIPELINE (One-Off Asset)
 * ─────────────────────────────────────────────────
 * Step 1 │ GPT-4    → Brand-aware Imagen prompt engineering from user intent
 * Step 2 │ Vertex AI Imagen 3/4 → High-quality visual render
 * Step 3 │ GCS      → Secure cloud storage
 * Step 4 │ MongoDB  → GeneratedAsset
 */
export const generateOneOffVisualPost = async (workspaceId, userPrompt, modelId = 'imagen-3.0-generate-001') => {
  const pipelineStart = Date.now();

  console.log('\n' + '═'.repeat(60));
  console.log('✨  AI ADS AGENT — BRANDED MAGIC CREATE STARTED');
  console.log('═'.repeat(60));
  console.log(`  🏢 Workspace   : ${workspaceId}`);
  console.log(`  💡 User Intent : "${userPrompt.substring(0, 50)}..."`);
  console.log(`  🤖 Model       : ${modelId}`);
  console.log('─'.repeat(60));

  // ── LOAD: Brand Profile ────────────────────────
  console.log('\n[Step 0/4] 📂 Loading Brand Profile...');
  const dataLoadStart = Date.now();
  const brand = await BrandProfile.findOne({ workspaceId });
  
  if (!brand) throw new Error('Brand not found');

  const companyName     = brand.companyName || 'Brand';
  const brandColors     = (brand.brandColors || []).slice(0, 3).join(', ') || 'brand palette';
  const tone            = brand.toneOfVoice || brand.structuredIdentity?.tone || 'professional';
  const targetEthnicity = brand.targetEthnicity || 'Global';

  console.log(`    ✅ Brand        : "${companyName}"`);
  console.log(`    ✅ Brand colors : ${brandColors}`);
  console.log(`    ✅ Tone         : ${tone}`);
  console.log(`    ⏱  Loaded in ${Date.now() - dataLoadStart}ms`);

  // ── STEP 1: GPT-4 Prompt Engineering ────────────────────────────
  console.log('\n[Step 1/4] 🧠 GPT-4 Prompt Engineering...');
  const promptStart = Date.now();

  const promptEngineeringRequest = `You are an expert AI Image Prompt Engineer for social media advertising.

Generate a detailed, photorealistic Imagen 3 image generation prompt based on the user's intent, ensuring it perfectly matches their brand identity.

USER INTENT: ${userPrompt}

BRAND IDENTITY TO ENFORCE:
BRAND NAME: ${companyName}
BRAND TONE: ${tone}
BRAND COLORS: ${brandColors}
TARGET AUDIENCE: ${targetEthnicity}

Requirements for the Imagen prompt:
- Make it photorealistic, high-quality, studio-grade.
- Naturally integrate the brand colors into the composition (lighting, background, accents, or subjects).
- Ensure the mood matches the brand tone.
- NO text or logos in the image (clean visual only).
- Be extremely specific about subject, setting, lighting, and camera angle.

Output ONLY the raw Imagen prompt text, nothing else. No JSON, no explanation.`;

  console.log(`    📤 Sending context to GPT-4...`);

  const imagenPrompt = await AskOpenAIRaw(promptEngineeringRequest, null, {
    systemInstruction: 'You are an AI image prompt engineer. Output only the image generation prompt text.'
  });

  if (!imagenPrompt || imagenPrompt.trim().length < 20) {
    throw new Error('GPT-4 returned an empty image prompt');
  }

  const trimmedPrompt = imagenPrompt.trim();
  console.log(`    ✅ Prompt received in ${Date.now() - promptStart}ms`);
  console.log(`    📝 Prompt preview: "${trimmedPrompt.substring(0, 120)}..."`);

  // ── STEP 2: Vertex AI Imagen Generation ─────────────────────────
  console.log(`\n[Step 2/4] 🖼  Vertex AI Imagen Generation...`);
  const imagenStart = Date.now();
  console.log(`    🤖 Calling model: ${modelId}`);

  const imageUrl = await generateImageFromPrompt(trimmedPrompt, null, '1:1', modelId);

  if (!imageUrl) {
    throw new Error('Vertex AI Imagen returned no image URL');
  }

  console.log(`    ✅ Image rendered in ${Date.now() - imagenStart}ms`);
  console.log(`    🔗 GCS URL: ${imageUrl.substring(0, 80)}...`);

  // ── STEP 3: Save GeneratedAsset to DB ────────────────────────────
  console.log('\n[Step 3/4] 💾 Saving GeneratedAsset to MongoDB...');
  const assetStart = Date.now();
  
  const assetName = `magic_${Date.now()}.png`;
  const asset = await GeneratedAsset.create({
    workspaceId,
    assetType: 'image',
    assetSource: 'generated',
    gcsUrl: imageUrl,
    mimeType: 'image/png',
    metadata: {
      prompt: trimmedPrompt,
      originalIntent: userPrompt,
      originalName: assetName,
      generatedAt: new Date(),
      modelUsed: modelId,
    }
  });

  console.log(`    ✅ GeneratedAsset saved: ${asset._id}`);
  console.log(`    ⏱  Saved in ${Date.now() - assetStart}ms`);

  const totalMs = Date.now() - pipelineStart;
  console.log('\n' + '═'.repeat(60));
  console.log('✅  AI ADS AGENT — MAGIC CREATE COMPLETE');
  console.log('═'.repeat(60));
  console.log(`  ⏱  Total time   : ${(totalMs / 1000).toFixed(1)}s`);
  console.log('═'.repeat(60) + '\n');

  return asset;
};

const mockMediaGeneration = async () => "https://storage.googleapis.com/social_media_agent_assets/mock/ai_post.png";
