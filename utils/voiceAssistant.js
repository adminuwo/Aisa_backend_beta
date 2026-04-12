/**
 * Voice Assistant Utility for AISA™
 * Handles intent classification, reminder/alarm extraction, and voice-friendly responses
 */

const INTENTS = {
    REMINDER_WITH_ALARM: 'reminder_with_alarm',
    REMINDER_NOTIFICATION_ONLY: 'reminder_notification_only',
    ALARM_ONLY: 'alarm_only',
    TASK_ONLY: 'task_only',
    CLARIFICATION_NEEDED: 'clarification_needed',
    CASUAL_CHAT: 'casual_chat'
};

// Keywords for intent detection
const REMINDER_KEYWORDS = ['remind', 'reminder', 'yaad', 'yaad dilana', 'yaad dila'];
const ALARM_KEYWORDS = ['alarm', 'wake', 'jagana', 'uthana', 'bajana'];
const VOICE_KEYWORDS = ['bolna', 'announce', 'speak', 'awaaz', 'awaaz me', 'bolo'];
const TIME_KEYWORDS = ['aaj', 'kal', 'parson', 'subah', 'dopahar', 'shaam', 'raat', 'minute', 'ghante', 'hour', 'baje'];

/**
 * Detect user intent from message
 */
export function detectIntent(message) {
    const lowerMessage = message.toLowerCase();

    const hasReminder = REMINDER_KEYWORDS.some(kw => lowerMessage.includes(kw));
    const hasAlarm = ALARM_KEYWORDS.some(kw => lowerMessage.includes(kw));
    const hasTime = TIME_KEYWORDS.some(kw => lowerMessage.includes(kw)) || /\d+/.test(message);

    if (hasReminder && hasAlarm) {
        return INTENTS.REMINDER_WITH_ALARM;
    }

    if (hasReminder && hasTime) {
        return INTENTS.REMINDER_NOTIFICATION_ONLY;
    }

    if (hasAlarm && hasTime) {
        return INTENTS.ALARM_ONLY;
    }

    if (hasReminder || hasAlarm) {
        return INTENTS.CLARIFICATION_NEEDED;
    }

    return INTENTS.CASUAL_CHAT;
}

/**
 * Parse natural language time to datetime
 */
export function parseNaturalTime(message, currentTime = new Date()) {
    const lowerMessage = message.toLowerCase();
    let targetDate = new Date(currentTime);

    // Handle relative days
    if (lowerMessage.includes('aaj') || lowerMessage.includes('today')) {
        // Keep current date
    } else if (lowerMessage.includes('kal') || lowerMessage.includes('tomorrow')) {
        targetDate.setDate(targetDate.getDate() + 1);
    } else if (lowerMessage.includes('parson')) {
        targetDate.setDate(targetDate.getDate() + 2);
    }

    // Handle time of day
    if (lowerMessage.includes('subah') || lowerMessage.includes('morning')) {
        targetDate.setHours(8, 0, 0, 0);
    } else if (lowerMessage.includes('dopahar') || lowerMessage.includes('afternoon')) {
        targetDate.setHours(14, 0, 0, 0);
    } else if (lowerMessage.includes('shaam') || lowerMessage.includes('evening')) {
        targetDate.setHours(18, 0, 0, 0);
    } else if (lowerMessage.includes('raat') || lowerMessage.includes('night')) {
        targetDate.setHours(21, 0, 0, 0);
    }

    // Handle specific time (e.g., "5 baje", "10:30")
    const timeMatch = message.match(/(\d+):?(\d+)?\s*(baje|am|pm)?/i);
    if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const meridiem = timeMatch[3];

        if (meridiem && meridiem.toLowerCase() === 'pm' && hours < 12) {
            hours += 12;
        }

        targetDate.setHours(hours, minutes, 0, 0);
    }

    // Handle relative time (e.g., "10 minute baad", "2 ghante baad")
    const minuteMatch = message.match(/(\d+)\s*(minute|min)/i);
    if (minuteMatch) {
        targetDate.setMinutes(targetDate.getMinutes() + parseInt(minuteMatch[1]));
    }

    const hourMatch = message.match(/(\d+)\s*(ghante|ghanta|hour)/i);
    if (hourMatch) {
        targetDate.setHours(targetDate.getHours() + parseInt(hourMatch[1]));
    }

    return targetDate;
}

