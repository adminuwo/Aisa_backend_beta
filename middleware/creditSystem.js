import User from '../models/User.js';
import { verifyToken } from './authorization.js';
import { checkPremiumAccess } from '../services/subscriptionService.js';
import Subscription from '../models/Subscription.js';
import CreditLog from '../models/CreditLog.js';

// Returns true if user has any paid/active subscription or founder status
const isFreeTierUser = async (userId) => {
    const user = await User.findById(userId);
    if (!user) return true;
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
    if (url.includes('/api/stock/')) return { action: 'aicashflow_tab', description: 'AISA CashFlow Explorer (Tab Access)' };
    return { action: 'other', description: 'AISA Feature' };
};

export const creditMiddleware = async (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: "Unauthorized access" });
    }

    let cost = 0;
    const url = req.originalUrl || req.url;
    let isPremiumEndpoint = false;

    // ── FREE TIER GUARD ──────────────────────────────────────────────────────
    const isPaidOnlyRoute =
        req.method !== 'GET' && (
            url.includes('/api/video') ||
            url.includes('/api/image') ||
            url.includes('/api/edit-image') ||
            url.includes('/api/chat/realtime') ||
            url.includes('/api/aibase/chat') ||
            url.includes('/api/aibase/knowledge') ||
            url.includes('/api/voice') ||
            req.body?.mode === 'web_search' ||
            req.body?.mode === 'DEEP_SEARCH'
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
                error: 'This feature is only available on paid plans. Please upgrade to access images, videos, and advanced chat.',
                message: 'This feature is only available on paid plans. Please upgrade to access images, videos, and advanced chat.'
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

    const actionLabel = getActionLabel(url, req.body);
    const action = actionLabel.action;
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
    } catch(e) {
        // Fallback default if subscriptionService fetch fails somehow
        calculatedCost = action === 'chat' ? 2 : 50; 
    }
    
    cost = calculatedCost;
    
    // Define explicitly which actions are premium-only (Free tier cannot access them regardless of credits)
    const premiumActions = ['video', 'image', 'generate_image', 'generate_image_hd', 'generate_image_ultra', 'edit_image', 'agent_chat', 'realtime_chat', 'voice', 'web_search', 'deep_search', 'knowledge_base'];
    
    if (premiumActions.includes(action)) {
        isPremiumEndpoint = true;
    } else if (action === 'chat' && req.body?.mode && req.body.mode !== 'NORMAL_CHAT') {
        isPremiumEndpoint = true;
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
