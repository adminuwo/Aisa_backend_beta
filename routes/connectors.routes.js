import express from 'express';
import { google } from 'googleapis';
import { verifyToken } from '../middleware/authorization.js';
import User from '../models/User.js';

const router = express.Router();

// OAuth2 Client Setup
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.AISA_BACKEND_URL}/api/connectors/gmail/callback`
);

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',   
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email'
];  

router.get('/gmail/auth', verifyToken, (req, res) => {
    const state = req.user.id || req.user._id;

    try {
        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline', // Requests a refresh token
            prompt: 'consent', // Force consent screen to guarantee refresh_token
            scope: SCOPES,
            state: state
        });
        res.json({ url });
    } catch (err) {
        console.error("Auth URL generation error:", err);
        res.status(500).json({ error: "Failed to generate auth URL" });
    }
});

router.get('/gmail/callback', async (req, res) => {
    const { code, state: userId, error } = req.query;

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (error) {
        return res.redirect(`${frontendUrl}?connector_error=${encodeURIComponent(error)}`);
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Fetch User Email Info to store
        const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2Api.userinfo.get();
        const emailAddress = userInfo.data.email;

        // Save tokens in DB
        const user = await User.findById(userId);
        if (!user) {
            throw new Error("User not found for state ID");
        }

        if (!user.personalizations) {
            user.personalizations = {};
            user.personalizations.apps = [];
        } else if (!user.personalizations.apps) {
            user.personalizations.apps = [];
        }

        // Check if Gmail app already connected
        const appIndex = user.personalizations.apps.findIndex(app => app.name === 'Gmail');
        const tokenData = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expiry_date: tokens.expiry_date,
            email_address: emailAddress
        };

        if (appIndex > -1) {
            if (!tokenData.refresh_token && user.personalizations.apps[appIndex].tokens?.refresh_token) {
                tokenData.refresh_token = user.personalizations.apps[appIndex].tokens.refresh_token;
            }
            user.personalizations.apps[appIndex].tokens = tokenData;
            user.personalizations.apps[appIndex].connectedAt = Date.now();
        } else {
            user.personalizations.apps.push({
                name: 'Gmail',
                enabled: true,
                permissions: 'ReadWrite',
                tokens: tokenData
            });
        }

        await user.save();
        res.redirect(`${frontendUrl}?connector_success=true`);

    } catch (err) {
        console.error("Gmail OAuth Callback Error:", err);
        res.redirect(`${frontendUrl}?connector_error=true`); // Redirect back with error
    }
});

router.delete('/gmail/disconnect', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const user = await User.findById(userId);

        if (user && user.personalizations && user.personalizations.apps) {
            const appIndex = user.personalizations.apps.findIndex(app => app.name === 'Gmail');
            if (appIndex > -1) {
                const token = user.personalizations.apps[appIndex].tokens?.refresh_token;

                // Remove from schema array
                user.personalizations.apps.splice(appIndex, 1);
                await user.save();

                if (token) {
                    try {
                        await oauth2Client.revokeToken(token);
                    } catch (e) { console.warn("Failed to revoke token on provider side:", e.message); }
                }

                return res.json({ success: true });
            }
        }
        res.json({ success: true, message: "Not connected" });
    } catch (err) {
        console.error("Disconnect Error", err);
        res.status(500).json({ error: "Failed to disconnect" });
    }
});

// Helper check endpoint for frontend to easily see status
router.get('/status', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const user = await User.findById(userId);

        if (user && user.personalizations && user.personalizations.apps) {
            const gmailApp = user.personalizations.apps.find(app => app.name === 'Gmail');
            if (gmailApp) {
                return res.json({
                    connected: true,
                    email: gmailApp.tokens?.email_address
                });
            }
        }
        return res.json({ connected: false });
    } catch (err) {
        res.status(500).json({ error: "Status check failed" });
    }
});

export default router;
