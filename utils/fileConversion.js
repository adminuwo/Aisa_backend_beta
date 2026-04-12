import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import mammoth from 'mammoth';
import officeParser from 'officeparser';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import htmlToDocx from 'html-to-docx';
import { genAIInstance, modelName as primaryModelName } from '../config/vertex.js';

/**
 * File Conversion Service for AISA™
 * Handles PDF ↔ DOCX conversions
 */

/**
 * Detect file type from buffer
 * @param {Buffer} buffer - File buffer
 * @returns {string} - File type: 'pdf', 'docx', or 'unknown'
 */
function detectFileType(buffer) {
    // PDF files start with %PDF
    if (buffer.toString('utf8', 0, 4) === '%PDF') {
        return 'pdf';
    }

    // DOCX files are ZIP archives with specific structure
    // Check for PK (ZIP signature) at start
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
        return 'docx';
    }

    return 'unknown';
}

/**
 * Validate if conversion is supported
 * @param {string} sourceType - Source file type
 * @param {string} targetType - Target file type
 * @returns {boolean} - True if conversion is supported
 */
function validateConversionRequest(sourceType, targetType) {
    const validConversions = [
        { from: 'pdf', to: 'docx' },
        { from: 'docx', to: 'pdf' },
        { from: 'doc', to: 'pdf' }
    ];

    return validConversions.some(
        conv => conv.from === sourceType.toLowerCase() && conv.to === targetType.toLowerCase()
    );
}

/**
 * Convert PDF to DOCX
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @returns {Promise<Buffer>} - DOCX file buffer
 */
async function convertPdfToDocx(pdfBuffer) {
    try {
        // Parse PDF to extract text
        const pdfData = await pdfParse(pdfBuffer);
        const text = pdfData.text;

        try {
            console.log('[FILE CONVERSION] Attempting AI-powered semantic formatting...');
            // Need to wrap inside generativeModel handling correctly
            const model = genAIInstance.getGenerativeModel({ model: primaryModelName });
            
            const prompt = `Convert the following extracted PDF text into clean, professional, and well-structured semantic HTML.
Requirements:
- Identify headings and apply proper hierarchy (<h1>, <h2>, <h3>)
- Merge broken lines into proper paragraphs (<p>)
- Maintain original meaning without skipping any content
- Format tables accurately with rows and columns (<table>, <tr>, <td>, <th>)
- Preserve bullet points and numbered lists (<ul>, <ol>, <li>)
- Fix spacing, alignment, and indentation
- Remove OCR errors if present
- Ensure the output looks like a professionally created document

OUTPUT ONLY THE RAW HTML STRING. DO NOT include markdown code blocks like \`\`\`html or any explanations.

PDF Text:
${text}
`;
            
            const result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 8192 }
            });
            
            const response = await result.response;
            let aiHtml = '';
            if (typeof response.text === 'function') {
                aiHtml = response.text();
            } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
                aiHtml = response.candidates[0].content.parts[0].text;
            }

            if (aiHtml) {
                // Clean up any markdown code blocks just in case
                aiHtml = aiHtml.replace(/```html|```/gi, '').trim();
                
                // Convert HTML to DOCX using html-to-docx
                console.log('[FILE CONVERSION] Generating DOCX from AI HTML...');
                const docxBuffer = await htmlToDocx(aiHtml, null, {
                    table: { row: { cantSplit: true } },
                    footer: true,
                    pageNumber: true,
                });
                
                if (docxBuffer) {
                    return docxBuffer;
                }
            }
        } catch (aiError) {
            console.warn('[FILE CONVERSION] AI semantic formatting failed, falling back to basic:', aiError.message);
        }

        // Split text into paragraphs
        console.log('[FILE CONVERSION] Using basic paragraph split fallback.');
        const paragraphs = text.split('\n').filter(line => line.trim().length > 0);

        // Create DOCX document
        const doc = new Document({
            sections: [{
                properties: {},
                children: paragraphs.map(para =>
                    new Paragraph({
                        children: [new TextRun(para)]
                    })
                )
            }]
        });

        // Generate buffer
        const buffer = await Packer.toBuffer(doc);
        return buffer;

    } catch (error) {
        console.error('PDF to DOCX conversion error:', error);
        throw new Error('Failed to convert PDF to DOCX: ' + error.message);
    }
}

