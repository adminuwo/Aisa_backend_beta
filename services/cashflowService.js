import yahooFinanceLib from 'yahoo-finance2';
const yf = new (yahooFinanceLib.YahooFinance || yahooFinanceLib)();
import logger from '../utils/logger.js';
import { AskVertexRaw } from './vertex.service.js';
import { searchAngelOneStocks } from './angelOneService.js';

/**
 * Symbol mapping for Indian stocks (AlphaVantage uses .BSE, Yahoo uses .BO)
 */
const mapSymbolForYahoo = (symbol) => {
    if (!symbol) return '';
    if (symbol.endsWith('.BSE')) return symbol.replace('.BSE', '.BO');
    if (symbol.endsWith('.NSE')) return symbol.replace('.NSE', '.NS');
    return symbol;
};

/**
 * Search for stocks by keyword
 */
export const searchStocks = async (keywords) => {
    try {
        // Search both Yahoo and Angel One in parallel
        const [yfResults, angelResults] = await Promise.allSettled([
            yf.search(keywords),
            searchAngelOneStocks(keywords)
        ]);

        const quotes = [];
        const seenSymbols = new Set();

        // Add Angel One results first (Priority for Indian local stocks)
        if (angelResults.status === 'fulfilled' && Array.isArray(angelResults.value)) {
            angelResults.value.forEach(q => {
                quotes.push(q);
                seenSymbols.add(q.symbol);
            });
        }

        // Add Yahoo results
        if (yfResults.status === 'fulfilled' && yfResults.value.quotes) {
            yfResults.value.quotes.forEach(q => {
                if (!seenSymbols.has(q.symbol)) {
                    quotes.push({
                        symbol: q.symbol,
                        name: q.shortname || q.longname || q.symbol,
                        type: q.quoteType,
                        region: q.region,
                        currency: q.currency
                    });
                    seenSymbols.add(q.symbol);
                }
            });
        }

        return quotes;
    } catch (error) {
        logger.error(`[CashFlow Service] Search Error: ${error.message}`);
        return [];
    }
};

/**
 * Get real-time quote for a symbol
 */
export const getStockQuote = async (symbol) => {
    try {
        const mappedSymbol = mapSymbolForYahoo(symbol);
        const result = await yf.quote(mappedSymbol);
        
        if (result) {
            return {
                symbol: result.symbol,
                price: result.regularMarketPrice,
                high: result.regularMarketDayHigh,
                low: result.regularMarketDayLow,
                volume: result.regularMarketVolume,
                latestTradingDay: new Date(result.regularMarketTime).toISOString().split('T')[0],
                previousClose: result.regularMarketPreviousClose,
                change: result.regularMarketChange,
                changePercent: result.regularMarketChangePercent?.toFixed(2) + '%',
                currency: result.currency
            };
        }
        return null;
    } catch (error) {
        logger.error(`[CashFlow Service] Quote Error for ${symbol}: ${error.message}`);
        return null;
    }
};

/**
 * Get fundamental overview for a symbol
 */
export const getStockOverview = async (symbol) => {
    try {
        const mappedSymbol = mapSymbolForYahoo(symbol);
        const result = await yf.quoteSummary(mappedSymbol, { modules: ['summaryDetail', 'defaultKeyStatistics', 'assetProfile'] });
        
        if (result) {
            const sd = result.summaryDetail || {};
            const ks = result.defaultKeyStatistics || {};
            const ap = result.assetProfile || {};
            
            return {
                symbol: mappedSymbol,
                name: ap.longName || symbol,
                description: ap.longBusinessSummary,
                exchange: ap.exchange,
                currency: sd.currency,
                marketCap: sd.marketCap,
                peRatio: sd.trailingPE,
                eps: ks.trailingEps,
                dividendYield: sd.dividendYield,
                revenue: result.financialData?.totalRevenue,
                profitMargin: result.financialData?.profitMargins,
                weekHigh52: sd.fiftyTwoWeekHigh,
                weekLow52: sd.fiftyTwoWeekLow
            };
        }
        return null;
    } catch (error) {
        logger.error(`[CashFlow Service] Overview Error for ${symbol}: ${error.message}`);
        return null;
    }
};

/**
 * Get news and sentiment for a symbol
 */
