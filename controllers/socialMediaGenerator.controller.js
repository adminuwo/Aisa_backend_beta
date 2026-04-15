import User from '../models/User.js';
import SocialMediaPost from '../models/SocialMediaPost.js';
import { generateImageFromPrompt } from './image.controller.js';
import { generateVideoFromPrompt } from './videoController.js';
import { AskVertexRaw } from '../services/vertex.service.js';
import axios from 'axios';
import * as xlsx from 'xlsx';
import logger from '../utils/logger.js';

/**
 * Save GCS URLs for the 3 inputs to the user profile
 */
export const saveInputs = async (req, res) => {
    try {
        const { calendar, overview, logo, plan } = req.body;
        const userId = req.user.id;

        await User.findByIdAndUpdate(userId, {
            socialMediaSettings: {
                calendarUrl: calendar,
                overviewUrl: overview,
                logoUrl: logo,
                plan: plan || 'Low'
            }
        });

        res.json({ success: true, message: 'Inputs saved successfully' });
    } catch (error) {
        logger.error(`[SocialMedia] SaveInputs Error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * Get all generated posts for the user
 */
export const getPosts = async (req, res) => {
    try {
        const userId = req.user.id;
        const posts = await SocialMediaPost.find({ userId }).sort({ scheduledDate: -1 });
        res.json({ success: true, posts });
    } catch (error) {
        logger.error(`[SocialMedia] GetPosts Error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * Trigger batch generation based on saved inputs
 */
export const triggerGeneration = async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);

        if (!user || !user.socialMediaSettings || !user.socialMediaSettings.calendarUrl) {
            return res.status(400).json({ success: false, error: 'Missing inputs' });
        }

        const { calendarUrl, overviewUrl, logoUrl, plan } = user.socialMediaSettings;

        // 1. Download and Parse Calendar
        const calendarResponse = await axios.get(calendarUrl, { responseType: 'arraybuffer' });
        const workbook = xlsx.read(calendarResponse.data);
        const sheetName = workbook.SheetNames[0];
        const calendarData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        // 2. Download Company Overview
        let companyOverview = "";
        try {
            const overviewResponse = await axios.get(overviewUrl);
            companyOverview = typeof overviewResponse.data === 'string' ? overviewResponse.data : JSON.stringify(overviewResponse.data);
        } catch (e) {
            logger.warn(`Could not fetch overview: ${e.message}`);
        }

        const postsToGenerate = calendarData.slice(0, 31); // Limit to 31 to cover all month lengths
        const generatedPosts = [];

        logger.info(`[SocialMedia] Starting batch generation for ${postsToGenerate.length} items`);

        // Update user status
        await User.findByIdAndUpdate(userId, { 'socialMediaSettings.lastGeneratedAt': new Date() });

        // Iterate through calendar items
        for (const item of postsToGenerate) {
            const postDate = item.Date || item.date;
            const postType = item.Post_Type || item.post_type || 'Image';
            const title = item.Title || item.title || 'Social Post';
            
            // AI Prompt for Content Refinement
            const prompt = `
                I am generating a high-quality social media post.
                Company Overview: ${companyOverview}
                Post Title: ${title}
                Post Type: ${postType}
                Hook: ${item.Hook || ''}
                Caption: ${item.Caption_Short || item.caption || ''}
                Hashtags: ${item.Hashtags || ''}
                
                Please return a JSON object with:
                {
                    "hook": "engaging hook",
                    "caption": "refined caption",
                    "hashtags": ["list", "of", "hashtags"],
                    "visualPrompt": "descriptive prompt for an AI image/video generator to create the post visual"
                }
            `;

            let aiContent;
            try {
                const aiResponse = await AskVertexRaw(prompt);
                // Clean up in case there's markdown
                const cleaned = aiResponse.replace(/```json\s*|\s*```/g, '').trim();
                aiContent = JSON.parse(cleaned);
            } catch (e) {
                logger.error(`AI content parse failed: ${e.message}`);
                aiContent = {
                    hook: item.Hook || '',
                    caption: item.Caption_Short || '',
                    hashtags: (item.Hashtags || '').split(',').map(s => s.trim()),
                    visualPrompt: title
                };
            }

            // Generate Visual
            let visualUrl = "";
            try {
                if (postType === 'Video' && (plan === 'High')) {
                    visualUrl = await generateVideoFromPrompt(aiContent.visualPrompt, 5, 'fast', '9:16');
                } else {
                    // Default to Image for Low/Medium or if Video fails
                    visualUrl = await generateImageFromPrompt(aiContent.visualPrompt, null, '1:1');
                }
            } catch (e) {
                logger.error(`Visual generation failed for ${title}: ${e.message}`);
            }

            const newPost = await SocialMediaPost.create({
                userId,
                title,
                postType,
                scheduledDate: new Date(postDate),
                content: {
                    hook: aiContent.hook,
                    caption: aiContent.caption,
                    hashtags: aiContent.hashtags
                },
                visualUrl,
                status: visualUrl ? 'Generated' : 'Failed',
                planType: plan
            });

            generatedPosts.push(newPost);
        }

        res.json({ success: true, posts: generatedPosts });

    } catch (error) {
        logger.error(`[SocialMedia] TriggerGeneration Error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
};
