import User from '../models/User.js';
import { verifyToken } from './authorization.js';
import { checkPremiumAccess } from '../services/subscriptionService.js';
import Subscription from '../models/Subscription.js';
import CreditLog from '../models/CreditLog.js';
import BrandProfile from '../models/BrandProfile.js';

// Returns true if user has any paid/active subscription or founder status
export const isFreeTierUser = async (userId) => {
    const user = await User.findById(userId);
    if (!user) return true;
    if (user.role === 'admin' || (user.email && user.email.toLowerCase() === 'admin@uwo24.com')) return false;
    if (user.founderStatus) return false;

    const sub = await Subscription.findOne({
        userId,
        subscriptionStatus: 'active'
    }).populate('planId');

    if (!sub || !sub.planId) return true;
    return sub.planId.priceMonthly === 0 && sub.planId.priceYearly === 0;
};

// Map URL → human-readable action label
const getActionLabel = (url, body) => {
    if (url.includes('/api/chat/realtime')) return { action: 'realtime_chat', description: 'AISA Realtime Chat' };
    if (url.includes('/api/aibase/knowledge')) return { action: 'knowledge_base', description: 'AISA Knowledge Base' };
    if (url.includes('/api/aibase/chat')) return { action: 'agent_chat', description: 'AISA Agent Chat' };
    if (url.includes('/api/edit-image')) return { action: 'edit_image', description: 'AISA Edit Image' };
    if (url.includes('/api/image')) {
        const model = body?.modelId || '';
        if (model.includes('ultra')) return { action: 'generate_image_ultra', description: 'AISA Image Ultra' };
        if (model.includes('hd')) return { action: 'generate_image_hd', description: 'AISA Image HD' };
        return { action: 'generate_image', description: 'AISA Image' };
    }
    if (url.includes('/api/video')) {
        if (body?.isImageToVideo === 'true') {
            return { action: 'video', description: 'Image to Video Magic' };
        }
        const model = body?.modelId || '';
        const res = body?.resolution || '1080p';
        const label = model.includes('fast') ? `AISA Video Fast (${res})` : `AISA Video Pro (${res})`;
        return { action: 'video', description: label };
    }
    if (url.includes('/api/chat')) {
        const mode = body?.mode || '';
        if (mode === 'web_search') return { action: 'web_search', description: 'AISA Web Search' };
        if (mode === 'DEEP_SEARCH') return { action: 'deep_search', description: 'AISA Deep Search' };
        if (mode === 'CODING_HELP') return { action: 'code_writer', description: 'AISA Code Writer' };
        if (mode === 'DOCUMENT_CONVERT') return { action: 'document_convert', description: 'AISA Document Magic' };
        return { action: 'chat', description: 'AISA Chat (Text)' };
    }
    if (url.includes('/api/voice')) return { action: 'convert_audio', description: 'AISA Audio Magic' };
    if (url.includes('/api/knowledge/upload') || url.includes('/api/knowledge/upload-url')) return { action: 'knowledge_base', description: 'AISA Knowledge Base' };
    if (url.includes('/api/legal-toolkit')) return { action: 'legal_toolkit', description: 'AISA AI Legal' };
    if (url.includes('/api/stock/')) return { action: 'ai_cashflow', description: 'AISA CashFlow Explorer (Tab Access)' };
    if (url.includes('/api/social-agent/generate/visual-post')) {
        if (body?.postFormat === 'carousel') {
            const count = Math.min(Math.max(parseInt(body?.carouselCount) || 3, 2), 4);
            return { action: 'ai_ads_agent', description: `AI Ads Agent — Carousel (${count} slides)` };
        }
        return { action: 'ai_ads_agent', description: 'AI Ads Agent (GPT-4 + Imagen 3)' };
    }
    if (url.includes('/api/social-agent/brand/upload')) return { action: 'brand_setup', description: 'AI Ads Agent (Brand Setup Save)' };
    if (url.includes('/api/social-agent/generate/calendar')) return { action: 'activate_strategy', description: 'AI Ads Agent (Strategy Activation)' };
    if (url.includes('/api/social-agent/content/generate/')) return { action: 'generate_content', description: 'AI Ads Agent (Content Generation)' };
    if (url.includes('/api/social-agent/generate/regenerate')) return { action: 'regenerate_content', description: 'AI Ads Agent (Regeneration)' };
    if (url.includes('/api/social-agent/generate')) return { action: 'generate_content', description: 'AI Ads Agent (Content Generation)' };
    if (url.includes('/api/social-agent/hashtag-insights')) return { action: 'regenerate_content', description: 'AI Ads Agent (Hashtags)' };
    if (url.includes('/api/brand/fetch') || url.includes('/api/brand/quick-analysis')) return { action: 'gemini_flash', description: 'AI Ads Agent (Website Scrapping)' };
    return { action: 'other', description: 'AISA Feature' };
};
// In-memory cache to prevent duplicate charges within a short window (e.g. 3 seconds)
const recentRequests = new Map();