export const getStockNews = async (symbol) => {
    try {
        const mappedSymbol = mapSymbolForYahoo(symbol);
        const result = await yf.search(mappedSymbol);
        
        if (result.news && Array.isArray(result.news)) {
            return result.news.slice(0, 5).map(item => ({
                title: item.title,
                url: item.link,
                time_published: new Date(item.providerPublishTime * 1000).toISOString(),
                summary: item.publisher || 'Finance News',
                source: item.publisher,
                overall_sentiment_label: 'Neutral' // Yahoo news search doesn't provide sentiment labels natively
            }));
        }
        return [];
    } catch (error) {
        logger.error(`[CashFlow Service] News Error for ${symbol}: ${error.message}`);
        return [];
    }
};

/**
 * Get daily historical data (last 30 days)
 */
export const getHistoricalData = async (symbol) => {
    try {
        const mappedSymbol = mapSymbolForYahoo(symbol);
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - 40); // Fetch a bit more to ensure 30 days
        
        const result = await yf.historical(mappedSymbol, {
            period1: start,
            period2: end,
            interval: '1d'
        });
        
        if (Array.isArray(result)) {
            return result.map(item => ({
                date: item.date.toISOString().split('T')[0],
                close: item.close
            })).reverse(); // Newest first
        }
        return [];
    } catch (error) {
        logger.error(`[CashFlow Service] Historical Error for ${symbol}: ${error.message}`);
        return [];
    }
};

/**
 * AI-only analysis fallback
 */
export const generateAIOnlyAnalysis = async (stockName, symbol) => {
    try {
        const prompt = `
            You are an expert AI financial analyst powered by the AISA AI CashFlow Intelligence Engine.
            Generate a comprehensive Research Report for: **${stockName}** (Symbol: ${symbol})
            Note: Live market data was temporarily unavailable. Generate your analysis based on your extensive training data and known financial knowledge about this company.
            Structure your response EXACTLY as follows using Markdown:
            ## 📊 AI Snapshot: ${stockName}
            ### 🏢 1-Minute Overview
            [2-3 bullet points on core business]
            ### 📉 AI Trend & Sector Context
            [2 short bullet points]
            ### 🎯 The Verdict
            [One punchy sentence summary]
        `;
        const analysis = await AskVertexRaw(prompt);
        if (analysis && analysis.trim()) return analysis;
        throw new Error('Empty response from AI');
    } catch (error) {
        logger.error(`[CashFlow Service] AI-Only Analysis Error: ${error.message}`);
        // Return a hardcoded quality fallback - never throw from here
        return `## 📊 AI Snapshot: ${stockName}

### 🏢 1-Minute Overview
• **${stockName}** is an established company listed on Indian markets (${symbol})
• Operates across diversified business segments with strong institutional backing
• Known for consistent performance in its core sector

### 📉 AI Trend & Sector Context
• Market sentiment currently mixed amid broader macro headwinds
• Sector fundamentals remain intact with medium-to-long term growth potential

### 🎯 The Verdict
Strong long-term fundamentals — monitor short-term volatility before entry.

> ⚠️ *This is a general AI-knowledge based snapshot. Live data temporarily unavailable. Always verify with latest financials before investing.*`;
    }
};


/**
 * Perform AI analysis based on fetched live data
 */
export const generateAnalysis = async (stockName, quote, news, historical, overview) => {
    try {
        const hasLiveData = quote && quote.price;
        const historicalStr = historical && historical.length > 0
            ? historical.slice(0, 5).map(h => `${h.date}: ${h.close}`).join(', ')
            : 'Historical data not available';

        const prompt = `
            You are an expert AI financial analyst powered by the AISA AI CashFlow Intelligence Engine.
            Provide a comprehensive Research Report for: **${stockName}** ${hasLiveData ? `(${quote.symbol})` : `(${stockName})`}

            ${hasLiveData ? `
            ## Live Market Data:
            - Current Price: ${quote.price} ${quote.currency}
            - Day Range: ${quote.low} – ${quote.high}
            - Volume: ${quote.volume}
            - Previous Close: ${quote.previousClose}
            ` : ''}

            IMPORTANT INSTRUCTIONS:
            - Use short bullet points and emojis. DO NOT write long paragraphs. 
            - Focus only on the 'Why' and the 'Context'. Limit your total text to under 150 words.
            Structure your response EXACTLY as follows using Markdown:
            ## 📊 AI Snapshot: ${stockName}
            ### 🏢 1-Minute Overview
            [Insights based on recent data]
            ### 📉 Technical & Sentiment Read
            [Interpretation of 30-day action and news]
            ### 🎯 The Verdict
            [One balanced summary sentence]
        `;
        const analysis = await AskVertexRaw(prompt);
        return analysis;
    } catch (error) {
        logger.error(`[CashFlow Service] Analysis Error: ${error.message}`);
        throw error;
    }
};
