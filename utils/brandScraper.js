import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import { AskVertexRaw } from '../services/vertex.service.js';
import Vibrant from 'node-vibrant';

/** Browser-like headers to avoid bot blocking */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xhtml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

/** Normalize URL to include protocol */
export const normalizeUrl = (url) => {
  if (!url) return '';
  let target = url.trim();
  if (!target.startsWith('http')) target = 'https://' + target;
  return target;
};

/** Resolve a relative path to an absolute URL */
export const resolveToAbsolute = (path, baseUrl) => {
  if (!path || !baseUrl) return null;
  try { return new URL(path, baseUrl).href; } catch { return path; }
};

/**
 * Clean a raw page title into a proper brand name.
 * Removes common suffixes like "| Home", "- Official Website", etc.
 */
const cleanBrandName = (raw, domain = '') => {
  if (!raw) return '';
  // Strip common title suffixes
  let name = raw
    .split(/\s*[\|–—\-:]\s*/)[0]  // Take part before first separator
    .replace(/\s*(official|home|welcome|site|web|online|™|®|inc|ltd|pvt)\s*/gi, '')
    .trim();

  // If the result is just a generic term or too long, fallback to domain-based cleaning
  if (name.length > 60 || /^(home|welcome|index)$/i.test(name)) {
    if (domain) name = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
  }
  return name;
};

/**
 * Convert an rgb/rgba string to a hex color.
 */
const rgbToHex = (rgb) => {
  try {
    const matches = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!matches) return null;
    const r = parseInt(matches[1]);
    const g = parseInt(matches[2]);
    const b = parseInt(matches[3]);
    // Skip near-white and near-black
    if (r > 240 && g > 240 && b > 240) return null;
    if (r < 15 && g < 15 && b < 15) return null;
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
};

/**
 * Extract prominent brand colors from a page's actual CSS styling.
 * Scans <style> tags and inline style attributes for hex/rgb colors.
 * CSS variable names like --primary, --brand, --accent are weighted 3x.
 */
const extractColorsFromCSS = ($) => {
  const colorMap = new Map();
  const hexRegex = /#([0-9a-fA-F]{3,6})\b/g;
  const rgbRegex = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\)/g;

  const addColor = (hex, weight = 1) => {
    if (!hex) return;
    let h = hex.toLowerCase();
    // Normalize 3-digit to 6-digit
    if (/^#[0-9a-f]{3}$/.test(h)) {
      h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    }
    if (h.length !== 7) return;
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    if (r > 235 && g > 235 && b > 235) return; // skip near-white
    if (r < 20 && g < 20 && b < 20) return;    // skip near-black
    colorMap.set(h, (colorMap.get(h) || 0) + weight);
  };

  // 1. Scan <style> tags — give extra weight to CSS variable names that look like brand colors
  $('style').each((_, el) => {
    const css = $(el).text() || '';
    // Prioritize CSS variables: --primary-color, --brand-color, --accent, etc.
    const varRegex = /--(?:primary|brand|accent|main|theme|highlight|color|base)[\w-]*\s*:\s*([#rR][^;}{\n]+)/gi;
    let varMatch;
    while ((varMatch = varRegex.exec(css)) !== null) {
      const val = varMatch[1].trim();
      const hexM = val.match(/^#[0-9a-fA-F]{3,6}/);
      if (hexM) addColor(hexM[0], 3);
      const rgbM = val.match(/^rgba?\([^)]+\)/);
      if (rgbM) { const h = rgbToHex(rgbM[0]); if (h) addColor(h, 3); }
    }
    // General hex colors
    let m;
    const hexR = new RegExp(hexRegex.source, 'g');
    while ((m = hexR.exec(css)) !== null) addColor('#' + m[1]);
    const rgbR = new RegExp(rgbRegex.source, 'g');
    while ((m = rgbR.exec(css)) !== null) { const h = rgbToHex(m[0]); if (h) addColor(h); }

    // Catch hex in gradients (Common in premium designs)
    const gradRegex = /linear-gradient\([^)]*(#[0-9a-fA-F]{3,6})[^)]*\)/gi;
    let gM;
    while ((gM = gradRegex.exec(css)) !== null) addColor(gM[1], 2);
  });

  // 2. Scan inline style attributes (background-color, color, border-color on visible elements)
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const hexR = new RegExp(hexRegex.source, 'g');
    let m;
    while ((m = hexR.exec(style)) !== null) addColor('#' + m[1]);
    const rgbR = new RegExp(rgbRegex.source, 'g');
    while ((m = rgbR.exec(style)) !== null) { const h = rgbToHex(m[0]); if (h) addColor(h); }
  });

  // 3. Return top colors sorted by frequency
  return [...colorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex)
    .slice(0, 5);
};

