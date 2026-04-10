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
 * Downloads and caches the Angel One Scrip Master
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

            const writer = fs.createWriteStream(CACHE_FILE);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            
            logger.info('[AngelScripMaster] Scrip Master updated successfully.');
        }

        // Load into memory (Caution: ~15MB file, consumes ~50-100MB RAM when parsed)
        const rawData = fs.readFileSync(CACHE_FILE, 'utf8');
        scripData = JSON.parse(rawData);
        lastUpdated = Date.now();
        
        return scripData;
    } catch (error) {
        logger.error(`[AngelScripMaster] sync failed: ${error.message}`);
        // Fallback to existing cache if available
        if (fs.existsSync(CACHE_FILE)) {
             const rawData = fs.readFileSync(CACHE_FILE, 'utf8');
             scripData = JSON.parse(rawData);
             return scripData;
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