/**
 * Helper to wrap text based on width
 */
function wrapText(text, width, font, fontSize) {
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testWidth = font.widthOfTextAtSize(testLine, fontSize);
        if (testWidth > width && currentLine) {
            lines.push(currentLine);
            currentLine = word;
        } else {
            currentLine = testLine;
        }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
}

/**
 * Convert DOCX to PDF
 * @param {Buffer} docxBuffer - DOCX file buffer
 * @returns {Promise<Buffer>} - PDF file buffer
 */
async function convertDocxToPdf(docxBuffer) {
    try {
        if (!docxBuffer || docxBuffer.length === 0) {
            throw new Error("Empty document buffer received.");
        }

        // Diagnostic: Check for PK zip header (DOCX is a zip)
        if (docxBuffer[0] !== 0x50 || docxBuffer[1] !== 0x4B) {
             const header = docxBuffer.slice(0, 8).toString('hex');
             console.error(`[DOCX-TO-PDF] Invalid Magic Bytes: ${header}`);
             throw new Error("The file is not a valid Word document (Invalid ZIP header).");
        }

        // Extract text from DOCX - Use officeParser for better compatibility
        let text = "";
        
        try {
            // Attempt 1: officeparser
            const parser = (officeParser && officeParser.parsePromise) ? officeParser : (officeParser?.default || officeParser);
            if (parser && typeof parser.parsePromise === 'function') {
                text = await parser.parsePromise(docxBuffer);
            }
        } catch (parserErr) {
            console.warn('[DOCX-TO-PDF] officeParser failed, trying mammoth...');
        }

        if (!text || text.trim().length === 0) {
            // Attempt 2: mammoth
            try {
                const result = await mammoth.extractRawText({ buffer: docxBuffer });
                text = result.value;
            } catch (mErr) {
                console.warn('[DOCX-TO-PDF] mammoth failed as well.');
            }
        }

        if (!text || text.trim().length === 0) {
             // Attempt 3: If still no text, the file might be an image-only DOCX.
             // But for now, we'll try to report a more accurate error.
             throw new Error("No text content could be extracted from the document. This usually happens if the file contains only images or was created in a non-standard way.");
        }

        // Clean text: remove or replace problematic Unicode characters
        // Keep only ASCII-safe characters and common Unicode ranges
        text = text.replace(/[^\x00-\x7F\u0080-\u00FF\u0100-\u017F\u0180-\u024F]/g, '?');

        // Create PDF document
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        const pageWidth = 595.28; // A4 width in points
        const pageHeight = 841.89; // A4 height in points
        const margin = 50;
        const fontSize = 11;
        const lineHeight = fontSize * 1.4;
        const maxWidth = pageWidth - (margin * 2);

        // Split text into paragraphs
        const paragraphs = text.split('\n');

        let page = pdfDoc.addPage([pageWidth, pageHeight]);
        let yPosition = pageHeight - margin;

        for (const para of paragraphs) {
            const cleanPara = para.trim();

            // Handle empty paragraphs as small gaps
            if (cleanPara.length === 0) {
                yPosition -= lineHeight * 0.5;
                if (yPosition < margin) {
                    page = pdfDoc.addPage([pageWidth, pageHeight]);
                    yPosition = pageHeight - margin;
                }
                continue;
            }

            // Wrap text for this paragraph
            const wrappedLines = wrapText(cleanPara, maxWidth, font, fontSize);

            for (const line of wrappedLines) {
                if (yPosition < margin) {
                    page = pdfDoc.addPage([pageWidth, pageHeight]);
                    yPosition = pageHeight - margin;
                }

                try {
                    page.drawText(line, {
                        x: margin,
                        y: yPosition,
                        size: fontSize,
                        font: font,
                        color: rgb(0, 0, 0),
                    });
                } catch (drawError) {
                    // If drawing fails, try with sanitized text
                    const sanitized = line.replace(/[^\x00-\x7F]/g, '?');
                    page.drawText(sanitized, {
                        x: margin,
                        y: yPosition,
                        size: fontSize,
                        font: font,
                        color: rgb(0, 0, 0),
                    });
                }

                yPosition -= lineHeight;
            }
            // Extra gap between paragraphs
            yPosition -= lineHeight * 0.3;
        }

        // Save PDF
        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);

    } catch (error) {
        console.error('DOCX to PDF conversion error:', error);
        throw new Error('Failed to convert DOCX to PDF: ' + error.message);
    }
}