/**
 * Extract reminder/alarm details from message
 */
export function extractReminderDetails(message) {
    const lowerMessage = message.toLowerCase();
    const intent = detectIntent(message);

    // Check if voice is requested
    const hasVoice = VOICE_KEYWORDS.some(kw => lowerMessage.includes(kw));

    // Extract title (simplified - take first few words or key phrase)
    let title = message.split(/\s+(ko|ka|ke|liye|for|to)\s+/i)[0];
    title = title.replace(/remind|reminder|alarm|yaad|jagana/gi, '').trim();
    title = title.substring(0, 50); // Limit length

    // Parse datetime
    const datetime = parseNaturalTime(message);

    // Determine notification and alarm flags
    const notification = intent.includes('reminder') || intent === INTENTS.REMINDER_WITH_ALARM;
    const alarm = intent.includes('alarm') || intent === INTENTS.REMINDER_WITH_ALARM;

    // Generate voice message
    const voiceMessage = generateVoiceMessage(title, lowerMessage);

    return {
        intent,
        title: title || 'Reminder',
        datetime: datetime.toISOString(),
        notification,
        alarm,
        voice: hasVoice,
        voice_message: voiceMessage
    };
}

/**
 * Generate voice-friendly message
 */
function generateVoiceMessage(title, originalMessage) {
    const lowerMessage = originalMessage.toLowerCase();

    // Check for common patterns
    if (lowerMessage.includes('medicine') || lowerMessage.includes('dawa')) {
        return 'Medicine lene ka time ho gaya hai';
    }

    if (lowerMessage.includes('meeting')) {
        return 'Meeting ka time ho gaya hai';
    }

    if (lowerMessage.includes('tea') || lowerMessage.includes('chai')) {
        return "It's time for tea";
    }

    // Default message
    return `${title} ka time ho gaya hai`;
}

/**
 * Detect language from message
 */
export function detectLanguage(message) {
    const hindiPattern = /[\u0900-\u097F]/; // Devanagari script
    const hinglishKeywords = ['hai', 'ka', 'ke', 'ko', 'me', 'se', 'aur', 'kya', 'kaise'];

    if (hindiPattern.test(message)) {
        return 'Hindi';
    }

    const lowerMessage = message.toLowerCase();
    const hasHinglish = hinglishKeywords.some(kw => lowerMessage.includes(` ${kw} `));

    if (hasHinglish) {
        return 'Hinglish';
    }

    return 'English';
}

import { getConfig } from '../services/configService.js';

/**
 * Get voice-optimized system instruction
 */
export function getVoiceSystemInstruction(language = 'English') {
    const responseLanguage = language === 'Hindi' || language === 'Hinglish' ? 'Hinglish' : 'English';

    const conversationalRules = getConfig('AISA_CONVERSATIONAL_RULES', '');
    const brandRules = getConfig('BRAND_SYSTEM_RULES', '');
    const voiceRules = getConfig('VOICE_FIRST_RULES', `### VOICE-FIRST RULES:
- IMPORTANT: You are in a hands-free voice conversation.
- Responses must be optimized for being spoken aloud via Text-to-Speech.
- Use short, clear sentences with natural pronunciation.
- Avoid all emojis, decorative symbols, and complex formatting.`);

    return `${conversationalRules}\n${brandRules}\n\n${voiceRules}\n- Respond in: ${responseLanguage}.`;
}

export { INTENTS };
