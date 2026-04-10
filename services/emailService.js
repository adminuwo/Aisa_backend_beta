import nodemailer from 'nodemailer';

// Email configuration from environment variables
const EMAIL_CONFIG = {
    service: process.env.EMAIL_SERVICE || 'gmail',
    user: process.env.EMAIL || process.env.EMAIL_USER || 'verification@ai-mall.in',
    password: process.env.EMAIL_PASSWORD || 'your-app-password',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@uwo24.com'
};

// Create transporter
const createTransporter = () => {
    try {
        // Use Resend SMTP if API key is provided
        if (process.env.RESEND_API_KEY) {
            return nodemailer.createTransport({
                host: "smtp.resend.com",
                port: 465,
                secure: true,
                auth: {
                    user: "resend", // Resend SMTP username is always "resend"
                    pass: process.env.RESEND_API_KEY
                }
            });
        }

        return nodemailer.createTransport({
            service: EMAIL_CONFIG.service,
            auth: {
                user: EMAIL_CONFIG.user,
                pass: EMAIL_CONFIG.password
            }
        });
    } catch (error) {
        console.error('[EMAIL SERVICE] Failed to create transporter:', error);
        return null;
    }
};

// Send email notification to admin when vendor submits ticket
export const sendAdminNotification = async (ticket) => {
    const transporter = createTransporter();
    if (!transporter) {
        console.warn('[EMAIL SERVICE] Transporter not configured, skipping email');
        return { success: false, message: 'Email service not configured' };
    }

    const mailOptions = {
        from: EMAIL_CONFIG.user,
        to: EMAIL_CONFIG.adminEmail,
        subject: `🎫 New Vendor Support Ticket - ${ticket.type}`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
                    <h1 style="color: white; margin: 0;">AISA Admin</h1>
                    <p style="color: #f0f0f0; margin: 5px 0 0 0;">New Support Ticket Received</p>
                </div>
                
                <div style="padding: 30px; background: #f9fafb;">
                    <h2 style="color: #1e293b; margin-top: 0;">Ticket Details</h2>
                    
                    <div style="background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                        <p style="margin: 10px 0;"><strong style="color: #64748b;">Ticket ID:</strong> <span style="color: #1e293b;">#${ticket._id.toString().substring(18).toUpperCase()}</span></p>
                        <p style="margin: 10px 0;"><strong style="color: #64748b;">Type:</strong> <span style="color: #1e293b;">${ticket.type}</span></p>
                        <p style="margin: 10px 0;"><strong style="color: #64748b;">User:</strong> <span style="color: #1e293b;">${ticket.userId?.name || ticket.userId || 'Anonymous'}</span></p>
                        <p style="margin: 10px 0;"><strong style="color: #64748b;">Email:</strong> <span style="color: #1e293b;">${ticket.userId?.email || 'No email provided'}</span></p>
                        <p style="margin: 10px 0;"><strong style="color: #64748b;">Status:</strong> <span style="padding: 4px 12px; background: #fef3c7; color: #92400e; border-radius: 20px; font-size: 12px; font-weight: bold;">${ticket.status.toUpperCase()}</span></p>
                    </div>
                    
                    <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                        <h3 style="color: #1e293b; margin-top: 0;">Description:</h3>
                        <p style="color: #475569; line-height: 1.6;">${ticket.description}</p>
                    </div>
                    
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${process.env.DASHBOARD_URL || 'https://aisa24.com/dashboard'}/admin" style="display: inline-block; background: #4f46e5; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">View in Admin Dashboard</a>
                    </div>
                </div>
                
                <div style="background: #f1f5f9; padding: 15px; border-radius: 0 0 10px 10px; text-align: center; color: #64748b; font-size: 12px;">
                    <p style="margin: 0;">AISA Platform - Admin Notifications</p>
                    <p style="margin: 5px 0 0 0;">This is an automated notification. Please do not reply to this email.</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('[EMAIL SERVICE] Admin notification sent successfully');
        return { success: true, message: 'Email sent to admin' };
    } catch (error) {
        console.error('[EMAIL SERVICE] Failed to send admin notification:', error);
        return { success: false, message: error.message };
    }
};

