import { google } from 'googleapis';
import User from '../../models/User.js';
import { AskVertexRaw } from '../vertex.service.js';
import logger from '../../utils/logger.js';

/**
 * Handle Gmail intents by parsing the request via AI and executing the corresponding Gmail API action.
 */
export const handleGmailIntent = async (userId, message) => {
    try {
        const user = await User.findById(userId);
        if (!user || !user.personalizations || !user.personalizations.apps) {
            return { text: "You need to connect your Gmail account in Profile Settings > Connectors." };
        }

        const gmailApp = user.personalizations.apps.find(app => app.name === 'Gmail');
        if (!gmailApp || !gmailApp.tokens || !gmailApp.tokens.access_token) {
            return { text: "Your Gmail account is not connected. Please connect it in Profile Settings > Connectors." };
        }

        // Set up auth client
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({
            access_token: gmailApp.tokens.access_token,
            refresh_token: gmailApp.tokens.refresh_token,
            expiry_date: gmailApp.tokens.expiry_date
        });

        // Optional: Listen for token refresh and save back to DB
        oauth2Client.on('tokens', async (tokens) => {
            if (tokens.refresh_token) {
                gmailApp.tokens.refresh_token = tokens.refresh_token;
            }
            if (tokens.access_token) {
                gmailApp.tokens.access_token = tokens.access_token;
                gmailApp.tokens.expiry_date = tokens.expiry_date;
            }
            await user.save();
            logger.info(`[GmailService] Tokens refreshed for user ${userId}`);
        });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Phase 1: Determine Action with AI
        const prompt = `You are a helpful assistant parsing a user's request for their Gmail account.
Extract the action they want to perform and format it as JSON.
        
User Request: "${message}"

Expected JSON Output format:
{
  "action": "READ_LATEST" | "SEARCH" | "SEND" | "DRAFT",
  "query": "string (optional searchQuery)",
  "to": "email address (if SEND/DRAFT)",
  "subject": "string (if SEND/DRAFT)",
  "body": "string content (if SEND/DRAFT)"
}

Only output valid JSON block, nothing else.`;

        const extraction = await AskVertexRaw(prompt, { temperature: 0.1 });
        let params;
        try {
            const cleanJson = extraction.replace(/```json|```/g, '').trim();
            params = JSON.parse(cleanJson);
        } catch (e) {
            return { text: "I couldn't understand what you wanted to do with your Gmail." };
        }

        // Phase 2: Execute Action
        if (params.action === 'READ_LATEST') {
            const res = await gmail.users.messages.list({ userId: 'me', maxResults: 5 });
            const messages = res.data.messages || [];
            if (messages.length === 0) return { text: "Your inbox is empty." };
            
            const summaries = await fetchAndSummarizeMessages(gmail, messages);
            return { text: `Here are your latest emails:\n\n${summaries}` };

        } else if (params.action === 'SEARCH') {
            const res = await gmail.users.messages.list({ userId: 'me', q: params.query || '', maxResults: 5 });
            const messages = res.data.messages || [];
            if (messages.length === 0) return { text: `No emails found for query: "${params.query}"` };

            const summaries = await fetchAndSummarizeMessages(gmail, messages);
            return { text: `Search results for "${params.query}":\n\n${summaries}` };

        } else if (params.action === 'SEND') {
            if (!params.to || (!params.subject && !params.body)) {
                return { text: "I need a recipient, subject, and body to send an email." };
            }
            
            const rawMessage = makeEmailRaw(params.to, user.email, params.subject, params.body);
            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: rawMessage }
            });
            return { text: `Email sent successfully to ${params.to}!` };

        } else if (params.action === 'DRAFT') {
            if (!params.to) {
                return { text: "I need at least a recipient to draft an email." };
            }
            
            const rawMessage = makeEmailRaw(params.to, user.email, params.subject, params.body);
            await gmail.users.drafts.create({
                userId: 'me',
                requestBody: { message: { raw: rawMessage } }
            });
            return { text: `Draft created successfully for ${params.to}!` };
            
        } else {
            return { text: `Unsupported Gmail action: ${params.action}` };
        }

    } catch (error) {
        logger.error(`[Gmail Service Error]: ${error.message}`);
        // Check for Auth failures to suggest reconnecting
        if (error.message.includes('invalid_grant') || error.message.includes('auth')) {
             return { text: "The connection to your Gmail account expired or is invalid. Please manually disconnect and reconnect your Gmail from the Settings > Connectors." };
        }
        return { text: `I encountered an error accessing your Gmail: ${error.message}` };
    }
};

// Helper: Make raw email format
function makeEmailRaw(to, from, subject, message) {
    const str = [
        "Content-Type: text/plain; charset=\"UTF-8\"\n",
        "MIME-Version: 1.0\n",
        `To: ${to}\n`,
        'From: "AISA Assistant" <' + from + '>\n',
        `Subject: =?utf-8?B?${Buffer.from(subject || '').toString('base64')}?=\n\n`,
        message || ''
    ].join('');
    
    return Buffer.from(str)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// Helper: Fetch payloads and extract snippet
async function fetchAndSummarizeMessages(gmail, messages) {
    let result = '';
    for (const msg of messages) {
        try {
            const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id });
            const payload = detail.data.payload;
            const headers = payload.headers;
            
            const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
            const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
            
            const subject = subjectHeader ? subjectHeader.value : '(No Subject)';
            const from = fromHeader ? fromHeader.value : 'Unknown';
            const snippet = detail.data.snippet || '';
            
            result += `- **From:** ${from}\n  **Subject:** ${subject}\n  **Summary:** ${snippet}\n\n`;
        } catch (e) {
            result += `- (Could not fetch email details)\n`;
        }
    }
    return result.trim();
}