/**
 * Extract the most prominent colors from an image URL using node-vibrant.
 */
const extractColorsFromLogo = async (logoUrl) => {
  if (!logoUrl) return [];
  try {
    if (logoUrl.toLowerCase().endsWith('.svg')) {
      console.log(`[Vibrant] Skipping color extraction for SVG logo: ${logoUrl}`);
      return [];
    }
    const palette = await Vibrant.from(logoUrl).getPalette();
    const colors = [];

    const isValid = (hex) => {
      if (!hex) return false;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);

      // Skip backgrounds and high-contrast text noise
      if (r > 240 && g > 240 && b > 240) return false; // Near white
      if (r < 40 && g < 40 && b < 40) return false;   // Near black (shadows/text)

      // Skip grayscale (low saturation)
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 25) return false;

      return true;
    };

    const isTooClose = (hex1, hex2) => {
      const r1 = parseInt(hex1.slice(1, 3), 16), g1 = parseInt(hex1.slice(3, 5), 16), b1 = parseInt(hex1.slice(5, 7), 16);
      const r2 = parseInt(hex2.slice(1, 3), 16), g2 = parseInt(hex2.slice(3, 5), 16), b2 = parseInt(hex2.slice(5, 7), 16);
      const dist = Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
      return dist < 35; // Too similar
    };

    const addUnique = (hex) => {
      if (isValid(hex) && !colors.some(c => isTooClose(c, hex))) {
        colors.push(hex);
      }
    };

    if (palette.Vibrant) addUnique(palette.Vibrant.hex);
    if (palette.DarkVibrant) addUnique(palette.DarkVibrant.hex);
    if (palette.Muted) addUnique(palette.Muted.hex);
    if (palette.LightVibrant) addUnique(palette.LightVibrant.hex);

    return colors.filter(Boolean);
  } catch (e) {
    console.warn('[Vibrant] color extraction failed:', e.message);
    return [];
  }
};

/**
 * Deep logo discovery from a Cheerio-loaded page.
 * Priority: og:logo > structured-data > apple-touch-icon > rel=icon SVG/PNG > img[logo] > favicon.ico
 */
const findBestLogoUrl = ($, baseUrl) => {
  // 1. Semantic & Standard Meta signal (High confidence)
  const metaSelectors = [
    'meta[property="og:logo"]',
    'meta[name="twitter:logo"]',
    'meta[property="og:image"]', // Use social image as logo fallback
    'meta[name="twitter:image"]'
  ];

  for (const s of metaSelectors) {
     const found = $(s).attr('content');
     if (found) return resolveToAbsolute(found, baseUrl);
  }

  // 2. Look for explicit "logo" images in common containers (Very high confidence)
  const logoSelectors = [
    'a[class*="logo"] img',
    'a[id*="logo"] img',
    '.nav-logo img',
    '#logo img',
    '.logo img',
    'header img[src*="logo" i]',
    'nav img[src*="logo" i]',
    'img[class*="logo" i]',
    'img[id*="logo" i]',
    'img[class*="brand" i]',
    'img[alt*="logo" i]'
  ];

  for (const s of logoSelectors) {
    const found = $(s).attr('src');
    if (found) return resolveToAbsolute(found, baseUrl);
  }

  // 3. Structural fallback: First image in header or nav (Medium confidence)
  const structuralLogo = 
    $('header img').first().attr('src') || 
    $('nav img').first().attr('src') ||
    $('a[href="/"] img').first().attr('src') ||
    $('a[href*="' + baseUrl + '"] img').first().attr('src');

  if (structuralLogo) return resolveToAbsolute(structuralLogo, baseUrl);

  // 4. JSON-LD structured data (Schema.org Organization)
  let jsonLdLogo = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdLogo) return;
    try {
      const data = JSON.parse($(el).html() || '{}');
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        const type = item?.['@type']?.toLowerCase?.() || '';
        if ((type.includes('organization') || type.includes('brand')) && item.logo) {
          jsonLdLogo = typeof item.logo === 'string' ? item.logo : item.logo?.url || item.logo?.contentUrl;
          if (jsonLdLogo) break;
        }
      }
    } catch { }
  });
  if (jsonLdLogo) return resolveToAbsolute(jsonLdLogo, baseUrl);

  // 6. Generic image search for "logo" or "brand" in filename (Last resort img tags)
  const allImgs = $('img').get();
  for (const img of allImgs) {
    const src = $(img).attr('src');
    const alt = $(img).attr('alt') || '';
    const cls = $(img).attr('class') || '';
    if (src && (src.toLowerCase().includes('logo') || alt.toLowerCase().includes('logo') || cls.toLowerCase().includes('logo'))) {
      return resolveToAbsolute(src, baseUrl);
    }
  }

  // 7. Favicons & Apple Touch Icons
  const lowPrioSelectors = [
    'link[rel="apple-touch-icon"]',
    'link[rel="icon"][sizes="192x192"]',
    'link[rel="icon"][sizes="144x144"]',
    'link[rel="icon"][type*="svg"]',
    'link[rel*="icon"]'
  ];

  for (const s of lowPrioSelectors) {
    const found = $(s).attr('href');
    if (found) return resolveToAbsolute(found, baseUrl);
  }

  console.warn(`[Scraper] No logo found for ${baseUrl}, falling back to favicon.ico`);
  return resolveToAbsolute('/favicon.ico', baseUrl);
};