/**
 * Main conversion function
 * @param {Buffer} fileBuffer - Source file buffer
 * @param {string} sourceFormat - Source format (pdf/docx)
 * @param {string} targetFormat - Target format (pdf/docx)
 * @returns {Promise<Buffer>} - Converted file buffer
 */
export async function convertFile(fileBuffer, sourceFormat, targetFormat) {
    // Validate conversion
    if (!validateConversionRequest(sourceFormat, targetFormat)) {
        throw new Error(`Conversion from ${sourceFormat} to ${targetFormat} is not supported`);
    }

    // Detect actual file type
    const detectedType = detectFileType(fileBuffer);
    if (detectedType === 'unknown') {
        throw new Error('Unable to detect file type. Please ensure the file is a valid PDF or DOCX');
    }

    // Perform conversion
    if (sourceFormat.toLowerCase() === 'pdf' && (targetFormat.toLowerCase() === 'docx' || targetFormat.toLowerCase() === 'doc')) {
        return await convertPdfToDocx(fileBuffer);
    } else if ((sourceFormat.toLowerCase() === 'docx' || sourceFormat.toLowerCase() === 'doc') && targetFormat.toLowerCase() === 'pdf') {
        return await convertDocxToPdf(fileBuffer);
    } else if (sourceFormat.toLowerCase() === 'rtf' && targetFormat.toLowerCase() === 'pdf') {
        return await convertRtfToPdf(fileBuffer);
    } else {
        throw new Error(`Unsupported conversion: ${sourceFormat} to ${targetFormat}`);
    }
}

/**
 * Convert RTF to PDF
 */
async function convertRtfToPdf(rtfBuffer) {
    try {
        const rtfContent = rtfBuffer.toString('utf-8');
        const text = rtfContent
            .replace(/\\([a-z]{1,32})(-?\d+)? ?/g, '')
            .replace(/\{[^}]+\}/g, '')
            .replace(/\r?\n/g, ' ')
            .trim();

        if (!text) {
            throw new Error("No text content could be extracted from the RTF document.");
        }

        // Reuse PDF generation logic (we should really refactor this into a generatePdfFromText helper)
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        let page = pdfDoc.addPage([595.276, 841.89]); // A4
        const { width, height } = page.getSize();
        
        const fontSize = 11;
        const margin = 50;
        let y = height - margin;

        const words = text.split(/\s+/);
        let currentLine = "";

        for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const testWidth = font.widthOfTextAtSize(testLine, fontSize);

            if (testWidth > width - 2 * margin) {
                page.drawText(currentLine, { x: margin, y: y, size: fontSize, font: font });
                y -= fontSize * 1.2;
                currentLine = word;

                if (y < margin) {
                    page = pdfDoc.addPage([595.276, 841.89]);
                    y = height - margin;
                }
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) {
            page.drawText(currentLine, { x: margin, y: y, size: fontSize, font: font });
        }

        return Buffer.from(await pdfDoc.save());
    } catch (error) {
        console.error("[RTF-TO-PDF] Error:", error);
        throw new Error(`Failed to convert RTF to PDF: ${error.message}`);
    }
}
export { convertPdfToDocx, convertDocxToPdf, detectFileType, validateConversionRequest };
