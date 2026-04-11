import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import CreditLog from '../models/CreditLog.js';
import FeatureCredit from '../models/FeatureCredit.js';

let featureCostCache = {};

export const refreshFeatureCostCache = async () => {
    try {
        const features = await FeatureCredit.find({});
        const newCache = {};
        features.forEach(f => {
            newCache[f.featureKey] = f.cost;
        });
        
        // Retain Video Multipliers manually since they are matrix-based
        newCache['video_multipliers'] = { 
            "veo-3.1-fast-generate-001": { "4k": newCache['video_veo_fast_4k'] || 585, "default": newCache['video_veo_fast_def'] || 250 }, 
            "veo-3.1-generate-001": { "4k": newCache['video_veo_pro_4k'] || 666, "default": newCache['video_veo_pro_def'] || 333 } 
        };
        
        if (Object.keys(newCache).length > 2) {
            featureCostCache = newCache;
        }
    } catch(e) {
        console.error("Failed to load Feature Credits into cache");
    }
};

// Start cache asynchronously
refreshFeatureCostCache();

export const getToolCost = (toolName, body = {}) => {
    // Merge hardcoded defaults with DB costs to ensure new features work
    const defaults = {
        chat: 2, web_search: 60, deep_search: 85, agent_chat: 60, realtime_chat: 60,
        knowledge_base: 3, generate_image: 66, generate_image_hd: 100, generate_image_ultra: 135,
        edit_image: 66, video_multipliers: { "veo-3.1-fast-generate-001": { "4k": 585, "default": 250 }, "veo-3.1-generate-001": { "4k": 666, "default": 333 } },
        code_writer: 3, convert_audio: 90, document_convert: 3, legal_toolkit: 250, aicashflow_tab: 5
    };

    const featureCosts = { ...defaults, ...featureCostCache };

    if (toolName === 'chat') {
        return featureCosts.chat; 
    }
    
    const normalizedTool = typeof toolName === 'string' ? toolName.toLowerCase() : toolName;
    if (normalizedTool === 'deep_search' || normalizedTool === 'web_search' || normalizedTool === 'code_writer') {
        return featureCosts[normalizedTool] || defaults[normalizedTool] || 0;
    }
    if (normalizedTool === 'convert_document' || normalizedTool === 'document_convert') {
        return featureCosts.document_convert || defaults.document_convert || 0;
    }
    
    if (toolName === 'generate_video') {
        const duration = body?.duration || 5;
        const modelId = body?.modelId || 'veo-3.1-fast-generate-001';
        const resolution = body?.resolution || '1080p';
        const videoMults = featureCosts.video_multipliers || defaults.video_multipliers;
        const modelMult = videoMults[modelId] || videoMults['veo-3.1-fast-generate-001'] || { "4k": 585, "default": 250 };
        const multiplier = resolution === '4k' ? (modelMult['4k'] || 585) : (modelMult['default'] || 250);
        return multiplier * duration;
    }
    
    return featureCosts[toolName] !== undefined ? featureCosts[toolName] : (defaults[toolName] || 0);
};

const getToolLabel = (toolName) => {
    switch ((toolName || '').toLowerCase()) {
        case 'chat': return 'AISA Chat (Text)';
        case 'agent_chat': return 'AISA Agent Chat';
        case 'realtime_chat': return 'AISA Realtime Chat';
        case 'knowledge_base': return 'AISA Knowledge Base';
        case 'web_search': return 'AISA Web Search';
        case 'deep_search': return 'AISA Deep Search';
        case 'generate_image_hd': return 'AISA Image HD';
        case 'generate_image_ultra': return 'AISA Image Ultra';
        case 'generate_image': return 'AISA Image';
        case 'edit_image': return 'AISA Edit Image';
        case 'generate_video': return 'AISA Video Generation';
        case 'code_writer': return 'AISA Code Writer';
        case 'convert_document': return 'AISA Document Analysis';
        case 'legal_toolkit': return 'AISA AI Legal';
        case 'aicashflow_tab': return 'AISA CashFlow Explorer (Tab Access)';
        default: return 'AISA Service';
    }
};

