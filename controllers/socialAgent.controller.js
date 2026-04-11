import GeneratedAsset from '../models/GeneratedAsset.js';
import logger from '../utils/logger.js';
import * as socialAgentService from '../services/socialAgent.service.js';
import * as generationService from '../services/generation.service.js';
import * as vertexService from '../services/vertex.service.js';
import * as openaiService from '../services/openai.service.js';
import * as brandProcessor from '../services/brandProcessor.service.js';
import User from '../models/User.js';
import path from 'path';

import SocialAgentWorkspace from '../models/SocialAgentWorkspace.js';
import BrandProfile from '../models/BrandProfile.js';
import ContentCalendar from '../models/ContentCalendar.js';
import CalendarEntry from '../models/CalendarEntry.js';
import PlanUsage from '../models/PlanUsage.js';
import UploadAsset from '../models/UploadAsset.js';

/**
 * Workspace Management
 */
export const createWorkspace = async (req, res) => {
  try {
    const { workspaceName, selectedPlatforms, planType } = req.body;
    const userId = req.user.id;

    const workspace = new SocialAgentWorkspace({
      userId,
      workspaceName: workspaceName || 'My Workspace',
      selectedPlatforms: selectedPlatforms || [],
      planType: planType || 'Low'
    });
    await workspace.save();

    // Initialize usage
    await socialAgentService.getOrInitPlanUsage(workspace._id, workspace.planType);

    res.status(201).json({ success: true, workspace });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const completeOnboarding = async (req, res) => {
  try {
    const {
      workspaceId, customName, role, industry,
      contentCreationTime, postingFrequency, adsComfortLevel, biggestChallenge,
      website, brandName, businessDescription, brandColors, fontFamily, targetEthnicity, logoUrl
    } = req.body;

    // 1. Update the Workspace onboarding status
    const workspace = await SocialAgentWorkspace.findByIdAndUpdate(
      workspaceId,
      {
        $set: {
          'onboarding.completed': true,
          'onboarding.role': role,
          'onboarding.industry': industry,
          'onboarding.customName': customName,
          'onboarding.contentCreationTime': contentCreationTime,
          'onboarding.postingFrequency': postingFrequency,
          'onboarding.adsComfortLevel': adsComfortLevel,
          'onboarding.biggestChallenge': biggestChallenge,
          'onboarding.website': website,
          workspaceName: `${customName}'s Workspace`
        }
      },
      { new: true }
    );

    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found' });

    // 2. Initialize or Update the BrandProfile with collected setup data
    let brandProfile = await BrandProfile.findOne({ workspaceId });
    if (!brandProfile) brandProfile = new BrandProfile({ workspaceId });

    if (brandName) {
      brandProfile.companyName = brandName;
      // NEW: Sync workspace name with Brand Name for cleaner UI
      await SocialAgentWorkspace.findByIdAndUpdate(workspaceId, { workspaceName: brandName });
    }
    if (businessDescription) brandProfile.companyOverviewText = businessDescription;
    if (brandColors && Array.isArray(brandColors)) brandProfile.brandColors = brandColors;
    if (fontFamily) brandProfile.fontFamily = fontFamily;
    if (targetEthnicity) brandProfile.targetEthnicity = targetEthnicity;
    if (logoUrl) brandProfile.logoUrl = logoUrl;

    await brandProfile.save();

    // Re-fetch workspace to get updated name
    const updatedWorkspace = await SocialAgentWorkspace.findById(workspaceId);

    res.json({ success: true, workspace: updatedWorkspace, brandProfile });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getAllWorkspaces = async (req, res) => {
  try {
    const mongoose = await import('mongoose');
    const workspaces = await SocialAgentWorkspace.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'brandprofiles', // Lowercase collection name for BrandProfile
          localField: '_id',
          foreignField: 'workspaceId',
          as: 'brandProfileData'
        }
      },
      {
        $lookup: {
          from: 'calendarentries', // Lowercase collection name for CalendarEntry
          localField: '_id',
          foreignField: 'workspaceId',
          as: 'calendarEntries'
        }
      },
      {
        $addFields: {
          brandProfile: { $arrayElemAt: ['$brandProfileData', 0] },
          calendarEntryCount: { $size: '$calendarEntries' }
        }
      },
      {
        $project: {
          brandProfileData: 0,
          calendarEntries: 0
        }
      }
    ]);
    res.json({ success: true, workspaces });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getWorkspace = async (req, res) => {
  try {
    // If a specific workspace is requested by ID, return that one
    const { id } = req.params;
    if (id && id !== 'current') {
      const workspace = await SocialAgentWorkspace.findOne({ _id: id, userId: req.user.id });
      if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found' });
      return res.json({ success: true, workspace });
    }

    // Otherwise return the OLDEST workspace first (the primary workspace with most data)
    const workspace = await SocialAgentWorkspace.findOne({ userId: req.user.id }).sort({ createdAt: 1 });
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found' });
    res.json({ success: true, workspace });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Brand Assets Upload
 */
export const uploadBrandAssets = async (req, res) => {
  try {
    const { 
      workspaceId, companyName, website, brandColors, themePreference, 
      toneOfVoice, ctaStyle, dosAndDonts, logoUrl, targetEthnicity, 
      extractedBrandSummary, targetIndustry, targetAudience, 
      contentObjective, campaignMonth, postingFrequency 
    } = req.body;

    let brandProfile = await BrandProfile.findOne({ workspaceId });
    if (!brandProfile) brandProfile = new BrandProfile({ workspaceId });

    if (companyName) brandProfile.companyName = companyName;
    if (website) brandProfile.website = website;
    if (logoUrl) brandProfile.logoUrl = logoUrl;
    if (brandColors) brandProfile.brandColors = typeof brandColors === 'string' ? JSON.parse(brandColors) : brandColors;
    if (themePreference) brandProfile.themePreference = themePreference;
    if (toneOfVoice) brandProfile.toneOfVoice = toneOfVoice;
    if (ctaStyle) brandProfile.ctaStyle = ctaStyle;
    if (dosAndDonts) brandProfile.dosAndDonts = dosAndDonts;
    if (targetEthnicity) brandProfile.targetEthnicity = targetEthnicity;
    if (extractedBrandSummary) brandProfile.extractedBrandSummary = extractedBrandSummary;

    // NEW STRATEGIC FIELDS
    if (targetIndustry) brandProfile.targetIndustry = targetIndustry;
    if (targetAudience) brandProfile.targetAudience = targetAudience;
    if (contentObjective) brandProfile.contentObjective = contentObjective;
    if (campaignMonth) brandProfile.campaignMonth = campaignMonth;
    if (postingFrequency) brandProfile.postingFrequency = postingFrequency;

    // Handle files (Logo and Overview)
    const logoFile = req.files && req.files.logo ? req.files.logo[0] : null;
    const overviewFile = req.files && req.files.overview ? req.files.overview[0] : null;

    console.log(`[Stage 1] Initializing DNA Synthesis for Workspace=${workspaceId}`);
    logger.info(`[Stage 1] DNA Pulse: ${companyName} | Industry: ${targetIndustry} | Objective: ${contentObjective}`);

    const results = await brandProcessor.processBrandIdentity({
      brandName: companyName,
      websiteUrl: website,
      logoBuffer: logoFile ? logoFile.buffer : null,
      pdfBuffer: overviewFile ? overviewFile.buffer : null,
      pdfMimeType: overviewFile ? overviewFile.mimetype : null,
      manualDescription: extractedBrandSummary || brandProfile.extractedBrandSummary || '',
      tone: toneOfVoice,
      ctaStyle: ctaStyle
    });

    // 1. Sync Base Properties & Structured Identity
    brandProfile.structuredIdentity = results.structuredIdentity;
    brandProfile.companyName = results.structuredIdentity.brand_name || brandProfile.companyName || companyName;
    brandProfile.website = website || brandProfile.website;
    brandProfile.brandColors = results.structuredIdentity.color_palette;
    brandProfile.toneOfVoice = results.structuredIdentity.tone || toneOfVoice;
    brandProfile.ctaStyle = results.structuredIdentity.cta_style || ctaStyle;
    brandProfile.companyOverviewText = results.rawKnowledgeBase; 
    
    // Sync new fields to structured identity if AI provided better ones, else keep manual
    brandProfile.targetIndustry = results.structuredIdentity.industry || targetIndustry || brandProfile.targetIndustry;
    brandProfile.targetAudience = results.structuredIdentity.target_audience || targetAudience || brandProfile.targetAudience;

    // 2. Handle Logo Upload
    if (logoFile) {
      const { url } = await socialAgentService.uploadToGCS(logoFile, `brands/${workspaceId}/logo`);
      brandProfile.logoUrl = url;
      await new UploadAsset({
        workspaceId, assetType: 'logo', gcsUrl: url,
        fileName: logoFile.originalname, mimeType: logoFile.mimetype
      }).save();
      console.log(`[Stage 1] Logo preserved in GCS: ${url}`);
    } else if (logoUrl) {
      brandProfile.logoUrl = logoUrl;
    }

    // 3. Handle Overview PDF Upload
    if (overviewFile) {
      const { url } = await socialAgentService.uploadToGCS(overviewFile, `brands/${workspaceId}/overview`);
      brandProfile.companyOverviewFileUrl = url;
      await new UploadAsset({
        workspaceId, assetType: 'overview', gcsUrl: url,
        fileName: overviewFile.originalname, mimeType: overviewFile.mimetype
      }).save();
      console.log(`[Stage 1] Strategy Doc preserved in GCS: ${url}`);
    }

    // --- OTHER PREFERENCES ---
    if (themePreference) brandProfile.themePreference = themePreference;
    if (dosAndDonts) brandProfile.dosAndDonts = dosAndDonts;
    if (targetEthnicity) brandProfile.targetEthnicity = targetEthnicity;

    await brandProfile.save();
    console.log(`[Stage 1] DNA Synthesis SUCCESS for Workspace=${workspaceId}`);

    // Sync Workspace Name for Clean Navigation
    if (brandProfile.companyName) {
      await SocialAgentWorkspace.findByIdAndUpdate(workspaceId, { workspaceName: brandProfile.companyName });
    }

    res.json({ success: true, brandProfile });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getBrandProfile = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const brandProfile = await BrandProfile.findOne({ workspaceId });
    if (!brandProfile) return res.status(404).json({ success: false, message: 'Brand profile not found' });
    res.json({ success: true, brandProfile });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Delete a Brand Workspace and all associated data (GCS + DB)
 */
export const deleteWorkspace = async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Security: only owner can delete
    const workspace = await SocialAgentWorkspace.findOne({ _id: workspaceId, userId: req.user.id });
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found or unauthorized' });

    // 1. Delete all GCS files under brands/{workspaceId}/
    try {
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
      const bucketName = process.env.GCS_social_media || 'social_media_agent_assets';
      const bucket = storage.bucket(bucketName);
      const prefix = `brands/${workspaceId}/`;
      const [files] = await bucket.getFiles({ prefix });
      if (files.length > 0) {
        await Promise.all(files.map(f => f.delete().catch(() => { })));
        logger.info(`[deleteWorkspace] Deleted ${files.length} GCS files under ${prefix}`);
      }
    } catch (gcsErr) {
      logger.warn(`[deleteWorkspace] GCS cleanup partial: ${gcsErr.message}`);
    }

    // 2. Delete all MongoDB documents for this workspace
    const GeneratedAsset = (await import('../models/GeneratedAsset.js')).default;
    const GeneratedPost = (await import('../models/GeneratedPost.js')).default;
    const GenerationJob = (await import('../models/GenerationJob.js')).default;

    await Promise.all([
      BrandProfile.deleteMany({ workspaceId }),
      ContentCalendar.deleteMany({ workspaceId }),
      CalendarEntry.deleteMany({ workspaceId }),
      UploadAsset.deleteMany({ workspaceId }),
      GeneratedAsset.deleteMany({ workspaceId }),
      GeneratedPost.deleteMany({ workspaceId }),
      GenerationJob.deleteMany({ workspaceId }),
      PlanUsage.deleteMany({ workspaceId }),
      SocialAgentWorkspace.findByIdAndDelete(workspaceId),
    ]);

    logger.info(`[deleteWorkspace] Workspace ${workspaceId} fully deleted`);
    res.json({ success: true, message: 'Brand deleted permanently' });
  } catch (error) {
    logger.error(`[deleteWorkspace] ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Content Calendar Upload & Parsing
 */
export const uploadCalendar = async (req, res) => {
  try {
    const { workspaceId } = req.body;
    if (!req.file) {
      console.error("[CALENDAR UPLOAD ERROR] No file provided in request");
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const file = req.file;
    const fileExt = path.extname(file.originalname).toUpperCase().replace('.', '');
    console.log(`[CALENDAR UPLOAD] Starting processing for file: ${file.originalname}, ext: ${fileExt}`);

    // 1. Upload to GCS — Organized path: brands/{workspaceId}/calendar/{filename}
    let url;
    try {
      const gcsResult = await socialAgentService.uploadToGCS(file, `brands/${workspaceId}/calendar`);
      url = gcsResult.url;
      console.log(`[CALENDAR UPLOAD] GCS Upload successful → brands/${workspaceId}/calendar/`);
    } catch (gcsErr) {
      console.error(`[CALENDAR UPLOAD] GCS Upload failed: ${gcsErr.message}`);
      throw new Error(`GCS Upload failed: ${gcsErr.message}`);
    }

    // 2. Parse File
    let rows;
    try {
      rows = await socialAgentService.parseCalendarFile(file.buffer, fileExt);
      console.log(`[CALENDAR UPLOAD] File parsed successfully. Rows found: ${rows.length}`);
    } catch (parseErr) {
      console.error(`[CALENDAR UPLOAD] Parsing failed: ${parseErr.message}`);
      throw new Error(`Parsing failed: ${parseErr.message}`);
    }

    // 2.5 Clear Existing Calendar Data (Replace instead of Append)
    await ContentCalendar.deleteMany({ workspaceId });
    await CalendarEntry.deleteMany({ workspaceId });
    console.log(`[CALENDAR UPLOAD] Cleared existing calendar pipeline entries for workspace.`);

    // 3. Save Calendar metadata
    const calendar = new ContentCalendar({
      workspaceId,
      sourceFileUrl: url,
      fileType: fileExt,
      totalRows: rows.length,
      parsedStatus: 'completed'
    });
    await calendar.save();

    // 4. Save Entries
    const entries = rows.map((row, index) => {
      // Helper to find case-insensitive keys (Excel headers can vary)
      const getVal = (keys) => {
        const found = Object.keys(row).find(k => keys.includes(k.trim().toLowerCase()));
        return found ? row[found] : undefined;
      };

      const titleVal = getVal(['title', 'topic', 'post title', 'content']);
      const dateVal = getVal(['date', 'day', 'schedule date', 'scheduled date']);
      const typeVal = getVal(['post type', 'type', 'format']);
      const hashVal = getVal(['hashtags', 'tags', 'tags list']);

      const normalizePostType = (val) => {
        if (!val) return 'image';
        const str = String(val).toLowerCase().trim();
        if (str.includes('reel')) return 'reel';
        if (str.includes('video') || str.includes('shorts')) return 'video';
        if (str.includes('carousel') || str.includes('slides')) return 'carousel';
        if (str.includes('story')) return 'story';
        return 'image';
      };

      return {
        workspaceId,
        calendarId: calendar._id,
        scheduledDate: dateVal ? new Date(dateVal) : new Date(),
        phase: getVal(['phase', 'stage', 'funnel stage']) || 'Awareness',
        platform: getVal(['platform', 'channel', 'social platform']) || 'Instagram',
        format: getVal(['format', 'layout']) || normalizePostType(typeVal),
        postType: normalizePostType(typeVal),
        post_type: typeVal || normalizePostType(typeVal),
        title: titleVal || 'Untitled Post',
        heading_hook: getVal(['heading', 'hook', 'heading / hook', 'title']),
        sub_heading: getVal(['subheading', 'sub-heading', 'subtitle']),
        contentType: getVal(['content type', 'category', 'theme']),
        hook: getVal(['hook', 'opening', 'subheading']),
        postContent: getVal(['post content', 'body', 'copy']),
        captionShort: getVal(['caption short', 'short caption', 'short ca']),
        captionLong: getVal(['caption long', 'long caption', 'long cap']),
        hashtags: hashVal ? String(hashVal).split(',').map(s => s.trim()) : [],
        breakdown: getVal(['breakdown', 'slide breakdown', 'reel breakdown', 'structure', 'slide / reel breakdown']),
        platformTargets: [],
        rawData: row
      };
    });

    try {
      if (entries.length > 0) {
        await CalendarEntry.insertMany(entries);

        // AUTO-TRIGGER: Generate first 3 days of posts immediately for the user
        // This ensures the dashboard is functional as soon as the input is provided
        generationService.startGenerationJob(workspaceId, 'today', { count: 3 })
          .catch(err => logger.error(`[Auto-Generate] Initial batch failed for ws ${workspaceId}: ${err.message}`));
      }
      console.log(`[CALENDAR UPLOAD] Successfully saved ${entries.length} calendar entries to DB.`);
    } catch (dbErr) {
      console.error(`[CALENDAR UPLOAD] Database insertion failed: ${dbErr.message}`);
      throw new Error(`Database insertion failed: ${dbErr.message}`);
    }

    await new UploadAsset({
      workspaceId,
      assetType: 'calendar',
      gcsUrl: url,
      fileName: file.originalname,
      mimeType: file.mimetype
    }).save();

    res.json({ success: true, calendar, entryCount: entries.length });
  } catch (error) {
    console.error("[CALENDAR UPLOAD CRITICAL ERROR]", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


export const getCalendarEntries = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const entries = await CalendarEntry.find({ workspaceId }).sort({ scheduledDate: 1 });
    res.json({ success: true, entries });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * One-off Asset Generation (Phase 2 Add-on)
 */
export const generateOneOffAsset = async (req, res) => {
  try {
    const { workspaceId, prompt, aspectRatio = '1:1', provider = 'vertex' } = req.body;
    if (!workspaceId || !prompt) {
      return res.status(400).json({ success: false, error: "workspaceId and prompt are required" });
    }

    logger.info(`[SocialAgent] Generating one-off image asset for workspace ${workspaceId}: ${prompt}`);

    let buffer;
    if (provider === 'openai') {
      buffer = await openaiService.generateImageDalle(prompt);
    } else {
      buffer = await vertexService.generateImageImagen(prompt);
    }

    // Upload to GCS — Organized path: brands/{workspaceId}/generated/
    const folder = `brands/${workspaceId}/generated`;
    const fileName = `manual_${Date.now()}.png`;
    const uploadResult = await socialAgentService.uploadBufferToGCS(buffer, fileName, 'image/png', folder);
    console.log(`[OneOff Asset] Saved to: ${folder}/`);

    const asset = new GeneratedAsset({
      workspaceId,
      assetType: 'image',
      gcsUrl: uploadResult.url,
      mimeType: 'image/png',
      metadata: { prompt, generatedAt: new Date() }
    });
    await asset.save();

    // Return a signed URL so it works in the UI even if the bucket is private
    const assetObj = asset.toObject();
    assetObj.gcsUrl = await socialAgentService.generateSignedUrl(asset.gcsUrl);

    res.json({ success: true, asset: assetObj });
  } catch (error) {
    logger.error(`[SocialAgent] generateOneOffAsset failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Usage Tracking
 */
export const getUsage = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const workspace = await SocialAgentWorkspace.findById(workspaceId);
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found' });

    const usage = await socialAgentService.getOrInitPlanUsage(workspaceId, workspace.planType);
    res.json({ success: true, usage, planType: workspace.planType });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Plan Update
 */
export const updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { planType } = req.body;

    const workspace = await SocialAgentWorkspace.findByIdAndUpdate(id, { planType }, { new: true });

    // Reset usage for the new plan
    const currentMonth = new Date().toISOString().slice(0, 7);
    let limits = { image: 30, carousel: 0, video: 0 };
    if (planType === 'Medium') limits = { image: 15, carousel: 15, video: 0 };
    if (planType === 'High') limits = { image: 10, carousel: 10, video: 10 };

    await PlanUsage.findOneAndUpdate(
      { workspaceId: id, billingMonth: currentMonth },
      { imageLimit: limits.image, carouselLimit: limits.carousel, videoLimit: limits.video },
      { upsert: true }
    );

    res.json({ success: true, workspace });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};



/**
 * Hashtag Studio Integration
 */
export const getHashtagInsights = async (req, res) => {
  try {
    const { workspaceId, topic } = req.body;
    if (!workspaceId || !topic) return res.status(400).json({ success: false, error: "workspaceId and topic are required" });

    const brand = await BrandProfile.findOne({ workspaceId });
    if (!brand) return res.status(404).json({ success: false, error: "Brand profile not found for this workspace" });

    const insights = await vertexService.generateHashtags(topic, brand);
    res.json({ success: true, insights });
  } catch (error) {
    logger.error(`[SocialAgent] getHashtagInsights failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};
/**
 * Global Profile Image Upload & Sync
 */
export const uploadProfileImage = async (req, res) => {
  try {
    const { workspaceId } = req.body;
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }

    // 1. Upload to GCS
    const { url } = await socialAgentService.uploadToGCS(req.file, `users/${userId}/avatars`);

    // 2. Sync with Social Agent Workspace
    const workspace = await SocialAgentWorkspace.findOneAndUpdate(
      { _id: workspaceId, userId },
      { $set: { 'onboarding.profileImageUrl': url } },
      { new: true }
    );

    // 3. Sync with Global User Profile (AI Ads Core)
    await User.findByIdAndUpdate(userId, { avatar: url });

    res.json({ success: true, url, workspace });
  } catch (error) {
    logger.error(`[SocialAgent] uploadProfileImage failed: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get brands that have active content pipelines
 */
export const getBrandsWithCalendars = async (req, res) => {
  try {
    const mongoose = await import('mongoose');
    const brands = await SocialAgentWorkspace.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
      {
        $lookup: {
          from: 'calendarentries',
          localField: '_id',
          foreignField: 'workspaceId',
          as: 'calendarEntries'
        }
      },
      {
        $addFields: {
          calendarEntryCount: { $size: '$calendarEntries' }
        }
      },
      { $match: { calendarEntryCount: { $gt: 0 } } },
      {
        $project: {
          workspaceName: 1,
          calendarEntryCount: 1,
          'onboarding.completed': 1
        }
      }
    ]);
    res.json({ success: true, brands });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * Get all pipelines (calendars) for a workspace
 */
export const getPipelines = async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const pipelines = await ContentCalendar.find({ workspaceId }).sort({ createdAt: -1 });
    res.json({ success: true, pipelines });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get all rows for a specific pipeline
 */
export const getPipelineRows = async (req, res) => {
  try {
    const { calendarId } = req.params;
    const rows = await CalendarEntry.find({ calendarId }).sort({ scheduledDate: 1 });
    res.json({ success: true, rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * Hard delete a calendar entry
 */
export const deleteCalendarEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const entry = await CalendarEntry.findByIdAndDelete(id);
    
    if (!entry) {
      return res.status(404).json({ success: false, message: "Calendar entry not found" });
    }

    res.json({ success: true, message: "Entry permanently removed from pipeline" });
  } catch (error) {
    logger.error(`[SocialAgent] deleteCalendarEntry failed: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