// Send reply from admin to vendor
export const sendVendorReply = async (vendorEmail, vendorName, message, ticketId) => {
    const transporter = createTransporter();
    if (!transporter) {
        console.warn('[EMAIL SERVICE] Transporter not configured, skipping email');
        return { success: false, message: 'Email service not configured' };
    }

    const mailOptions = {
        from: EMAIL_CONFIG.user,
        to: vendorEmail,
        subject: `✉️ Reply from AISA Admin - Ticket #${ticketId.substring(18).toUpperCase()}`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
                    <h1 style="color: white; margin: 0;">AISA</h1>
                    <p style="color: #f0f0f0; margin: 5px 0 0 0;">Admin Response</p>
                </div>
                
                <div style="padding: 30px; background: #f9fafb;">
                    <h2 style="color: #1e293b; margin-top: 0;">Hello ${vendorName},</h2>
                    <p style="color: #475569; margin-bottom: 20px;">Our admin team has responded to your support ticket.</p>
                    
                    <div style="background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                        <p style="margin: 0 0 10px 0;"><strong style="color: #64748b;">Ticket ID:</strong> <span style="color: #1e293b;">#${ticketId.substring(18).toUpperCase()}</span></p>
                        <div style="border-top: 2px solid #e2e8f0; margin: 15px 0; padding-top: 15px;">
                            <h3 style="color: #1e293b; margin-top: 0; font-size: 16px;">Admin's Response:</h3>
                            <p style="color: #1e293b; line-height: 1.6; white-space: pre-wrap;">${message}</p>
                        </div>
                    </div>
                    
                    <div style="background: #e0e7ff; padding: 15px; border-radius: 8px; border-left: 4px solid #4f46e5;">
                        <p style="margin: 0; color: #3730a3; font-size: 14px;"><strong>Need more help?</strong> Feel free to submit another support ticket from your vendor dashboard.</p>
                    </div>
                </div>
                
                <div style="background: #f1f5f9; padding: 15px; border-radius: 0 0 10px 10px; text-align: center; color: #64748b; font-size: 12px;">
                    <p style="margin: 0;">AISA Platform</p>
                    <p style="margin: 5px 0 0 0;">Thank you for being a valued vendor!</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('[EMAIL SERVICE] Vendor reply sent successfully to:', vendorEmail);
        return { success: true, message: 'Email sent to vendor' };
    } catch (error) {
        console.error('[EMAIL SERVICE] Failed to send vendor reply:', error);
        return { success: false, message: error.message };
    }
};

/**
 * Send feedback notification to admin
 */
