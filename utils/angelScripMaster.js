import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const CACHE_FILE = path.join(__dirname, '../temp/scripMaster.json');
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

let scripData = null;
let lastUpdated = 0;

/**
 * Downloads and caches the Angel One Scrip Master.
 * Uses an atomic write pattern (stream to .tmp file, rename on success)
 * to prevent reading a partially-written / truncated JSON file.
 */
export const syncScripMaster = async (force = false) => {
    try {
        // Create temp dir if missing
        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const stats = fs.existsSync(CACHE_FILE) ? fs.statSync(CACHE_FILE) : null;
        const isExpired = stats ? (Date.now() - stats.mtimeMs > CACHE_DURATION) : true;

        if (!isExpired && !force && scripData) {
            return scripData;
        }

        if (isExpired || force) {
            logger.info('[AngelScripMaster] Downloading latest Scrip Master from Angel One...');
            const response = await axios({
                method: 'get',
                url: SCRIP_MASTER_URL,
                responseType: 'stream'
            });

            // --- Atomic write: stream to .tmp file, rename to real file only on success ---
            // This prevents the real cache file from ever being in a partially-written state.
            const tmpFile = CACHE_FILE + '.tmp';
            const writer = fs.createWriteStream(tmpFile);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.data.on('error', reject);
            });

            // Only replace the real cache file after the full download succeeded
            fs.renameSync(tmpFile, CACHE_FILE);
            logger.info('[AngelScripMaster] Scrip Master updated successfully.');
        }

        // Validate file is non-empty before parsing
        const fileStats = fs.statSync(CACHE_FILE);
        if (fileStats.size === 0) {
            throw new Error('Scrip Master file is empty after download');
        }

        // Load into memory (Caution: ~15MB file, consumes ~50-100MB RAM when parsed)
        const rawData = fs.readFileSync(CACHE_FILE, 'utf8');
        scripData = JSON.parse(rawData);
        lastUpdated = Date.now();

        return scripData;
    } catch (error) {
        logger.error(`[AngelScripMaster] sync failed: ${error.message}`);

        // If we already have in-memory data from a previous successful load, use it
        if (scripData) {
            return scripData;
        }

        // Last resort: try the cache file only if it exists and is non-empty
        if (fs.existsSync(CACHE_FILE)) {
            try {
                const fileStats = fs.statSync(CACHE_FILE);
                if (fileStats.size > 0) {
                    const rawData = fs.readFileSync(CACHE_FILE, 'utf8');
                    scripData = JSON.parse(rawData);
                    return scripData;
                }
            } catch (cacheErr) {
                logger.error(`[AngelScripMaster] Cache fallback also failed: ${cacheErr.message}`);
                // Delete the corrupt file so the next startup re-downloads it cleanly
                try { fs.unlinkSync(CACHE_FILE); } catch (_) {}
            }
        }

        return [];
    }
};

/**
 * Searches for instruments in the scrip master
 */
export const searchInstruments = async (query) => {
    if (!scripData) await syncScripMaster();

    const searchLow = query.toUpperCase();

    // Filter for Equity instruments only for now, matching the query
    // Filters: Cash market (instrumenttype empty), Symbol contains query
    const results = scripData
        .filter(item =>
            (item.exch_seg === 'NSE' || item.exch_seg === 'BSE') &&
            item.instrumenttype === '' && // Empty means Cash/Equity
            (item.symbol.includes(searchLow) || item.name.includes(searchLow))
        );

    // Prioritize BSE results for better TradingView widget compatibility
    return results.sort((a, b) => {
        if (a.exch_seg === 'BSE' && b.exch_seg === 'NSE') return -1;
        if (a.exch_seg === 'NSE' && b.exch_seg === 'BSE') return 1;
        return 0;
    }).slice(0, 10);
};

/**
 * Finds a specific instrument by symbol and default exchange
 */
export const getInstrumentBySymbol = async (symbol, preferredExch = 'NSE') => {
    if (!scripData) await syncScripMaster();

    // Clean symbol (remove .BSE or .NSE if present)
    const cleanSym = symbol.split('.')[0].toUpperCase();

    // Some symbols in Angel One have "-EQ" suffix
    const searchSym = `${cleanSym}-EQ`;

    let match = scripData.find(item => item.symbol === searchSym && item.exch_seg === preferredExch);
    if (!match) {
        match = scripData.find(item => item.symbol === cleanSym && item.exch_seg === preferredExch);
    }
    if (!match) {
        match = scripData.find(item => item.name === cleanSym && item.exch_seg === preferredExch);
    }

    return match;
};
