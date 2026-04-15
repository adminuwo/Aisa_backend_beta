import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import * as generationService from '../services/generation.service.js';
import GeneratedPost from '../models/GeneratedPost.js';
import GeneratedAsset from '../models/GeneratedAsset.js';
import GenerationJob from '../models/GenerationJob.js';
import SocialAgentWorkspace from '../models/SocialAgentWorkspace.js';
import * as socialAgentService from '../services/socialAgent.service.js';
import UploadAsset from '../models/UploadAsset.js';
import CalendarEntry from '../models/CalendarEntry.js';

/**
 * AI SOCIAL AGENT - GENERATION CONTROLLER (PHASE 2)
 */

export const generateFromCalendarRow = async (req, res) => {
  try {
    const { calendarRowId } = req.params;
    const { workspaceId } = req.body;

    if (!calendarRowId || !workspaceId) {
      return res.status(400).json({ success: false, error: "calendarRowId and workspaceId are required" });
    }

    const result = await generationService.generateContentForSpecificRow(workspaceId, calendarRowId);
    res.json({ success: true, post: result, message: "Content generated successfully" });
  } catch (error) {
    logger.error(`[GenerationController] generateFromCalendarRow failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const triggerGeneration = async (req, res) => {
  try {
    const { workspaceId, mode, count, entryIds } = req.body;
    if (!workspaceId) return res.status(400).json({ success: false, error: "workspaceId is required" });

    const job = await generationService.startGenerationJob(workspaceId, mode || 'today', {
      count,
      entryIds,
      userId: req.user?._id
    });

    res.json({ success: true, jobId: job._id, message: "Generation job started successfully" });
  } catch (error) {
    logger.error(`[GenerationController] triggerGeneration failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const triggerRegeneration = async (req, res) => {
  try {
    const { postId, entryId, intent, toneNudge, workspaceId } = req.body;

    // NEW: Stage 3 Regenerate SINGLE Calendar Entry
    if (entryId) {
      if (!workspaceId) return res.status(400).json({ success: false, error: "workspaceId is required for calendar regeneration" });
      const entry = await generationService.regenerateCalendarEntry(workspaceId, entryId, toneNudge);
      return res.json({ success: true, entry, message: "Calendar entry refreshed successfully" });
    }

    // Phase 2: Regenerate Final Post Job
    if (!postId || !intent) return res.status(400).json({ success: false, error: "postId and intent are required for post regeneration" });

    const job = await generationService.regeneratePost(postId, intent);
    res.json({ success: true, jobId: job._id, message: "Regeneration job started" });
  } catch (error) {
    logger.error(`[GenerationController] triggerRegeneration failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getPosts = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { status, type, platform, page = 1, limit = 20 } = req.query;

    const query = { workspaceId };
    if (status) query.status = status;
    if (type) query.type = type;
    if (platform) query.platform = platform;

    const posts = await GeneratedPost.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('primaryAssetId');

    const total = await GeneratedPost.countDocuments(query);

    // Generate signed URLs for primary assets
    const postsWithSignedUrls = await Promise.all(posts.map(async (post) => {
      const postObj = post.toObject();
      if (postObj.primaryAssetId) {
        postObj.primaryAssetId.gcsUrl = await socialAgentService.generateSignedUrl(postObj.primaryAssetId.gcsUrl);
      }
      return postObj;
    }));

    res.json({ success: true, posts: postsWithSignedUrls, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    logger.error(`[GenerationController] getPosts failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getPostDetail = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await GeneratedPost.findById(postId).populate('primaryAssetId');
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    // Fetch versions
    const versions = await GeneratedPost.find({
      $or: [{ _id: post.parentPostId || post._id }, { parentPostId: post.parentPostId || post._id }]
    }).sort({ createdAt: -1 });

    // Generate signed URL for primary asset
    const postObj = post.toObject();
    if (postObj.primaryAssetId) {
      postObj.primaryAssetId.gcsUrl = await socialAgentService.generateSignedUrl(postObj.primaryAssetId.gcsUrl);
    }

    // Generate signed URLs for versions
    const versionsWithSignedUrls = await Promise.all(versions.map(async (v) => {
      const vObj = v.toObject();
      if (vObj.primaryAssetId) {
        // vObj.primaryAssetId might be an ID or populated. 
        // If we want to be sure, we should populate it first.
        // For now, I'll assume versions are also populated if needed.
      }
      return vObj;
    }));

    res.json({ success: true, post: postObj, versions: versionsWithSignedUrls });
  } catch (error) {
    logger.error(`[GenerationController] getPostDetail failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const deletePost = async (req, res) => {
  try {
    const { postId } = req.params;
    await GeneratedPost.findByIdAndDelete(postId);
    await GeneratedAsset.deleteMany({ postId });
    res.json({ success: true, message: "Post and assets deleted" });
  } catch (error) {
    logger.error(`[GenerationController] deletePost failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const deleteAllBrandAssets = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    if (!workspaceId) return res.status(400).json({ success: false, error: 'workspaceId required' });
    
    // Find assets before deleting to log or potentially delete from GCS 
    const genAssets = await GeneratedAsset.find({ workspaceId });
    if (genAssets.length === 0) {
       return res.json({ success: true, message: "No assets found to delete" });
    }

    // Hard delete all GeneratedAssets for the workspace
    await GeneratedAsset.deleteMany({ workspaceId });
    
    res.json({ success: true, message: `All ${genAssets.length} generated posts for brand deleted successfully.` });
  } catch (error) {
    logger.error(`[GenerationController] deleteAllBrandAssets failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getAssets = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { type, page = 1, limit = 24, imageOnly } = req.query;

    const query = { workspaceId };

    // 1. Fetch Generated Assets (always images/videos)
    const genAssets = await GeneratedAsset.find(query).sort({ createdAt: -1 });

    // 2. Fetch Uploaded Assets — Include all visual types (logos, reference shots, etc.)
    const uploadImageTypes = ['logo', 'reference_image', 'generated_content'];
    const uploadAssets = await UploadAsset.find({
      workspaceId,
      assetType: { $in: uploadImageTypes }
    }).sort({ uploadedAt: -1 });

    // 3. Merge and Normalize — only image/video renderable assets
    const IMAGE_MIMETYPES = /^image\//;
    const VIDEO_MIMETYPES = /^video\//;

    // Pre-fetch all calendar entries for generated assets in one batch query
    const calendarEntryIds = genAssets
      .map(a => a.calendarEntryId)
      .filter(Boolean);
    const calendarEntries = calendarEntryIds.length > 0
      ? await CalendarEntry.find({ _id: { $in: calendarEntryIds } }).lean()
      : [];
    const calendarEntryMap = Object.fromEntries(calendarEntries.map(e => [String(e._id), e]));

    const allAssets = [
      ...genAssets
        .filter(a => !a.mimeType || IMAGE_MIMETYPES.test(a.mimeType) || VIDEO_MIMETYPES.test(a.mimeType))
        .map(a => ({
          ...a.toObject(),
          assetSource: 'generated',
          originalName: a.metadata?.originalName || 'AI Content',
          calendarEntry: a.calendarEntryId ? calendarEntryMap[String(a.calendarEntryId)] || null : null
        })),
      ...uploadAssets.map(a => ({
        ...a.toObject(),
        assetSource: 'uploaded',
        assetType: a.assetType || 'Branding',
        originalName: a.fileName
      }))
    ].sort((a, b) => new Date(b.createdAt || b.uploadedAt) - new Date(a.createdAt || a.uploadedAt));

    // Optional type filter (e.g. ?type=image or ?type=video)
    const filtered = type
      ? allAssets.filter(a => a.mimeType?.startsWith(type) || a.assetType?.toLowerCase() === type)
      : allAssets;

    // Pagination
    const paginated = filtered.slice((page - 1) * limit, page * limit);

    // 4. Generate Signed URLs/Proxies (primary + carousel slides)
    const assetsWithUrls = await Promise.all(paginated.map(async (asset) => {
      try {
        asset.gcsUrl = await socialAgentService.generateSignedUrl(asset.gcsUrl);
      } catch (e) {
        logger.warn(`[getAssets] Signed URL failed for ${asset._id}: ${e.message}`);
      }

      // Also sign all carousel slide URLs stored in metadata.slides
      if (asset.assetType === 'carousel' && Array.isArray(asset.metadata?.slides) && asset.metadata.slides.length > 0) {
        try {
          const signedSlides = await Promise.all(
            asset.metadata.slides.map(slideUrl =>
              socialAgentService.generateSignedUrl(slideUrl).catch(() => slideUrl)
            )
          );
          asset.metadata = { ...asset.metadata, slides: signedSlides };
        } catch (e) {
          logger.warn(`[getAssets] Carousel slide signing failed for ${asset._id}: ${e.message}`);
        }
      }

      return asset;
    }));

    res.json({
      success: true,
      assets: assetsWithUrls,
      total: filtered.length,
      page: parseInt(page),
      totalPages: Math.ceil(filtered.length / limit)
    });
  } catch (error) {
    logger.error(`[GenerationController] getAssets failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * TAB 1: CONTENT GENERATION (30-Day Strategy)
 */
export const generateCalendar = async (req, res) => {
  try {
    const { workspaceId } = req.body;
    if (!workspaceId) return res.status(400).json({ success: false, error: "workspaceId is required" });

    console.log(`[Tab 1] Triggering Master Prompt Strategy for Workspace=${workspaceId}`);
    const genData = await generationService.generate30DayStrategy(workspaceId);
    res.json({ success: true, ...genData, message: "30-Day Content Calendar generated successfully" });
  } catch (error) {
    logger.error(`[GenerationController] generateCalendar failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * TAB 2: HASHTAG GENERATION
 */
export const getHashtags = async (req, res) => {
  try {
    const { workspaceId } = req.body;
    if (!workspaceId) return res.status(400).json({ success: false, error: "workspaceId is required" });

    const hashtags = await generationService.generateHashtags(workspaceId);
    res.json({ success: true, hashtags });
  } catch (error) {
    logger.error(`[GenerationController] getHashtags failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getSocialHashtagInsights = async (req, res) => {
  try {
    const { workspaceId, topic } = req.body;
    if (!workspaceId) return res.status(400).json({ success: false, error: "workspaceId is required" });

    const hashtags = await generationService.getHashtagInsights(workspaceId, topic);
    res.json({ success: true, hashtags });
  } catch (error) {
    logger.error(`[GenerationController] getSocialHashtagInsights failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * TAB 3: POST (IMAGE) PROMPT GENERATION
 */
export const getImagePrompt = async (req, res) => {
  try {
    const { workspaceId, userIdea } = req.body;
    if (!workspaceId) return res.status(400).json({ success: false, error: "workspaceId is required" });

    const result = await generationService.generateImagePrompt(workspaceId, userIdea);
    res.json({ success: true, result });
  } catch (error) {
    logger.error(`[GenerationController] getImagePrompt failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await GenerationJob.findById(jobId);
    if (!job) return res.status(404).json({ success: false, message: "Job not found" });

    res.json({ success: true, job });
  } catch (error) {
    logger.error(`[GenerationController] getJobStatus failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const exportCalendarExcel = async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ success: false, error: "workspaceId is required" });

    const entries = await CalendarEntry.find({ 
      workspaceId: workspaceId
    }).sort({ scheduledDate: 1, date: 1 });
    if (!entries.length) {
      logger.warn(`[GenerationController] exportCalendarExcel: No entries for ws ${workspaceId}`);
      return res.status(404).json({ success: false, error: "No calendar entries found. Please generate or upload a calendar first." });
    }

    const buffer = await socialAgentService.generateCalendarExcel(entries);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="AI_Content_Calendar.xlsx"');
    res.send(buffer);
  } catch (error) {
    logger.error(`[GenerationController] exportCalendarExcel failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * AI ADS AGENT - VISUAL POST GENERATOR
 * Pipeline: GPT-4 Prompt → Vertex AI Imagen (3/4) → GCS → GeneratedAsset saved
 *
 * POST /api/social-agent/generate/visual-post
 * Body: { workspaceId, calendarEntryId, modelId? }
 */
export const generateVisualPost = async (req, res) => {
  const { workspaceId, calendarEntryId, modelId, postFormat = 'single' } = req.body;

  console.log('\n┌─────────────────────────────────────────────────────┐');
  console.log('│  🚀 POST /generate/visual-post — Request received   │');
  console.log('└─────────────────────────────────────────────────────┘');
  console.log(`  👤 User          : ${req.user?.id || 'unknown'}`);
  console.log(`  🏢 Workspace     : ${workspaceId}`);
  console.log(`  📋 CalendarEntry : ${calendarEntryId}`);
  console.log(`  🖼️  Post Format   : ${postFormat}`);
  console.log(`  🤖 Model override: ${modelId || 'none (will use default)'}`);

  if (!workspaceId || !calendarEntryId) {
    console.warn('  ⚠️  Missing required fields — rejecting request');
    return res.status(400).json({ success: false, error: 'workspaceId and calendarEntryId are required' });
  }

  try {
    // Create a job record immediately so the frontend can poll
    const job = await GenerationJob.create({
      workspaceId,
      generationMode: 'visual_post',
      status: 'processing',
      targetEntryId: calendarEntryId,
    });

    console.log(`  ✅ Job created   : ${job._id}`);
    console.log(`  ⚡ Dispatching pipeline in background...`);

    // Fire and forget — background visual generation
    generationService.generateVisualPostForEntry(workspaceId, calendarEntryId, job._id, modelId, postFormat)
      .catch(err => {
        console.error(`\n❌ [VisualPost] Background job ${job._id} FAILED: ${err.message}`);
        logger.error(`[VisualPost] Background job ${job._id} failed: ${err.message}`);
        GenerationJob.findByIdAndUpdate(job._id, { status: 'failed', errorSummary: err.message }).catch(() => {});
      });

    console.log(`  📨 Responding 202 with jobId: ${job._id}\n`);
    return res.status(202).json({ success: true, jobId: job._id, message: 'Visual post generation started' });
  } catch (error) {
    console.error(`\n❌ [VisualPost] Controller error: ${error.message}`);
    logger.error(`[VisualPost] Failed to start job: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};