export const sendFeedbackAdminNotification = async (feedback) => {
    const transporter = createTransporter();
    if (!transporter) {
        console.warn('[EMAIL SERVICE] Transporter not configured, skipping email');
        return { success: false, message: 'Email service not configured' };
    }

    const mailOptions = {
        from: EMAIL_CONFIG.user,
        to: EMAIL_CONFIG.adminEmail, // Direct requested email
        subject: `📢 New User Feedback - ${feedback.type === 'thumbs_up' ? 'Positive' : 'Negative'}`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <div style="background: ${feedback.type === 'thumbs_up' ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'}; padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
                    <h1 style="color: white; margin: 0;">New Feedback</h1>
                    <p style="color: #f0f0f0; margin: 5px 0 0 0;">User has submitted feedback on a chat response</p>
                </div>
                
                <div style="padding: 30px; background: #f9fafb;">
                    <div style="background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                        <p style="margin: 10px 0;"><strong style="color: #64748b;">Type:</strong> <span style="color: #1e293b; font-weight: bold;">${feedback.type === 'thumbs_up' ? '👍 Thumbs Up' : '👎 Thumbs Down'}</span></p>
                        <p style="margin: 10px 0;"><strong style="color: #64748b;">Session ID:</strong> <span style="color: #1e293b;">${feedback.sessionId}</span></p>
                        <p style="margin: 10px 0;"><strong style="color: #64748b;">Message ID:</strong> <span style="color: #1e293b;">${feedback.messageId}</span></p>
                    </div>
                    
                    ${feedback.categories && feedback.categories.length > 0 ? `
                        <div style="margin-bottom: 20px;">
                            <strong style="color: #64748b; font-size: 14px;">Categories:</strong>
                            <div style="margin-top: 8px;">
                                ${feedback.categories.map(cat => `<span style="display: inline-block; background: #e2e8f0; color: #475569; padding: 4px 10px; border-radius: 4px; font-size: 12px; margin-right: 5px; margin-bottom: 5px;">${cat}</span>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                    
                    <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                        <h3 style="color: #1e293b; margin-top: 0;">Details:</h3>
                        <p style="color: #475569; line-height: 1.6;">${feedback.details || 'No details provided'}</p>
                    </div>
                </div>
                
                <div style="background: #f1f5f9; padding: 15px; border-radius: 0 0 10px 10px; text-align: center; color: #64748b; font-size: 12px;">
                    <p style="margin: 0;">AISA Platform - Feedback System</p>
                    <p style="margin: 5px 0 0 0;">This is an automated notification.</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[EMAIL SERVICE] Feedback notification sent successfully to ${EMAIL_CONFIG.adminEmail}`);
        return { success: true, message: 'Email sent to admin' };
    } catch (error) {
        console.error('[EMAIL SERVICE] Failed to send feedback email:', error);
        return { success: false, message: error.message };
    }
};

/**
 * Send AI CashFlow Report to user
 */
export const sendCashFlowReport = async (userEmail, userName, stockData, analysis, news) => {
    const transporter = createTransporter();
    if (!transporter) {
        console.warn('[EMAIL SERVICE] Transporter not configured, skipping email');
        return { success: false, message: 'Email service not configured' };
    }

    const newsHtml = news.map(n => `
        <div style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #edf2f7;">
            <a href="${n.url}" style="color: #4f46e5; text-decoration: none; font-weight: bold; font-size: 16px;">${n.title}</a>
            <p style="margin: 5px 0; color: #718096; font-size: 14px;">${n.summary}</p>
            <span style="font-size: 12px; color: #a0aec0;">Source: ${n.source} | Sentiment: ${n.overall_sentiment_label}</span>
        </div>
    `).join('');

    const mailOptions = {
        from: EMAIL_CONFIG.user,
        to: userEmail,
        subject: `📈 AI CashFlow Report – ${stockData.symbol}`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 0 auto; background: #ffffff; color: #2d3748;">
                <div style="background: linear-gradient(135deg, #1a202c 0%, #2d3748 100%); padding: 40px 20px; text-align: center; color: white;">
                    <h1 style="margin: 0; font-size: 28px; letter-spacing: 1px;">AI CashFlow Report</h1>
                    <p style="margin: 10px 0 0; opacity: 0.8;">Market Insights & Automated Analysis</p>
                </div>

                <div style="padding: 30px; border: 1px solid #e2e8f0; border-top: none;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; border-bottom: 2px solid #edf2f7; padding-bottom: 20px;">
                        <div>
                            <h2 style="margin: 0; color: #1a202c; font-size: 24px;">${stockData.symbol}</h2>
                            <p style="margin: 5px 0; color: #718096; font-weight: 500;">Real-time Market Data</p>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 32px; font-weight: bold; color: #1a202c;">$${stockData.price}</div>
                            <div style="color: ${stockData.change.startsWith('-') ? '#e53e3e' : '#38a169'}; font-weight: bold;">
                                ${stockData.change} (${stockData.changePercent})
                            </div>
                        </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px;">
                        <div style="background: #f7fafc; padding: 15px; border-radius: 8px;">
                            <p style="margin: 0; color: #718096; font-size: 13px; text-transform: uppercase;">Day High</p>
                            <p style="margin: 5px 0 0; font-size: 18px; font-weight: bold;">$${stockData.high}</p>
                        </div>
                        <div style="background: #f7fafc; padding: 15px; border-radius: 8px;">
                            <p style="margin: 0; color: #718096; font-size: 13px; text-transform: uppercase;">Day Low</p>
                            <p style="margin: 5px 0 0; font-size: 18px; font-weight: bold;">$${stockData.low}</p>
                        </div>
                        <div style="background: #f7fafc; padding: 15px; border-radius: 8px;">
                            <p style="margin: 0; color: #718096; font-size: 13px; text-transform: uppercase;">Volume</p>
                            <p style="margin: 5px 0 0; font-size: 18px; font-weight: bold;">${Number(stockData.volume).toLocaleString()}</p>
                        </div>
                        <div style="background: #f7fafc; padding: 15px; border-radius: 8px;">
                            <p style="margin: 0; color: #718096; font-size: 13px; text-transform: uppercase;">Prev Close</p>
                            <p style="margin: 5px 0 0; font-size: 18px; font-weight: bold;">$${stockData.previousClose}</p>
                        </div>
                    </div>

                    <div style="margin-bottom: 40px;">
                        <h3 style="border-left: 4px solid #4f46e5; padding-left: 15px; color: #1a202c; margin-bottom: 20px;">AI Analysis & Insights</h3>
                        <div style="background: #f0f4ff; padding: 25px; border-radius: 12px; line-height: 1.6; color: #2d3748; white-space: pre-wrap;">${analysis}</div>
                    </div>

                    <div style="margin-bottom: 40px;">
                        <h3 style="border-left: 4px solid #4f46e5; padding-left: 15px; color: #1a202c; margin-bottom: 20px;">Correlated News Feed</h3>
                        ${newsHtml || '<p style="color: #a0aec0;">No recent news available for this ticker.</p>'}
                    </div>

                    <div style="background: #fff5f5; border: 1px solid #feb2b2; padding: 20px; border-radius: 8px; margin-top: 40px;">
                        <h4 style="margin: 0 0 10px; color: #c53030; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">Financial Disclaimer</h4>
                        <p style="margin: 0; color: #742a2a; font-size: 13px; line-height: 1.5;">
                            This report is generated for informational purposes only using AI analysis and market data from AlphaVantage. 
                            <strong>It does not constitute financial advice, investment recommendations, or a solicitation to buy/sell any securities.</strong> 
                            Always consult with a qualified financial advisor before making any investment decisions.
                        </p>
                    </div>

                    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #edf2f7; text-align: center; color: #a0aec0; font-size: 12px;">
                        <p style="margin: 0;">&copy; ${new Date().getFullYear()} AISA Intelligence Platform. All rights reserved.</p>
                        <p style="margin: 5px 0 0;">This report was requested by ${userName} (${userEmail}).</p>
                    </div>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        logger.info(`[EMAIL SERVICE] CashFlow report sent to ${userEmail}`);
        return { success: true, message: 'Report sent successfully' };
    } catch (error) {
        logger.error('[EMAIL SERVICE] Failed to send CashFlow report:', error);
        return { success: false, message: error.message };
    }
};
