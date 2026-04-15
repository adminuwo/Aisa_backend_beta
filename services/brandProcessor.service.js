import axios from 'axios';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import * as cheerio from 'cheerio';
import Vibrant from 'node-vibrant';
import officeparser from 'officeparser';
import logger from '../utils/logger.js';
import * as vertexService from './vertex.service.js';
import { extractBrandMetadata } from '../utils/brandScraper.js';

/**
 * STAGE 1: Data Collection + Normalization
 * Standardizes all brand inputs (Web, PDF, Logo, Manual) into a single JSON profile.
 */

/**
 * 1. Website Scraper
 */
export const scrapeWebsite = async (url) => {
  try {
    if (!url) return null;
    const formattedUrl = url.startsWith('http') ? url : `https://${url}`;

    const { data: html } = await axios.get(formattedUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
    });

    const $ = cheerio.load(html);

    const findFavicon = () => {
      let icon = $('link[rel="icon"]').attr('href') || 
                 $('link[rel="shortcut icon"]').attr('href') || 
                 $('link[rel="apple-touch-icon"]').attr('href');
      if (!icon) icon = '/favicon.ico';
      return icon;
    };

    const metadata = {
      title: $('title').text() || $('meta[property="og:title"]').attr('content'),
      description: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'),
      logo: $('meta[property="og:image"]').attr('content') || $('link[rel="apple-touch-icon"]').attr('href'),
      favicon: findFavicon(),
      themeColor: $('meta[name="theme-color"]').attr('content') || $('meta[name="msapplication-TileColor"]').attr('content'),
      bodyText: $('p').text().substring(0, 3000), 
    };

    const baseUrl = new URL(formattedUrl);
    if (metadata.logo && !metadata.logo.startsWith('http')) {
      metadata.logo = new URL(metadata.logo, baseUrl.origin).href;
    }
    if (metadata.favicon && !metadata.favicon.startsWith('http')) {
      metadata.favicon = new URL(metadata.favicon, baseUrl.origin).href;
    }

    // Fallback: if no OG image, use favicon as logo placeholder
    if (!metadata.logo) metadata.logo = metadata.favicon;

    return metadata;
  } catch (error) {
    logger.warn(`[Scrape] Failed to scrape ${url}: ${error.message}`);
    return null;
  }
};

/**
 * 2. Logo Color Extraction
 */
export const extractColorsFromLogo = async (buffer) => {
  try {
    if (!buffer || buffer.length === 0) return [];
    
    const palette = await Vibrant.from(buffer).getPalette();
    const colors = [];

    const isValid = (hex) => {
      if (!hex) return false;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      // Skip extreme white/black background noise, but keep brand colors
      if (r > 252 && g > 252 && b > 252) return false;
      if (r < 8 && g < 8 && b < 8) return false;
      // Also skip gray-scale if possible (low saturation)
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 15) return false; 
      return true;
    };

    if (palette.Vibrant && isValid(palette.Vibrant.hex)) colors.push(palette.Vibrant.hex);
    if (palette.DarkVibrant && isValid(palette.DarkVibrant.hex)) colors.push(palette.DarkVibrant.hex);
    if (palette.Muted && isValid(palette.Muted.hex)) colors.push(palette.Muted.hex);
    if (palette.LightVibrant && isValid(palette.LightVibrant.hex)) colors.push(palette.LightVibrant.hex);

    return [...new Set(colors)]; 
  } catch (error) {
    logger.error(`[Vibrant] Color extraction failed: ${error.message}`);
    return [];
  }
};

/**
 * 3. PDF/DOCX Parsing
 */
export const parseBrandDocument = async (buffer, mimeType) => {
  try {
    if (!buffer) return '';

    // Specialized PDF handle
    if (mimeType.includes('pdf')) {
      const data = await pdfParse(buffer);
      return data.text || '';
    }

    // Others (Docx, etc)
    if (
      mimeType.includes('officedocument') ||
      mimeType.includes('word') ||
      mimeType.includes('text/plain') ||
      mimeType.includes('application/msword')
    ) {
      return await officeparser.parseOfficeAsync(buffer);
    }
    return '';
  } catch (error) {
    logger.error(`[Document Parser] Parsing failed for ${mimeType}: ${error.message}`);
    return '';
  }
};

