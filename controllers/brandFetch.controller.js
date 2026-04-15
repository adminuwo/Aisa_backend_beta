import * as brandProcessor from '../services/brandProcessor.service.js';
import logger from '../utils/logger.js';
import { uploadToGCS } from '../services/socialAgent.service.js';
import UploadAsset from '../models/UploadAsset.js';
import BrandProfile from '../models/BrandProfile.js';

/**
 * Stage 4: THE REAL MAGIC — Website-to-DNA Synthesis
 * Returns an auto-fill preview WITHOUT saving to DB.
 */
/**
 * Stage 4: THE REAL MAGIC — Website-to-DNA Synthesis
 * Returns an auto-fill preview WITHOUT saving to DB.
 */
export const fetchBrandAssets = async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "Website URL is required." });
    }

    console.log(`[Real Magic] Synthesizing DNA for: ${url}`);

    // Process Identity (Stage 1 logic but as a read-only fetch)
    const result = await brandProcessor.processBrandIdentity({
      websiteUrl: url,
      manualDescription: "" // Empty for pure fetch
    });

    const dna = result.structuredIdentity;
    console.log(`[Real Magic] Synthesis Complete for: ${dna.brand_name}`);
    console.log(`[Real Magic] Logo Extracted: ${dna.logo_url || 'None'}`);
    console.log(`[Real Magic] Colors Found: ${dna.color_palette?.length || 0}`);

    // Map back to frontend expected keys
    res.status(200).json({
      brandName: dna.brand_name,
      description: result.rawKnowledgeBase.substring(0, 1000), // More descriptive
      brandColors: dna.color_palette,
      toneOfVoice: dna.tone,
      targetRegion: dna.target_audience,
      industry: dna.industry,
      products_services: dna.products_services,
      brand_values: dna.brand_values,
      logoUrl: dna.logo_url || null,
      faviconUrl: result.webData?.faviconUrl || result.webData?.favicon || null,
      domain: url.replace(/^https?:\/\//, '').split('/')[0],
      success: true
    });

  } catch (error) {
    logger.error(`[Real Magic] Synthesis failed: ${error.message}`);
    res.status(500).json({
      error: "AI Synthesis failed. Please manually enter brand details.",
      details: error.message
    });
  }
};

/**
 * Stage 4: THE REAL MAGIC — Asset-to-DNA Synthesis
 * Analyze a single file (Logo or PDF) and return data for Auto-Fill.
 * PLUS: Save to GCS in dedicated folder.
 */
export const quickAnalysis = async (req, res) => {
  try {
    const files = req.files || [];
    const { workspaceId } = req.body;

    if (files.length === 0) {
      console.warn(`[Real Magic] QuickAnalysis called without files.`);
      return res.status(400).json({ success: false, error: "No files uploaded" });
    }

    console.log(`[Real Magic] Analyzing DNA for ${files.length} files. Workspace: ${workspaceId || 'None'}`);

    const { extractColorsFromLogo, parseBrandDocument } = await import('../services/brandProcessor.service.js');
    const { AskVertexRaw } = await import('../services/vertex.service.js');

    let allParsedText = "";
    let allColors = [];
    let gcsUrls = [];

    // Process all files in parallel
    await Promise.all(files.map(async (file) => {
      let gcsUrl = null;

      console.log(`[Quick Analysis] Processing file: ${file.originalname} (${file.mimetype})`);

      // 1. PERSISTENT STORAGE
      if (workspaceId && workspaceId !== 'undefined' && workspaceId !== 'null') {
        try {
          const folder = file.mimetype.startsWith('image/')
            ? `brands/${workspaceId}/logo`
            : `brands/${workspaceId}/guidelines`;

          const uploadRes = await uploadToGCS(file, folder);
          gcsUrl = uploadRes.url;
          gcsUrls.push(gcsUrl);

          console.log(`[Quick Analysis] Uploaded ${file.originalname} to GCS: ${gcsUrl}`);

          await new UploadAsset({
            workspaceId,
            assetType: file.mimetype.startsWith('image/') ? 'logo' : 'overview',
            gcsUrl,
            fileName: file.originalname,
            mimeType: file.mimetype
          }).save();

          const brand = await BrandProfile.findOne({ workspaceId });
          if (brand) {
            if (file.mimetype.startsWith('image/')) {
              brand.logoUrl = gcsUrl;
              console.log(`[Quick Analysis] Updated Brand logoUrl: ${gcsUrl}`);
            } else {
              brand.companyOverviewFileUrl = gcsUrl; // Legacy support
              if (!brand.companyOverviewFileUrls) brand.companyOverviewFileUrls = [];
              if (!brand.companyOverviewFileUrls.includes(gcsUrl)) {
                brand.companyOverviewFileUrls.push(gcsUrl);
              }
              console.log(`[Quick Analysis] Added to Brand companyOverviewFileUrls. Count: ${brand.companyOverviewFileUrls.length}`);
            }
            await brand.save();
          }
        } catch (uploadErr) {
          console.error(`[Quick Analysis] Upload/Persistence failed for ${file.originalname}: ${uploadErr.message}`);
        }
      }

      // 2. EXTRACTION
      if (file.mimetype.startsWith('image/')) {
        const colors = await extractColorsFromLogo(file.buffer);
        allColors = [...allColors, ...colors];
        console.log(`[Quick Analysis] Extracted ${colors.length} colors from logo: ${file.originalname}`);
      } else {
        const text = await parseBrandDocument(file.buffer, file.mimetype);
        if (text) {
           allParsedText += `\nFILE: ${file.originalname}\n${text}\n---\n`;
           console.log(`[Quick Analysis] Parsed ${text.length} chars from document: ${file.originalname}`);
        } else {
           console.warn(`[Quick Analysis] Parsing returned no text for document: ${file.originalname}`);
        }
      }
    }));

    // Deduplicate colors
    allColors = [...new Set(allColors)];

    // Summary of extracted data
    let responseData = { success: true, brandColors: allColors, gcsUrls };

    if (allParsedText.trim().length > 10) {
      console.log(`[Real Magic] Sending aggregated text to Vertex for DNA Synthesis...`);
      const aiPrompt = `Analyze these brand documents and extract a unified identity.
      Return strictly valid JSON format:
      {
        "brandName": "...",
        "summary": "Full mission/vision description combining all insights",
        "tone": "Bold / Professional / etc"
      }
      
      TEXT: ${allParsedText.substring(0, 7000)}`;

      try {
        const aiRes = await AskVertexRaw(aiPrompt);
        const dna = JSON.parse(aiRes.replace(/```json|```/g, ''));
        responseData = { 
          ...responseData,
          brandName: dna.brandName,
          extractedBrandSummary: dna.summary,
          toneOfVoice: dna.tone
        };
        console.log(`[Real Magic] DNA Synthesis complete for: ${dna.brandName}`);
      } catch (aiErr) {
        console.error(`[Real Magic] AI Synthesis specifically failed: ${aiErr.message}`);
      }
    }

    return res.json(responseData);
  } catch (error) {
    console.error(`[Real Magic] Fatal Analysis failed: ${error.message}`);
    res.status(500).json({ success: false, error: `DNA analysis failed: ${error.message}.` });
  }
};
