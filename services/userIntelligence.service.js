import UserProfile from '../models/UserProfile.model.js';
import BehaviorVector from '../models/BehaviorVector.model.js';
import ConversationMessage from '../models/ConversationMessage.js';
import * as vertexService from './vertex.service.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';
import { safeParseLLMJson } from '../utils/jsonUtils.js';

class UserIntelligenceService {
    
    /**
     * Entry point: Analyze a new interaction
     */
    async processInteraction(userId, message, role) {
        if (!userId || role !== 'user' || userId === 'admin') return;

        try {
            // 1. Update/Create raw behavior data
            await this.updateBehaviorMetrics(userId, message);

            // 2. Determine if we need to progress the 7-day plan
            await this.progressLearningCycle(userId);

        } catch (error) {
            logger.error(`[IntelligenceService] processInteraction Error: ${error.message}`);
        }
    }

    /**
     * Updates message-level metrics (Length, Hours, Questions)
     */
    async updateBehaviorMetrics(userId, message) {
        let vector = await BehaviorVector.findOne({ userId });
        if (!vector) vector = new BehaviorVector({ userId });

        const hour = new Date().getHours();
        
        // Rolling average for message length
        const currentAvg = vector.messageLengthAvg || 0;
        const count = vector.interactionCount || 0;
        vector.messageLengthAvg = ((currentAvg * count) + message.length) / (count + 1);
        
        // Track active hours
        if (!vector.activeHours.includes(hour)) {
            vector.activeHours.push(hour);
        }

        // Curiosity check (ends with ?)
        if (message.trim().endsWith('?')) {
            vector.questionFrequency += 1;
        }

        vector.interactionCount += 1;
        vector.lastAnalyzedAt = Date.now();
        await vector.save();
    }

    /**
     * The 7-Day Logic Engine
     */
    async progressLearningCycle(userId) {
        let profile = await UserProfile.findOne({ userId });
        if (!profile) {
            profile = await UserProfile.create({ userId });
        }

        const daysActive = Math.ceil((Date.now() - profile.trackingStartedAt) / (1000 * 60 * 60 * 24));
        
        // Only run deeper analysis every few interactions to save tokens
        const vector = await BehaviorVector.findOne({ userId });
        if (vector && vector.interactionCount % 5 === 0) {
            if (daysActive <= 2) {
                // Focus: Extraction of Onboarding Data if missing
                await this.extractOnboardingData(userId, profile);
            } else if (daysActive <= 4) {
                // Focus: Topic and Complexity Analysis
                await this.analyzeTopicDepth(userId, profile, vector);
            } else if (daysActive <= 7) {
                // Focus: Psychological Profiling
                await this.generatePsychProfile(userId, profile, vector);
            }
        }
    }

    async extractOnboardingData(userId, profile) {
        const recentMessages = await ConversationMessage.find({ user_id: userId })
            .sort({ createdAt: -1 })
            .limit(10);
        
        const historyText = recentMessages.map(m => `${m.role}: ${m.content}`).join('\n');
        
        const prompt = `Analyze the conversation history to extract user's onboarding info.
        Return JSON format: { "currentWork": "string", "targetSkills": ["string"], "goals": ["string"] }
        Use null if not found.
        
        History:
        ${historyText}`;

        try {
            const resultText = await vertexService.askVertex(prompt, null, { mode: 'JSON' });
            const data = safeParseLLMJson(resultText, {});
            
            if (data.currentWork) profile.onboarding.currentWork = data.currentWork;
            if (data.targetSkills) profile.onboarding.targetSkills = data.targetSkills;
            if (data.goals) profile.onboarding.goals = data.goals;
            
            await profile.save();
            logger.info(`[Intelligence] Extracted onboarding for user: ${userId}`);
        } catch (e) {
            logger.error(`[Intelligence] Onboarding Extraction Failed: ${e.message}`);
        }
    }

    async analyzeTopicDepth(userId, profile, vector) {
        // Logic to determine technical level based on vocab
        const complexity = vector.messageLengthAvg > 200 ? 'Complex' : 'Simple';
        profile.intelligence.complexityPreference = complexity;
        profile.intelligence.technicalLevel = Math.min(5, Math.ceil(vector.messageLengthAvg / 100));
        await profile.save();
    }

    async generatePsychProfile(userId, profile, vector) {
        // High-level psychology generation using LLM once every few days
        const recentMessages = await ConversationMessage.find({ user_id: userId })
            .sort({ createdAt: -1 })
            .limit(20);
        
        const historyText = recentMessages.map(m => `${m.role}: ${m.content}`).join('\n');

        const prompt = `Based on the following conversation history, classify the user's personality traits.
        Return JSON: { "motivationStyle": "Self-Driven|Social-Validation|Achievement-Oriented|Fear-Based", "learningStyle": "Visual|Practical|Theoretical|Concise|Detailed", "productivityPattern": "Deep-Worker|Quick-Responder|Multitasker|Night-Owl|Morning-Person" }
        
        History:
        ${historyText}`;

        try {
            const resultText = await vertexService.askVertex(prompt, null, { mode: 'JSON' });
            const data = safeParseLLMJson(resultText, {});
            
            profile.psychology = { ...profile.psychology, ...data };
            await profile.save();
            logger.info(`[Intelligence] Generated Psychology Profile for: ${userId}`);
        } catch (e) {
            logger.error(`[Intelligence] Psychology Analysis Failed: ${e.message}`);
        }
    }

    /**
     * Build the persona-specific injection for the System Prompt
     */
    async getPersonaInjection(userId) {
        const profile = await UserProfile.findOne({ userId });
        if (!profile) return "";

        const onboarding = profile.onboarding || {};
        const psychology = profile.psychology || {};
        const intelligence = profile.intelligence || {};
        
        let context = `\n### USER PERSONALITY PROFILE (AISA ADAPTIVE SYSTEM):\n`;
        
        if (onboarding.currentWork) context += `- Current Work: ${onboarding.currentWork}\n`;
        if (onboarding.goals?.length > 0) context += `- Goals: ${onboarding.goals.join(', ')}\n`;
        
        context += `- Motivation: ${psychology.motivationStyle || 'Standard'}\n`;
        context += `- Learning Style: ${psychology.learningStyle || 'Balanced'}\n`;
        context += `- Technical Level: ${intelligence.technicalLevel || 1}/5\n`;
        
        // Add specific instructions for AISA based on profile
        context += `\n### ADAPTIVE RESPONSE RULES:\n`;
        if (intelligence.complexityPreference === 'Simple') context += `- Use simple terms, avoid jargon.\n`;
        if (intelligence.complexityPreference === 'Complex') context += `- Provide deep technical details and architecture insights.\n`;
        if (psychology.learningStyle === 'Practical') context += `- Focus on code examples and actionable steps.\n`;
        if (psychology.learningStyle === 'Theoretical') context += `- Explain the "why" and underlying principles.\n`;
        
        return context;
    }
}

export default new UserIntelligenceService();
