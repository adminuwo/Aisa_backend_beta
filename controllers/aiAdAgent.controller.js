import AiAdAgent from '../models/AiAdAgent.js';
import User from '../models/User.js';

export const configureAiAdAgent = async (req, res) => {
    try {
        const { plan, companyOverview, contentCalendar, brandLogo, colorTheme, platforms } = req.body;
        const userId = req.user.id;

        // Check if user already has a config, update it or create new
        let agentConfig = await AiAdAgent.findOne({ userId });
        
        if (agentConfig) {
            agentConfig.plan = plan;
            agentConfig.companyOverview = companyOverview;
            agentConfig.contentCalendar = contentCalendar;
            agentConfig.brandLogo = brandLogo;
            agentConfig.colorTheme = colorTheme;
            agentConfig.platforms = platforms;
            agentConfig.status = "generating";
            await agentConfig.save();
        } else {
            agentConfig = await AiAdAgent.create({
                userId,
                plan,
                companyOverview,
                contentCalendar,
                brandLogo,
                colorTheme,
                platforms,
                status: "generating"
            });
        }

        // Trigger background generation (Mock)
        setTimeout(async () => {
            try {
                const config = await AiAdAgent.findById(agentConfig._id);
                if (!config) return;

                // Mock generation of 30 days of posts
                const mockPosts = [];
                const now = new Date();
                
                for (let i = 0; i < 31; i++) {
                    const scheduledDate = new Date(now);
                    scheduledDate.setDate(now.getDate() + i);
                    
                    mockPosts.push({
                        platform: config.platforms[i % config.platforms.length],
                        type: i % 3 === 0 ? "video" : (i % 2 === 0 ? "carousel" : "image"),
                        content: `Post for day ${i + 1}: Check out our amazing services! #AISA #Innovation`,
                        mediaUrl: "https://images.unsplash.com/photo-1611162617474-5b21e879e113", // Placeholder
                        scheduledDate,
                        status: "pending"
                    });
                }

                config.generatedAssets = mockPosts;
                config.status = "active";
                await config.save();
                console.log(`[AiAdAgent] Generated 30 day campaign for user ${userId}`);
            } catch (err) {
                console.error("[AiAdAgent Generation Error]", err);
            }
        }, 5000);

        res.status(200).json({ 
            success: true, 
            message: "AI Ad Agent configured and generation started",
            configId: agentConfig._id 
        });
    } catch (err) {
        console.error("[AiAdAgent Configure Error]", err);
        res.status(500).json({ error: "Failed to configure AI Ad Agent" });
    }
};

export const getAiAdPosts = async (req, res) => {
    try {
        const userId = req.user.id;
        const agentConfig = await AiAdAgent.findOne({ userId });
        
        if (!agentConfig) {
            return res.status(404).json({ error: "No AI Ad Agent config found" });
        }

        res.status(200).json({
            status: agentConfig.status,
            posts: agentConfig.generatedAssets
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch posts" });
    }
};

export const getAiAdStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const agentConfig = await AiAdAgent.findOne({ userId });
        
        if (!agentConfig) {
            return res.json({ status: "none" });
        }

        res.json({ 
            status: agentConfig.status,
            config: {
                plan: agentConfig.plan,
                platforms: agentConfig.platforms
            }
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch status" });
    }
};
