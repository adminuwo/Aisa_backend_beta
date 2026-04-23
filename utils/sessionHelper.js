import Session from "../models/Session.js";

/**
 * Create a new session entry for a user.
 * @param {string} userId - The ID of the user.
 * @param {string} token - The JWT token.
 * @param {import('express').Request} req - The express request object.
 */
export const createSession = async (userId, token, req) => {
    try {
        const userAgent = req.headers['user-agent'] || "Unknown Device";
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "Unknown IP";
        
        // Simple manual parsing
        let device = "Desktop";
        if (/mobile/i.test(userAgent)) device = "Mobile";
        if (/tablet/i.test(userAgent)) device = "Tablet";

        let browser = "Other";
        if (/chrome|crios/i.test(userAgent)) browser = "Chrome";
        else if (/firefox|fxios/i.test(userAgent)) browser = "Firefox";
        else if (/safari/i.test(userAgent) && !/chrome|crios/i.test(userAgent)) browser = "Safari";
        else if (/opr\//i.test(userAgent)) browser = "Opera";
        else if (/edg/i.test(userAgent)) browser = "Edge";

        let os = "Other";
        if (/windows/i.test(userAgent)) os = "Windows";
        else if (/mac/i.test(userAgent)) os = "macOS";
        else if (/linux/i.test(userAgent)) os = "Linux";
        else if (/android/i.test(userAgent)) os = "Android";
        else if (/iphone|ipad|ipod/i.test(userAgent)) os = "iOS";

        await Session.create({
            userId,
            token,
            device,
            browser,
            os,
            ip,
            lastActive: Date.now()
        });
    } catch (err) {
        console.error("[SESSION ERROR] Failed to create session:", err);
    }
};

/**
 * Cleanup old sessions (optional, but good for maintenance)
 */
export const cleanupSessions = async (userId) => {
    try {
        // Keep only last 10 sessions? Or sessions from last 30 days?
        // For now, let's just keep them all or implement later.
    } catch (err) {
        console.error("[SESSION ERROR] Failed to cleanup sessions:", err);
    }
};