/**
 * Fetch page HTML with a timeout and browser-like headers.
 */
const fetchHtml = async (url, timeout = 10000) => {
  const { data } = await axios.get(url, { headers: HEADERS, timeout });
  return data;
};

/**
 * Extract brand colors from external CSS stylesheets linked from a page.
 * Only fetches the first 1–2 CSS files to stay within time limits.
 */
const extractColorsFromExternalCSS = async ($, baseUrl) => {
  const colorMap = new Map();
  const hexRegex = /#([0-9a-fA-F]{3,6})\b/g;
  const rgbRegex = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\)/g;

  const addColor = (hex, weight = 1) => {
    if (!hex) return;
    let h = hex.toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(h)) {
      h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    }
    if (h.length !== 7) return;
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    if (r > 235 && g > 235 && b > 235) return;
    if (r < 20 && g < 20 && b < 20) return;
    colorMap.set(h, (colorMap.get(h) || 0) + weight);
  };

  // Get up to 2 stylesheet URLs from <link rel="stylesheet">
  const cssLinks = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && cssLinks.length < 2) {
      cssLinks.push(resolveToAbsolute(href, baseUrl));
    }
  });

  for (const cssUrl of cssLinks) {
    try {
      const { data: css } = await axios.get(cssUrl, { headers: HEADERS, timeout: 5000, responseType: 'text' });
      if (typeof css !== 'string') continue;

      // Prioritize CSS variables for brand-like names
      const varRegex = /--(?:primary|brand|accent|main|theme|highlight|color|base)[\w-]*\s*:\s*([#rR][^;}{n]+)/gi;
      let varMatch;
      while ((varMatch = varRegex.exec(css)) !== null) {
        const val = varMatch[1].trim();
        const hexM = val.match(/^#[0-9a-fA-F]{3,6}/);
        if (hexM) addColor(hexM[0], 3);
        const rgbM = val.match(/^rgba?\([^)]+\)/);
        if (rgbM) { const h = rgbToHex(rgbM[0]); if (h) addColor(h, 3); }
      }

      // General hex colors
      const hexR = new RegExp(hexRegex.source, 'g');
      let m;
      while ((m = hexR.exec(css)) !== null) addColor('#' + m[1]);
      const rgbR = new RegExp(rgbRegex.source, 'g');
      while ((m = rgbR.exec(css)) !== null) { const h = rgbToHex(m[0]); if (h) addColor(h); }
    } catch (e) {
      console.warn('[ExternalCSS] Could not fetch:', cssUrl, e.message);
    }
  }

  return [...colorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex)
    .slice(0, 5);
};

/**
 * Crawl up to 3 pages (home + about variants) for richer brand context text.
 */
const crawlBrandContext = async (baseUrl, initialHtml = null) => {
  const visited = new Set([baseUrl, baseUrl + '/']);
  const chunks = [];
  const MAX_PAGES = 8;

  try {
    const html = initialHtml || await fetchHtml(baseUrl, 5000);
    const $ = cheerio.load(html);

    // 1. Initial homepage crawl
    const extractText = (selector) => {
      const arr = [];
      selector.find('h1, h2, h3, p, li').each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 25) arr.push(t);
      });
      return arr.join(' ').replace(/\s+/g, ' ').trim();
    };

    const homeText = extractText($('body'));
    if (homeText) chunks.push(`[Page: Home]\n${homeText.substring(0, 3000)}`);

    // 2. Discover and Prioritize Links
    const internalLinks = new Set();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const absolute = resolveToAbsolute(href, baseUrl);
      if (absolute && absolute.startsWith(baseUrl) && !absolute.includes('#')) {
        internalLinks.add(absolute);
      }
    });

    const priorityKeywords = ['about', 'service', 'product', 'solution', 'company', 'who-we-are', 'what-we-do', 'our-work', 'portfolio', 'team'];
    const sortedLinks = Array.from(internalLinks)
      .filter(link => link !== baseUrl && link !== (baseUrl + '/'))
      .sort((a, b) => {
        const aScore = priorityKeywords.reduce((acc, k) => acc + (a.toLowerCase().includes(k) ? 1 : 0), 0);
        const bScore = priorityKeywords.reduce((acc, k) => acc + (b.toLowerCase().includes(k) ? 1 : 0), 0);
        return bScore - aScore;
      });

    // 3. Deep Crawl Top Pages
    for (const link of sortedLinks.slice(0, MAX_PAGES - 1)) {
      if (chunks.length >= MAX_PAGES) break;
      try {
        const pageHtml = await fetchHtml(link, 4000);
        const $page = cheerio.load(pageHtml);
        const pageTextArr = [];
        $page('h1, h2, h3, p, li').each((_, el) => {
          const t = $page(el).text().trim();
          if (t.length > 30) pageTextArr.push(t);
        });
        const pageText = pageTextArr.join(' ').replace(/\s+/g, ' ').trim();
        if (pageText.length > 100) {
          const pathName = new URL(link).pathname;
          chunks.push(`[Page: ${pathName}]\n${pageText.substring(0, 2500)}`);
        }
      } catch (e) {
        // Silently skip unreachable subpages
      }
    }
  } catch (e) {
    console.warn('[Crawler] Root crawl failed:', e.message);
  }

  return chunks.join('\n\n---\n\n');
};

