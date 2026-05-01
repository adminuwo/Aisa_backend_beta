import puppeteer from 'puppeteer';
import fs from 'fs';
import logger from '../../../utils/logger.js';

/**
 * Generate a professional legal PDF for a precedent
 * @param {Object} precedentData 
 * @returns {Promise<Buffer>} PDF buffer
 */
export const generatePrecedentPDF = async (precedentData) => {
    let browser;
    try {
        const {
            case_identity = {},
            case_context = {},
            judgment_outcome = {},
            judgment_basis = {},
            key_takeaways = []
        } = precedentData;

        const caseTitle = case_identity.case_name || precedentData.case_name || "Legal Precedent";
        const courtName = case_identity.court || precedentData.court || "Unknown Court";
        const citation = case_identity.citation || precedentData.citation || "Citation N/A";
        const date = case_identity.year || precedentData.year || "Year N/A";
        
        // Extract area/district information
        const district = case_identity.district || precedentData.district || "";
        const area = case_identity.area || precedentData.area || "";
        const location = [district, area].filter(Boolean).join(", ");

        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body {
                        font-family: 'Times New Roman', Times, serif;
                        line-height: 1.6;
                        color: #1a1a1a;
                        margin: 0;
                        padding: 40px;
                        background: #fff;
                    }
                    .header {
                        text-align: center;
                        border-bottom: 2px solid #333;
                        margin-bottom: 30px;
                        padding-bottom: 20px;
                    }
                    .case-title {
                        font-size: 24pt;
                        font-weight: bold;
                        margin-bottom: 10px;
                        text-transform: uppercase;
                        color: #000;
                    }
                    .court-name {
                        font-size: 16pt;
                        font-weight: bold;
                        color: #444;
                        margin-bottom: 5px;
                    }
                    .location-info {
                        font-size: 13pt;
                        font-weight: bold;
                        color: #555;
                        margin-bottom: 8px;
                        text-transform: uppercase;
                    }
                    .citation {
                        font-size: 12pt;
                        color: #666;
                        font-style: italic;
                    }
                    .section {
                        margin-bottom: 25px;
                    }
                    .section-title {
                        font-size: 14pt;
                        font-weight: bold;
                        text-transform: uppercase;
                        border-bottom: 1px solid #ddd;
                        padding-bottom: 5px;
                        margin-bottom: 10px;
                        color: #2c3e50;
                    }
                    .content {
                        font-size: 11pt;
                        text-align: justify;
                        white-space: pre-wrap;
                    }
                    .bullet-list {
                        margin-top: 10px;
                        padding-left: 20px;
                    }
                    .bullet-item {
                        margin-bottom: 8px;
                    }
                    .verdict-box {
                        background: #f8f9fa;
                        border: 1px solid #dee2e6;
                        padding: 15px;
                        border-radius: 5px;
                        margin-top: 10px;
                    }
                    .footer {
                        position: fixed;
                        bottom: 30px;
                        left: 40px;
                        right: 40px;
                        text-align: center;
                        font-size: 9pt;
                        color: #999;
                        border-top: 1px solid #eee;
                        padding-top: 10px;
                    }
                    .timestamp {
                        float: right;
                    }
                    @page {
                        margin: 1cm;
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="case-title">${caseTitle}</div>
                    <div class="court-name">${courtName}</div>
                    ${location ? `<div class="location-info">${location}</div>` : ''}
                    <div class="citation">${citation} (${date})</div>
                </div>

                ${(case_context.facts || precedentData.facts) ? `
                <div class="section">
                    <div class="section-title">SECTION 1: Case Facts</div>
                    <div class="content">${case_context.facts || precedentData.facts}</div>
                </div>
                ` : ''}

                ${(case_context.legal_issue || precedentData.issue) ? `
                <div class="section">
                    <div class="section-title">SECTION 2: Core Legal Issue</div>
                    <div class="content" style="font-weight: bold;">"${case_context.legal_issue || precedentData.issue}${!(case_context.legal_issue || precedentData.issue).includes('?') ? '?' : ''}"</div>
                </div>
                ` : ''}

                ${(judgment_basis.legal_reasoning || precedentData.reasoning || precedentData.ratio_decidendi) ? `
                <div class="section">
                    <div class="section-title">SECTION 3: Judgment Reasoning & Ratio Decidendi</div>
                    <div class="content">
                        ${formatContent(judgment_basis.legal_reasoning || precedentData.reasoning || precedentData.ratio_decidendi)}
                    </div>
                </div>
                ` : ''}

                ${(judgment_basis.principles_applied?.length > 0 || precedentData.laws) ? `
                <div class="section">
                    <div class="section-title">SECTION 4: Legal Basis (Acts / Sections Applied)</div>
                    <div class="content">
                        <ul class="bullet-list">
                            ${(judgment_basis.principles_applied || []).map(p => `<li class="bullet-item">${p}</li>`).join('')}
                            ${precedentData.laws ? `<li class="bullet-item">${precedentData.laws}</li>` : ''}
                            ${precedentData.sections ? `<li class="bullet-item">${precedentData.sections}</li>` : ''}
                        </ul>
                    </div>
                </div>
                ` : ''}

                ${(judgment_outcome.final_decision || precedentData.decision || precedentData.verdict) ? `
                <div class="section">
                    <div class="section-title">SECTION 5: Final Verdict</div>
                    <div class="verdict-box">
                        <div class="content" style="font-style: italic; font-weight: bold;">
                            "${judgment_outcome.final_decision || precedentData.decision || precedentData.verdict}"
                        </div>
                    </div>
                </div>
                ` : ''}

                ${(key_takeaways.length > 0 || precedentData.takeaways?.length > 0) ? `
                <div class="section">
                    <div class="section-title">SECTION 6: Key Takeaways</div>
                    <div class="content">
                        <ul class="bullet-list">
                            ${(key_takeaways || precedentData.takeaways || []).map(t => `<li class="bullet-item">${t}</li>`).join('')}
                        </ul>
                    </div>
                </div>
                ` : ''}

                <div class="footer">
                    <span>Generated by AISA AI Legal Toolkit</span>
                    <span class="timestamp">${new Date().toLocaleString()}</span>
                </div>
            </body>
            </html>
        `;

        const isLinux = process.platform === 'linux';
        const memUsage = process.memoryUsage();
        logger.info(`[PDFService] Memory Usage: RSS=${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap=${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
        logger.info(`[PDFService] Launching browser (Platform: ${process.platform}) for case: ${caseTitle}`);
        
        // Robust executable path selection
        let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        
        // If path is provided but doesn't exist, try to find it
        if (executablePath && isLinux && !fs.existsSync(executablePath)) {
            logger.warn(`[PDFService] Executable not found at ${executablePath}. Searching alternatives...`);
            executablePath = null;
        }

        if (!executablePath && isLinux) {
            // Check common locations
            const paths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
            for (const p of paths) {
                if (fs.existsSync(p)) {
                    executablePath = p;
                    break;
                }
            }
        }

        logger.info(`[PDFService] Final executable path: ${executablePath || 'bundled'}`);

        const launchOptions = {
            headless: true, // Use standard headless for better compatibility in Cloud Run
            executablePath: executablePath,
            protocolTimeout: 120000, // Increase timeout
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process', // Can help in low-resource environments
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--font-render-hinting=none',
                '--hide-scrollbars',
                '--mute-audio',
            ]
        };

        // Retry logic for browser launch
        let launchError;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                logger.info(`[PDFService] Launch attempt ${attempt}/2...`);
                browser = await puppeteer.launch(launchOptions);
                break; 
            } catch (err) {
                launchError = err;
                logger.warn(`[PDFService] Launch attempt ${attempt} failed: ${err.message}`);
                if (attempt === 1) await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!browser) {
            throw new Error(`Failed to launch browser after 2 attempts: ${launchError?.message}`);
        }

        logger.info(`[PDFService] Browser launched successfully (PID: ${browser.process()?.pid}). Opening page...`);
        const page = await browser.newPage();
        
        // Set viewport for consistent rendering
        await page.setViewport({ width: 794, height: 1122 }); // A4 at 96 DPI
        
        // Use 'load' instead of 'networkidle0' for better reliability in constrained environments
        logger.info(`[PDFService] Setting HTML content...`);
        await page.setContent(htmlContent, { waitUntil: 'load', timeout: 30000 });
        
        logger.info(`[PDFService] Generating PDF buffer...`);
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: false,
            margin: {
                top: '20px',
                right: '20px',
                bottom: '40px',
                left: '20px'
            }
        });

        await browser.close();
        logger.info(`[PDFService] PDF generated successfully (${pdfBuffer.length} bytes)`);
        return pdfBuffer;

    } catch (error) {
        if (browser) {
            try { 
                logger.warn(`[PDFService] Error detected, attempting to close browser...`);
                await browser.close(); 
            } catch (e) {
                logger.error(`[PDFService] Failed to close browser: ${e.message}`);
            }
        }
        console.error("[PDF_SERVICE_ERROR]", error);
        logger.error(`[PDFService] Generation failed: ${error.name} - ${error.message}`);
        logger.error(`[PDFService] Stack Trace: ${error.stack}`);
        throw new Error(`PDF Generation Error: ${error.message}`);
    }
};

function formatContent(text) {
    if (!text) return '';
    if (Array.isArray(text)) {
        return `<ul class="bullet-list">${text.map(t => `<li class="bullet-item">${t}</li>`).join('')}</ul>`;
    }
    // If it's a long string, try to split into paragraphs or bullets
    const lines = text.split(/\n|•/).filter(l => l.trim().length > 5);
    if (lines.length > 1) {
        return `<ul class="bullet-list">${lines.map(l => `<li class="bullet-item">${l.trim()}</li>`).join('')}</ul>`;
    }
    return text;
}