/**
 * 4. Unified Processor (Normalization)
 */
export const processBrandIdentity = async ({
  brandName,
  websiteUrl,
  logoBuffer,
  pdfBuffer,
  pdfMimeType,
  manualDescription,
  tone,
  ctaStyle
}) => {
  try {
    console.log(`[Stage 1] Core Normalization Start for: ${brandName || 'Untitled'}`);

    // THE FINAL STRUCTURED OBJECT BASE
    let structuredIdentity = {
      brand_name: brandName || '',
      industry: '',
      target_audience: '',
      tone: '',
      products_services: [],
      brand_values: [],
      color_palette: [],
      platform_focus: ['instagram', 'linkedin', 'twitter'],
      content_goals: ['engagement', 'awareness', 'conversion']
    };

    let rawKnowledgeBase = '';

    // Parallel processing (Advanced Scraper handles all visual/textual discovery)
    console.log(`[Stage 1] Triggering parallel insights extraction...`);

    const pdfBuffers = Array.isArray(pdfBuffer) ? pdfBuffer : (pdfBuffer ? [pdfBuffer] : []);
    
    const [docTexts, advancedWebData] = await Promise.all([
      pdfBuffers.length > 0 
        ? Promise.all(pdfBuffers.map(buf => parseBrandDocument(buf, pdfMimeType || 'application/pdf')))
        : Promise.resolve([]),
      websiteUrl ? extractBrandMetadata(websiteUrl) : Promise.resolve(null)
    ]);

    // Handle Logo Color Extraction (Uploaded OR Discovered)
    let finalColors = [];
    if (logoBuffer) {
      console.log(`[Stage 1] Extracting colors from uploaded logo buffer...`);
      finalColors = await extractColorsFromLogo(logoBuffer);
    } else if (advancedWebData?.logoUrl || advancedWebData?.logo) {
      const targetLogo = advancedWebData.logoUrl || advancedWebData.logo;
      console.log(`[Stage 1] Attempting color extraction from discovered logo: ${targetLogo}`);
      try {
        const logoRes = await axios.get(targetLogo, { responseType: 'arraybuffer', timeout: 5000 });
        finalColors = await extractColorsFromLogo(Buffer.from(logoRes.data));
        console.log(`[Stage 1] Extracted ${finalColors.length} colors from discovered logo.`);
      } catch (err) {
        console.warn(`[Stage 1] Failed to fetch web logo for color extraction: ${err.message}`);
      }
    }
    
    const docText = docTexts.filter(Boolean).join('\n---\n');
    const logoColors = finalColors;
    console.log(`[Stage 1] Parallel insights extraction complete. Docs: ${docTexts.length} | Colors: ${logoColors.length}`);

    const webData = advancedWebData; // Unified source

    // 1. Merge Textual Knowledge (Using enriched data)
    rawKnowledgeBase = `
      SOURCE: MANUAL
      ${manualDescription || ''}
      
      SOURCE: WEBSITE (ENRICHED)
      TITLE: ${advancedWebData?.brandName || ''}
      DESC: ${advancedWebData?.description || ''}
      ANALYSIS: ${advancedWebData?.siteContext?.substring(0, 3000) || ''}
      
      SOURCE: DOCUMENT
      ${docText || ''}
    `.trim();

    // 2. Resolve Base Colors (Priority: Logo Extraction > Advanced Web Colors > Theme Color > AI Extraction)
    let baseColors = logoColors || [];
    
    // Use colors from advanced scraper if available
    if (baseColors.length === 0 && advancedWebData?.brandColors?.length > 0) {
      baseColors = advancedWebData.brandColors;
    }

    // If no manual logo buffer, but we found a logo URL on the site, try to extract colors from it
    if (baseColors.length === 0 && webData?.logo) {
      try {
        const logoRes = await axios.get(webData.logo, { responseType: 'arraybuffer', timeout: 5000 });
        const colors = await extractColorsFromLogo(Buffer.from(logoRes.data));
        if (colors.length > 0) baseColors = colors;
      } catch (e) {
        logger.warn(`[Stage 1] Failed to extract colors from scraped logo ${webData.logo}: ${e.message}`);
      }
    }

    // Still nothing? Use thermal color from meta if available
    if (baseColors.length === 0 && webData?.themeColor) {
      baseColors = [webData.themeColor];
    }

    structuredIdentity.color_palette = baseColors;

    // 3. Resolve Company Name (Priority: Manual > Advanced Scraper > Basic Title)
    if (!structuredIdentity.brand_name) {
      structuredIdentity.brand_name = advancedWebData?.brandName || webData?.title?.split(/\s*[\|–—\-]\s*/)[0]?.trim() || '';
    }

    // AI ENRICHMENT (Vertex AI) - STAGE 1 NORMALIZATION
    const enrichmentPrompt = `
      You are a World-Class Brand Data Structuring AI.
      Your task is to combine and clean all provided inputs into a single structured brand object.

      INPUT:
      - Brand Name: ${structuredIdentity.brand_name || 'TBD'}
      - Website Data: ${webData?.title || ''} ${webData?.description || ''} ${webData?.bodyText?.substring(0, 3000) || ''}
      - PDF Content: ${docText || ''}
      - User Description: ${manualDescription || 'N/A'}
      - Selected Tone: ${tone || 'Professional'}
      - CTA Style: ${ctaStyle || 'Strong'}
      - Extracted Colors: ${structuredIdentity.color_palette.join(', ')}

      OUTPUT (STRICT JSON ONLY):
      {
        "brand_name": "...",
        "industry": "...",
        "target_audience": "...",
        "tone": "...",
        "cta_style": "...",
        "products_services": [],
        "brand_values": [],
        "content_angles": [],
        "color_palette": [],
        "platform_focus": ["instagram", "linkedin", "twitter"],
        "posting_frequency": "daily",
        "goal": "engagement + awareness + conversion"
      }

      RULES:
      - Merge all inputs intelligently
      - Do not leave important fields empty
      - Keep it practical for content generation
      - No explanation or markdown
    `;

    try {
      const aiResult = await vertexService.AskVertexRaw(enrichmentPrompt);
      const cleanJson = aiResult.replace(/```json|```/g, '').trim();
      const enriched = JSON.parse(cleanJson);

      // Update with AI results
      structuredIdentity.brand_name = enriched.brand_name || structuredIdentity.brand_name;
      structuredIdentity.industry = enriched.industry;
      structuredIdentity.target_audience = enriched.target_audience;
      structuredIdentity.tone = enriched.tone;
      structuredIdentity.cta_style = enriched.cta_style;
      structuredIdentity.products_services = enriched.products_services || [];
      structuredIdentity.brand_values = enriched.brand_values || [];
      structuredIdentity.content_angles = enriched.content_angles || [];
      structuredIdentity.platform_focus = enriched.platform_focus || structuredIdentity.platform_focus;
      structuredIdentity.posting_frequency = enriched.posting_frequency || structuredIdentity.posting_frequency;
      structuredIdentity.goal = enriched.goal || structuredIdentity.goal;

      // Merge colors (Priority: AI Suggestion -> Extraction)
      if (enriched.color_palette && enriched.color_palette.length > 0) {
        structuredIdentity.color_palette = enriched.color_palette;
      }
    } catch (aiErr) {
      logger.warn(`[Stage 1] AI Enrichment failed: ${aiErr.message}`);
    }

    return {
      structuredIdentity: {
        ...structuredIdentity,
        logo_url: advancedWebData?.logoUrl || advancedWebData?.logo || advancedWebData?.faviconUrl || ''
      },
      rawKnowledgeBase,
      webData: advancedWebData,
      advancedMetadata: advancedWebData
    };
  } catch (error) {
    logger.error(`[Stage 1] Fatal normalization error: ${error.message}`);
    throw error;
  }
};