const premiumTools = [
    'generate_video',
    'generate_image',
    'generate_image_hd',
    'generate_image_ultra',
    'edit_image',
    'web_search',
    'deep_search',
    'realtime_chat',
    'agent_chat'
];

export const checkPremiumAccess = async (userId) => {
    const user = await User.findById(userId);
    if (!user) return false;
    if (user.founderStatus) return true;

    const sub = await Subscription.findOne({
        userId,
        subscriptionStatus: 'active'
    }).populate('planId');

    if (sub && sub.planId && (sub.planId.priceMonthly > 0 || sub.planId.priceYearly > 0)) {
        return true;
    }
    return false;
};

export const subscriptionService = {
    checkCredits: async (userId, toolsRequested = [], metadata = {}) => {
        const user = await User.findById(userId);
        if (!user) throw new Error("User not found");

        if (user.email && user.email.toLowerCase() === 'admin@uwo24.com') return true;

        const hasPremiumTool = toolsRequested.some(tool => premiumTools.includes(tool));
        if (hasPremiumTool) {
            const hasAccess = await checkPremiumAccess(userId);
            if (!hasAccess) {
                throw new Error("PREMIUM_RESTRICTED");
            }
        }

        const totalCost = toolsRequested.reduce((acc, tool) => acc + getToolCost(tool, metadata), 0);
        if ((user.credits || 0) < totalCost) {
            throw new Error("Insufficient credits");
        }
        return true;
    },

    deductCredits: async (userId, toolsUsed = [], sessionId, metadata = {}) => {
        const user = await User.findById(userId);
        if (!user) throw new Error("User not found");

        if (user.email && user.email.toLowerCase() === 'admin@uwo24.com') return true;

        const totalCost = toolsUsed.reduce((acc, tool) => acc + getToolCost(tool, metadata), 0);

        if ((user.credits || 0) < totalCost) {
            throw new Error("Insufficient credits");
        }

        if (totalCost > 0) {
            user.credits -= totalCost;
            await user.save();
        }

        // 📝 Log to Database - Find the most descriptive tool for the label
        try {
            // Pick a magic tool over 'chat' if multiple exist
            const nonChatTools = toolsUsed.filter(t => t !== 'chat');
            const primaryTool = nonChatTools.length > 0 ? nonChatTools[0] : toolsUsed[0];
            const otherToolsCount = toolsUsed.length > 1 ? toolsUsed.length - 1 : 0;
            
            await CreditLog.create({
                userId: user._id,
                action: primaryTool,
                description: getToolLabel(primaryTool) + (otherToolsCount > 0 ? ` (+${otherToolsCount} more)` : ''),
                credits: -totalCost,
                balanceAfter: user.credits
            });
        } catch (logErr) {
            console.error('CreditLog save failed in subscriptionService:', logErr.message);
        }

        return true;
    },

    deductCreditsFromMeta: async (creditMeta) => {
        if (!creditMeta || !creditMeta.userId || !creditMeta.cost || creditMeta.cost <= 0) {
            return true;
        }

        const user = await User.findById(creditMeta.userId);
        if (!user) throw new Error("User not found during credit deduction");

        user.credits -= creditMeta.cost;
        await user.save();

        // 📝 Log to Database
        try {
            console.log(`[CreditSystem] Deducting ${creditMeta.cost} for ${creditMeta.action} from user ${user._id}`);
            await CreditLog.create({
                userId: user._id,
                action: creditMeta.action || 'feature_usage',
                description: creditMeta.description || 'AISA Magic Feature',
                credits: -creditMeta.cost,
                balanceAfter: user.credits
            });
            console.log(`[CreditSystem] Log created successfully. New balance: ${user.credits}`);
        } catch (logErr) {
            console.error('CreditLog save failed in deductCreditsFromMeta:', logErr.message);
        }

        return true;
    },

    checkLimit: async () => ({ usage: 0, usageKey: 'mock' }),
    incrementUsage: () => { }
};