export const creditMiddleware = async (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: "Unauthorized access" });
    }

    const url = req.originalUrl || req.url;
    const basePath = url.split('?')[0];
    const actionLabel = getActionLabel(url, req.body);
    const action = actionLabel.action;
    const symbol = req.query?.symbol || req.body?.symbol || '';
    const userId = req.user.id || req.user._id;
    const dedupKey = `${userId}:${action}:${basePath}:${symbol}`;

    // Clean up cache periodically (very simple)
    if (recentRequests.size > 2000) recentRequests.clear();

    const lastRequestTime = recentRequests.get(dedupKey);
    const now = Date.now();

    if (lastRequestTime && (now - lastRequestTime < 3000)) {
        console.log(`[CreditSystem] Deduplication triggered for ${dedupKey}. Skipping double charge.`);
        req.creditMeta = null; // Signal to controllers to skip deduction
        return next();
    }

    // Update timestamp for this request
    recentRequests.set(dedupKey, now);

    let cost = 0;
    let isPremiumEndpoint = false;

    // ── FREE TIER GUARD ──────────────────────────────────────────────────────
    const isPaidOnlyRoute =
        req.method !== 'GET' && (
            url.includes('/api/video')
        );

    // Admins bypass PLAN_RESTRICTED checks only
    const userRec = await User.findById(req.user.id || req.user._id);
    const isAdmin = (req.user && (req.user.role === 'admin' || (req.user.email && req.user.email.toLowerCase() === 'admin@uwo24.com'))) ||
        (userRec && (userRec.role === 'admin' || (userRec.email && userRec.email.toLowerCase() === 'admin@uwo24.com')));

    if (isPaidOnlyRoute && !isAdmin) {
        const freeTier = await isFreeTierUser(req.user.id || req.user._id);
        if (freeTier) {
            return res.status(403).json({
                success: false,
                code: 'PLAN_RESTRICTED',
                error: 'Video features are locked for free users. Please upgrade your plan to access Text-to-Video and Image-to-Video Magic Cards.',
                message: 'Video features are locked for free users. Please upgrade your plan to access Text-to-Video and Image-to-Video Magic Cards.'
            });
        }
    }
    // ── END FREE TIER GUARD ──────────────────────────────────────────────────

    // ── STARTER & FOUNDER VIDEO GUARD ────────────────────────────────────────
    if (url.includes('/api/video')) {
        const userRec = await User.findById(req.user.id || req.user._id);
        if (userRec && userRec.role !== 'admin') {
            const sub = await Subscription.findOne({
                userId: req.user.id || req.user._id,
                subscriptionStatus: 'active'
            }).populate('planId');

            const planName = (sub && sub.planId && sub.planId.planName) ? sub.planId.planName.toLowerCase() : '';
            if (planName.includes('starter') || planName.includes('founder') || (!planName && userRec.founderStatus)) {
                return res.status(403).json({
                    success: false,
                    code: 'PLAN_RESTRICTED',
                    error: `Text to Video features are not available on your current plan. Please upgrade to Pro or Business.`,
                    message: `Text to Video features are not available on your current plan. Please upgrade to Pro or Business.`
                });
            }
        }
    }
    // ── END STARTER & FOUNDER VIDEO GUARD ────────────────────────────────────

    // const actionLabel = getActionLabel(url, req.body); // Already fetched above
    let calculatedCost = 0;

    try {
        const { getToolCost } = await import('../services/subscriptionService.js');
        if (action === 'video') {
            calculatedCost = getToolCost('generate_video', req.body);
        } else if (action === 'chat') {
            const mode = req.body?.mode || '';
            if (mode && mode !== 'NORMAL_CHAT') {
                calculatedCost = getToolCost(mode, req.body);
            } else {
                calculatedCost = getToolCost('chat', req.body);
            }
        } else {
            calculatedCost = getToolCost(action, req.body);
        }
    } catch (e) {
        // Fallback default if subscriptionService fetch fails somehow
        calculatedCost = action === 'chat' ? 2 : 50;
    }

    cost = calculatedCost;

    // Override strategy cost based on selected Posting Frequency (reads from DB if available)
    if (action === 'activate_strategy') {
      const workspaceId = req.body?.workspaceId;
      let freq = '3x per week';
      
      if (workspaceId) {
        try {
          const bp = await BrandProfile.findOne({ workspaceId });
          if (bp && bp.postingFrequency) {
            freq = bp.postingFrequency.toLowerCase();
          }
        } catch (err) {
          console.error('[CreditSystem] Error fetching brand profile for frequency:', err);
        }
      }

      const isFreeForCost = await isFreeTierUser(userId);
      if (isFreeForCost && !isAdmin) {
        freq = '7 days'; // Free plan ALWAYS forced to 7 days
      }

      // Read costs from DB (admin-configurable), fall back to hardcoded defaults
      const getFreqCost = async (featureKey, defaultCost) => {
        try {
          const fc = await BrandProfile.db.model('FeatureCredit').findOne({ featureKey });
          return fc ? fc.cost : defaultCost;
        } catch { return defaultCost; }
      };

      if (freq.includes('7 days'))       cost = await getFreqCost('strategy_7days',    14);
      else if (freq.includes('1x'))       cost = await getFreqCost('strategy_1x_week',  15);
      else if (freq.includes('3x'))       cost = await getFreqCost('strategy_3x_week',  30);
      else if (freq === 'daily')          cost = await getFreqCost('strategy_daily',     60);
      else if (freq.includes('2x'))       cost = await getFreqCost('strategy_2x_daily', 120);
      else                                cost = await getFreqCost('strategy_daily',     60);

      console.log(`[CreditSystem] Strategy generation cost set to ${cost} credits for '${freq}' frequency (Free tier: ${isFreeForCost})`);
    }

    // Define explicitly which actions are premium-only (Free tier cannot access them regardless of credits)
    const premiumActions = ['video'];

    if (premiumActions.includes(action)) {
        isPremiumEndpoint = true;
    }

    // ── WEBSITE SCRAPING LIMIT FOR FREE USERS (max 2 scrapes) ────────────────
    // Only count against brand FETCH (website scraping), NOT brand/upload (manual save)
    const isWebsiteScrapeUrl = url.includes('/api/brand/fetch') || url.includes('/api/brand/quick-analysis');
    if (action === 'gemini_flash' && isWebsiteScrapeUrl && !isAdmin) {
        const freeTier = await isFreeTierUser(req.user.id || req.user._id);
        if (freeTier) {
            const fetchCount = await CreditLog.countDocuments({
                userId: req.user.id || req.user._id,
                action: 'gemini_flash'
            });
            if (fetchCount >= 2) {
                return res.status(403).json({
                    success: false,
                    code: 'UPGRADE_REQUIRED',
                    error: 'Free plan users are limited to 2 AI website scrapes. Upgrade to Pro for unlimited brand syncing.',
                    message: 'Free plan users are limited to 2 AI website scrapes. Upgrade to Pro for unlimited brand syncing.'
                });
            }
        }
    }

    // ── INITIAL LOAD FREEBIE FOR CASHFLOW ────────────────────────────────────
    if (url.includes('/api/stock/intraday') && req.query?.isInitialLoad === 'true') {
        cost = 0;
        console.log(`[CreditSystem] Bypassing credit deduction for initial AICashFlow load.`);
    }

    // Pass through if cost is still 0 
    if (cost === 0) return next();

    try {
        if (isPremiumEndpoint && !isAdmin) {
            const hasAccess = await checkPremiumAccess(req.user.id || req.user._id);
            if (!hasAccess) {
                return res.status(403).json({
                    success: false,
                    code: "PREMIUM_ONLY",
                    error: "This feature is not available in the free plan. Please upgrade your plan to access premium magic tools.",
                    message: "This feature is not available in the free plan. Please upgrade your plan to access premium magic tools."
                });
            }
        }

        const user = userRec || await User.findById(req.user.id || req.user._id);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (!isAdmin && user.credits < cost) {
            return res.status(403).json({
                error: "Insufficient credits",
                code: "OUT_OF_CREDITS",
                required: cost,
                available: user.credits
            });
        }

        // 🚀 ATTACH BALANCE INFO TO REQ
        // Deduction now happens in controllers ONLY on successful output
        req.creditMeta = {
            userId: user._id,
            cost: cost,
            action: actionLabel.action,
            description: actionLabel.description
        };

        next();
    } catch (error) {
        console.error("Credit deduction failed:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
