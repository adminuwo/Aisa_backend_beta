import express from 'express';
import * as socialAgentController from '../controllers/socialAgent.controller.js';
import { verifyToken } from '../middleware/authorization.js';
import { upload } from '../services/cloudinary.service.js';

const router = express.Router();

// Apply auth middleware to all routes
router.use(verifyToken);

/**
 * Workspace Routes
 */
// POST /api/social-agent/workspace - Create workspace
router.post('/workspace', socialAgentController.createWorkspace);

// PATCH /api/social-agent/finish-onboarding - Complete survey
router.patch('/finish-onboarding', socialAgentController.completeOnboarding);

// GET /api/social-agent/workspaces/all - Get all user workspaces
router.get('/workspaces/all', socialAgentController.getAllWorkspaces);

// GET /api/social-agent/workspace/:id - Get current workspace
router.get('/workspace/:id', socialAgentController.getWorkspace);

// PATCH /api/social-agent/workspace/:id/plan - Update current plan
router.patch('/workspace/:id/plan', socialAgentController.updatePlan);

// POST /api/social-agent/workspace/rapid-testing - Toggle 5-min testing


// DELETE /api/social-agent/workspace/:workspaceId - Permanently delete a brand workspace
router.delete('/workspace/:workspaceId', socialAgentController.deleteWorkspace);

/**
 * Brand Profile Routes
 */
// POST /api/social-agent/brand/upload - Upload brand logo and overview document
router.post('/brand/upload', upload.fields([
  { name: 'logo', maxCount: 1 }, 
  { name: 'overview', maxCount: 5 }
]), socialAgentController.uploadBrandAssets);

// POST /api/social-agent/profile/upload-image - Upload user profile picture
router.post('/profile/upload-image', upload.single('image'), socialAgentController.uploadProfileImage);

// GET /api/social-agent/brand/:workspaceId - Get brand profile for workspace
router.get('/brand/:workspaceId', socialAgentController.getBrandProfile);

/**
 * Calendar & Content Routes
 */
// POST /api/social-agent/calendar/upload - Upload CSV/XLSX calendar
router.post('/calendar/upload', upload.single('file'), socialAgentController.uploadCalendar);

// GET /api/social-agent/calendar/:workspaceId - Get all preview entries for workspace
router.get('/calendar/:workspaceId', socialAgentController.getCalendarEntries);

// GET /api/social-agent/calendar/brands - Get brands with active calendars
router.get('/calendar/brands', socialAgentController.getBrandsWithCalendars);

// GET /api/social-agent/calendar/pipelines/:workspaceId - Get all pipelines for a brand
router.get('/calendar/pipelines/:workspaceId', socialAgentController.getPipelines);

// GET /api/social-agent/calendar/pipeline-rows/:calendarId - Get rows for a specific pipeline
router.get('/calendar/pipeline-rows/:calendarId', socialAgentController.getPipelineRows);

// DELETE /api/social-agent/calendar/entry/:id - Delete a specific calendar entry
router.delete('/calendar/entry/:id', socialAgentController.deleteCalendarEntry);

/**
 * Usage Tracking
 */
// GET /api/social-agent/usage/:workspaceId - Get monthly quota vs usage
router.get('/usage/:workspaceId', socialAgentController.getUsage);

import * as generationController from '../controllers/generation.controller.js';

// --- Generation & Feed Routes (Phase 2) ---

/**
 * AI Generation & Job Management
 */
// POST /api/social-agent/generate - Single post / Daily run
router.post('/generate', generationController.triggerGeneration);

// POST /api/social-agent/generate/bulk - Batch generate for N days or selected rows
router.post('/generate/bulk', generationController.triggerGeneration);

// POST /api/social-agent/generate/regenerate - Variations with intent
router.post('/generate/regenerate', generationController.triggerRegeneration);

// GET /api/social-agent/jobs/:jobId - Poll job status
router.get('/jobs/:jobId', generationController.getJobStatus);

/**
 * Content Feed & Asset Library
 */
// GET /api/social-agent/posts/:workspaceId - Browse the generated feed
router.get('/posts/:workspaceId', generationController.getPosts);

// GET /api/social-agent/posts/detail/:postId - Deep dive into post + versions
router.get('/posts/detail/:postId', generationController.getPostDetail);

// DELETE /api/social-agent/posts/:postId - Remove post and its media
router.delete('/posts/:postId', generationController.deletePost);

// GET /api/social-agent/assets/:workspaceId - All generated media files for gallery
router.get('/assets/:workspaceId', generationController.getAssets);

// DELETE /api/social-agent/assets/:workspaceId - Hard delete all generated media files for a brand
router.delete('/assets/:workspaceId', generationController.deleteAllBrandAssets);

// --- Tab-Wise Generation Routes (Stage 3) ---
router.post('/content/generate/:calendarRowId', generationController.generateFromCalendarRow);
router.post('/generate/calendar', generationController.generateCalendar);
router.post('/generate/hashtags', generationController.getHashtags);
router.post('/hashtag-insights', generationController.getSocialHashtagInsights);
router.post('/generate/image-prompt', generationController.getImagePrompt);
router.get('/export/calendar', generationController.exportCalendarExcel);

// --- AI Ads Agent: Visual Post Generation Pipeline ---
// POST /api/social-agent/generate/visual-post
// Body: { workspaceId, calendarEntryId, modelId? }
// Returns: { jobId } — poll /jobs/:jobId for status & resultAssetId
router.post('/generate/visual-post', generationController.generateVisualPost);



// --- Previous Legacy Routes (Maintained for compatibility temporarily) ---
router.post('/inputs', socialAgentController.uploadBrandAssets);
router.get('/feed', (req, res) => res.json({ success: true, message: "Feed coming soon" }));

export default router;