/**
 * Main function: Scrape metadata from a URL.
 * Returns { brandName, logoUrl, faviconUrl, brandColors, description, domain, siteContext }
 */
export const extractBrandMetadata = async (targetUrl) => {
  const url = normalizeUrl(targetUrl);
  const parsed = new URL(url);
  const domain = parsed.hostname.replace('www.', '');

  // 1. Fetch the homepage HTML
  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    throw new Error(`Cannot reach ${url}: ${e.message}`);
  }

  const $ = cheerio.load(html);

  // 2. Extract brand name (multiple signal cascade)
  const rawTitle = $('title').text().trim();
  const ogSiteName = $('meta[property="og:site_name"]').attr('content')?.trim();
  const appTitle = $('meta[name="apple-mobile-web-app-title"]').attr('content')?.trim();
  const twitterSite = $('meta[name="twitter:site"]').attr('content')?.replace('@', '').trim();

  // JSON-LD org name
  let jsonLdName = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdName) return;
    try {
      const data = JSON.parse($(el).html() || '{}');
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (item?.name && item?.['@type']?.toLowerCase?.()?.match(/organization|corporation|brand|localbusiness|website/)) {
          jsonLdName = item.name;
          break;
        }
      }
    } catch { }
  });

  const brandName =
    ogSiteName ||
    jsonLdName ||
    appTitle ||
    (rawTitle ? cleanBrandName(rawTitle, domain) : null) ||
    (twitterSite ? twitterSite : null) ||
    domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);

  // 3. Logo discovery
  console.log(`[Scraper] Starting logo discovery for ${url}...`);
  const logoUrl = findBestLogoUrl($, url);
  if (logoUrl) console.log(`[Scraper] Found best logo candidate: ${logoUrl}`);
  else console.warn(`[Scraper] No logo candidate found for ${url}`);

  const faviconUrl = resolveToAbsolute(
    $('link[rel="icon"]').first().attr('href') ||
    $('link[rel="shortcut icon"]').attr('href') ||
    '/favicon.ico',
    url
  );

  // 4. Color extraction: CSS page colors (most reliable) + logo vibrant + meta theme-color
  // Step A: Extract from inline <style> tags on the page
  let cssColors = [];
  try { cssColors = extractColorsFromCSS($); } catch (e) { console.warn('[CSS Colors]', e.message); }

  // Step B: Extract from external CSS stylesheets (concurrent with logo fetch)
  let [externalCssColors, logoColors] = await Promise.allSettled([
    extractColorsFromExternalCSS($, url),
    logoUrl ? extractColorsFromLogo(logoUrl) : Promise.resolve([])
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));

  // Step C: Meta theme-color tags
  const themeColor = $('meta[name="theme-color"]').attr('content');
  const ogColor = $('meta[property="og:theme-color"]').attr('content');

  // Merge: theme-meta (best for primary) → external CSS → logo vibrant
  const allColors = [
    ...(themeColor ? [themeColor.toLowerCase()] : []),
    ...(ogColor ? [ogColor.toLowerCase()] : []),
    ...logoColors.map(c => c.toLowerCase()),
    ...externalCssColors,
    ...cssColors,
  ];

  // Deduplicate while preserving priority order
  const colorSeen = new Set();
  let brandColors = allColors.filter(c => {
    if (!c || colorSeen.has(c)) return false;
    colorSeen.add(c);
    return true;
  }).slice(0, 5);

  if (brandColors.length === 0) brandColors = ['#4f46e5', '#6366f1', '#0ea5e9'];

  // 5. Crawl site for richer text context
  const siteContext = await crawlBrandContext(url, html);

  // 6. Single AI call: extract description + brand intelligence
  let description = '';
  let toneOfVoice = 'Professional';
  let ctaStyle = 'Direct';
  let targetRegion = 'Global';
  let industry = '';

  try {
    const metaDesc =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      '';

    const aiPrompt = `You are a senior brand strategist. Analyze this website content for the company "${brandName}" and return a JSON object with EXACTLY these keys (no extra text, no markdown):

{
  "description": "2-sentence executive summary of what ${brandName} does and who they serve. Be punchy and professional.",
  "toneOfVoice": "One of exactly: Professional, Casual, Bold, Friendly",
  "ctaStyle": "One of exactly: Direct, Engagement, Storytelling",
  "targetRegion": "One of exactly: Global, Indian, American, British, Australian, Chinese, Japanese, Brazilian, French, German, Spanish, Nigerian, Pakistani, Egyptian, Mixed",
  "industry": "Short 2-4 word industry label like: Technology & SaaS, Health & Wellness, E-commerce & Retail, Food & Lifestyle, Finance & Banking, Education, Real Estate, Fashion & Apparel, Travel & Hospitality, Other"
}

IMPORTANT: If the provided content is sparse, use the brand name and meta description to infer the most likely business model. Never return empty description.

Website meta description: ${metaDesc}

Website content:
${siteContext.substring(0, 8000) || 'No main content found.'}`;

    const raw = (await AskVertexRaw(aiPrompt)).trim().replace(/```json\s*|\s*```/g, '');
    const parsed = JSON.parse(raw);
    description = parsed.description || metaDesc;
    toneOfVoice = ['Professional', 'Casual', 'Bold', 'Friendly'].includes(parsed.toneOfVoice) ? parsed.toneOfVoice : 'Professional';
    ctaStyle = ['Direct', 'Engagement', 'Storytelling'].includes(parsed.ctaStyle) ? parsed.ctaStyle : 'Direct';
    targetRegion = ['Global', 'Indian', 'American', 'British', 'Australian', 'Chinese', 'Japanese', 'Brazilian', 'French', 'German', 'Spanish', 'Nigerian', 'Pakistani', 'Egyptian', 'Mixed'].includes(parsed.targetRegion) ? parsed.targetRegion : 'Global';
    industry = parsed.industry || '';
  } catch (e) {
    // Fallback to meta description
    description =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      '';
  }

  return {
    brandName: brandName.trim(),
    logoUrl,
    faviconUrl,
    brandColors: [...new Set(brandColors.map(c => c.toLowerCase()))].slice(0, 5),
    description: description || metaDesc || `Official platform and digital presence for ${brandName}.`,
    toneOfVoice,
    ctaStyle,
    targetRegion,
    industry,
    domain,
    siteContext: siteContext.substring(0, 8000),
  };
};
