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
 */
function detectFileType(buffer) {
    if (buffer.toString('utf8', 0, 4) === '%PDF') return 'pdf';
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'docx';
    return 'unknown';
}

/**
 * Validate if conversion is supported
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
 */
async function convertPdfToDocx(pdfBuffer) {
    try {
        const pdfData = await pdfParse(pdfBuffer);
        const text = pdfData.text;

        try {
            console.log('[FILE CONVERSION] Attempting AI-powered semantic formatting...');
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
                aiHtml = aiHtml.replace(/```html|```/gi, '').trim();
                const docxBuffer = await htmlToDocx(aiHtml, null, {
                    table: { row: { cantSplit: true } },
                    footer: true,
                    pageNumber: true,
                });
                if (docxBuffer) return docxBuffer;
            }
        } catch (aiError) {
            console.warn('[FILE CONVERSION] AI semantic formatting failed, falling back to basic:', aiError.message);
        }

        const paragraphs = text.split('\n').filter(line => line.trim().length > 0);
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

        return await Packer.toBuffer(doc);
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
 */
export async function convertDocxToPdf(docxBuffer) {
    try {
        if (!docxBuffer || docxBuffer.length === 0) {
            throw new Error("Empty document buffer received.");
        }

        if (docxBuffer[0] !== 0x50 || docxBuffer[1] !== 0x4B) {
             throw new Error("The file is not a valid Word document.");
        }

        let text = "";
        try {
            const parser = (officeParser && officeParser.parsePromise) ? officeParser : (officeParser?.default || officeParser);
            if (parser && typeof parser.parsePromise === 'function') {
                text = await parser.parsePromise(docxBuffer);
            }
        } catch (parserErr) {}

        if (!text || text.trim().length === 0) {
            try {
                const result = await mammoth.extractRawText({ buffer: docxBuffer });
                text = result.value;
            } catch (mErr) {}
        }

        if (!text || text.trim().length === 0) {
             throw new Error("No text content could be extracted from the document.");
        }

        // --- NEW: SMART PUNCTUATION NORMALIZATION ---
        // This solves the '?' issue for English text with smart quotes/dashes
        text = text
            .replace(/[\u2018\u2019]/g, "'") // Smart single quotes
            .replace(/[\u201C\u201D]/g, '"') // Smart double quotes
            .replace(/[\u2014\u2015]/g, '--') // Em dashes
            .replace(/\u2013/g, '-') // En dash
            .replace(/\u2026/g, '...') // Ellipsis
            .replace(/\u00A0/g, ' '); // Non-breaking space

        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        const pageWidth = 595.28; 
        const pageHeight = 841.89; 
        const margin = 50;
        const fontSize = 11;
        const lineHeight = fontSize * 1.4;
        const maxWidth = pageWidth - (margin * 2);

        const paragraphs = text.split('\n');
        let page = pdfDoc.addPage([pageWidth, pageHeight]);
        let yPosition = pageHeight - margin;

        for (const para of paragraphs) {
            const cleanPara = para.trim();
            if (cleanPara.length === 0) {
                yPosition -= lineHeight * 0.5;
                if (yPosition < margin) {
                    page = pdfDoc.addPage([pageWidth, pageHeight]);
                    yPosition = pageHeight - margin;
                }
                continue;
            }

            const wrappedLines = wrapText(cleanPara, maxWidth, font, fontSize);

            for (const line of wrappedLines) {
                if (yPosition < margin) {
                    page = pdfDoc.addPage([pageWidth, pageHeight]);
                    yPosition = pageHeight - margin;
                }

                try {
                    // Filter out unrenderable characters just before drawing
                    // Helvetica only supports WinAnsi. Hindi will still show as '?'
                    // but at least English punctuation will be correct.
                    const pdsafeLine = line.replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '?');
                    page.drawText(pdsafeLine, {
                        x: margin,
                        y: yPosition,
                        size: fontSize,
                        font: font,
                        color: rgb(0, 0, 0),
                    });
                } catch (drawError) {
                    const fallbackLine = line.replace(/[^\x00-\x7F]/g, '?');
                    page.drawText(fallbackLine, { x: margin, y: yPosition, size: fontSize, font: font });
                }
                yPosition -= lineHeight;
            }
            yPosition -= lineHeight * 0.3;
        }

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    } catch (error) {
        console.error('DOCX to PDF conversion error:', error);
        throw new Error('Failed to convert DOCX to PDF: ' + error.message);
    }
}

/**
 * Main conversion function
 */
export async function convertFile(fileBuffer, sourceFormat, targetFormat) {
    if (!validateConversionRequest(sourceFormat, targetFormat)) {
        throw new Error(`Conversion from ${sourceFormat} to ${targetFormat} is not supported`);
    }

    const detectedType = detectFileType(fileBuffer);
    if (detectedType === 'unknown') {
        throw new Error('Unable to detect file type.');
    }

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
        const text = rtfBuffer.toString('utf-8')
            .replace(/\\([a-z]{1,32})(-?\d+)? ?/g, '')
            .replace(/\{[^}]+\}/g, '')
            .replace(/\r?\n/g, ' ')
            .trim();

        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        let page = pdfDoc.addPage([595.276, 841.89]);
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
        if (currentLine) page.drawText(currentLine, { x: margin, y: y, size: fontSize, font: font });
        return Buffer.from(await pdfDoc.save());
    } catch (error) {
        throw new Error(`Failed to convert RTF to PDF: ${error.message}`);
    }
}

export { convertPdfToDocx, detectFileType, validateConversionRequest };
