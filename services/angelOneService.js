import axios from 'axios';
import logger from '../utils/logger.js';
import { getInstrumentBySymbol, searchInstruments } from '../utils/angelScripMaster.js';

// Pre-defined mapping for preset Indian stocks from frontend
// TCS, Reliance, HDFC Bank, Infosys, SBI
const ANGEL_TOKEN_MAP = {
    'TCS.BSE': { exchange: 'NSE', token: '11536' },
    'TCS.NSE': { exchange: 'NSE', token: '11536' },
    'TCS': { exchange: 'NSE', token: '11536' },
    'RELIANCE.BSE': { exchange: 'NSE', token: '2885' },
    'RELIANCE.NSE': { exchange: 'NSE', token: '2885' },
    'RELIANCE': { exchange: 'NSE', token: '2885' },
    'HDFCBANK.BSE': { exchange: 'NSE', token: '1333' },
    'HDFCBANK.NSE': { exchange: 'NSE', token: '1333' },
    'HDFCBANK': { exchange: 'NSE', token: '1333' },
    'INFY.BSE': { exchange: 'NSE', token: '1594' },
    'INFY.NSE': { exchange: 'NSE', token: '1594' },
    'INFY': { exchange: 'NSE', token: '1594' },
    'SBIN': { exchange: 'NSE', token: '3045' }, // As per user's example
};

/**
 * Fetch Realtime Quote from Smart AngelOne Market API
 */
export const getAngelOneQuote = async (symbol) => {
    try {
        const apiKey = process.env.ANGEL_ONE_API_KEY;
        const authToken = process.env.ANGEL_ONE_AUTH_TOKEN;

        // If credentials are not set, return null silently to fallback
        if (!apiKey || !authToken) {
            return null;
        }

        let mappedData = ANGEL_TOKEN_MAP[symbol];
        
        // Dynamic fallback: If not in hardcoded map, check scrip master
        if (!mappedData) {
            const dynamicMatch = await getInstrumentBySymbol(symbol);
            if (dynamicMatch) {
                mappedData = { exchange: dynamicMatch.exch_seg, token: dynamicMatch.token };
            }
        }

        if (!mappedData) {
            return null; // Not an Indian stock found in SmartAPI master
        }

        const data = JSON.stringify({
            "mode": "FULL",
            "exchangeTokens": {
                [mappedData.exchange]: [mappedData.token]
            }
        });

        const config = {
            method: 'post',
            url: 'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
            headers: { 
                'X-PrivateKey': apiKey, 
                'Accept': 'application/json', 
                'X-SourceID': 'WEB', 
                'X-ClientLocalIP': process.env.ANGEL_ONE_LOCAL_IP || '192.168.1.1', 
                'X-ClientPublicIP': process.env.ANGEL_ONE_PUBLIC_IP || '106.193.147.98', 
                'X-MACAddress': process.env.ANGEL_ONE_MAC || '00-B0-D0-63-C2-26', 
                'X-UserType': 'USER', 
                'Authorization': `Bearer ${authToken}`, 
                'Content-Type': 'application/json'
            },
            data : data
        };

        const response = await axios(config);
        const resData = response.data;
        
        if (resData.status && resData.data && resData.data.fetched && resData.data.fetched.length > 0) {
            const quoteData = resData.data.fetched[0];
            
            // Format to match our existing service schema
            return {
                symbol: symbol,
                price: parseFloat(quoteData.ltp),
                high: parseFloat(quoteData.highPrice),
                low: parseFloat(quoteData.lowPrice),
                volume: parseInt(quoteData.volume),
                latestTradingDay: new Date().toISOString().split('T')[0],
                previousClose: parseFloat(quoteData.closePrice),
                change: parseFloat(quoteData.ltp) - parseFloat(quoteData.closePrice),
                changePercent: ((parseFloat(quoteData.ltp) - parseFloat(quoteData.closePrice)) / parseFloat(quoteData.closePrice) * 100).toFixed(2) + '%',
                currency: 'INR'
            };
        }

        return null;
    } catch (error) {
        logger.error(`[AngelOne] Proxy Quote Error: ${error.message}`);
        return null; // Fallback to Alpha/Yahoo
    }
};

/**
 * Fetch Historical Candle Data from AngelOne REST
 */
export const getAngelOneHistorical = async (symbol) => {
    try {
        const apiKey = process.env.ANGEL_ONE_API_KEY;
        const authToken = process.env.ANGEL_ONE_AUTH_TOKEN;

        if (!apiKey || !authToken) return null;

        let mappedData = ANGEL_TOKEN_MAP[symbol];
        
        // Dynamic fallback: If not in hardcoded map, check scrip master
        if (!mappedData) {
            const dynamicMatch = await getInstrumentBySymbol(symbol);
            if (dynamicMatch) {
                mappedData = { exchange: dynamicMatch.exch_seg, token: dynamicMatch.token };
            }
        }

        if (!mappedData) return null;

        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(toDate.getDate() - 35); // Approx 30 trading days

        // Format: "YYYY-MM-DD HH:mm"
        const formatAngelDate = (d) => {
            const pad = (n) => n.toString().padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 09:15`;
        };
        const formatAngelEndDate = (d) => {
            const pad = (n) => n.toString().padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 15:30`;
        };

        const data = JSON.stringify({
            "exchange": mappedData.exchange,
            "symboltoken": mappedData.token,
            "interval": "ONE_DAY",
            "fromdate": formatAngelDate(fromDate),
            "todate": formatAngelEndDate(toDate)
        });

        const config = {
            method: 'post',
            url: 'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
            headers: { 
                'X-PrivateKey': apiKey, 
                'Accept': 'application/json', 
                'X-SourceID': 'WEB', 
                'X-ClientLocalIP': process.env.ANGEL_ONE_LOCAL_IP || '192.168.1.1', 
                'X-ClientPublicIP': process.env.ANGEL_ONE_PUBLIC_IP || '106.193.147.98', 
                'X-MACAddress': process.env.ANGEL_ONE_MAC || '00-B0-D0-63-C2-26', 
                'X-UserType': 'USER', 
                'Authorization': `Bearer ${authToken}`, 
                'Content-Type': 'application/json'
            },
            data : data
        };

        const response = await axios(config);
        const resData = response.data;

        if (resData.status && Array.isArray(resData.data)) {
            // response.data format is array of arrays: [ timestamp, open, high, low, close, volume ]
            return resData.data.map(candle => ({
                date: candle[0].split('T')[0],
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
                volume: candle[5]
            })).reverse(); // Frontend expects newest first or order? AlphaV fallback reversed it, we'll keep consistent.
        }
        return null;
    } catch (error) {
        logger.error(`[AngelOne] Historical Error: ${error.message}`);
        return null; // Fallback to Yahoo
    }
};

/**
 * Searches AngelOne for matching instruments
 */
export const searchAngelOneStocks = async (query) => {
    try {
        const matches = await searchInstruments(query);
        return matches.map(m => ({
            symbol: `${m.symbol.replace('-EQ', '')}.${m.exch_seg}`,
            name: m.name,
            type: 'EQUITY',
            region: 'IN',
            currency: 'INR',
            exchange: m.exch_seg,
            fullName: m.name,
            token: m.token
        }));
    } catch (error) {
        logger.error(`[AngelOne] Search Error: ${error.message}`);
        return [];
    }
};
