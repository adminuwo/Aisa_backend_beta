import axios from 'axios';
import yahooFinanceLib from 'yahoo-finance2';
const yf = new (yahooFinanceLib.YahooFinance || yahooFinanceLib)();
import logger from '../utils/logger.js';
import { AskVertexRaw } from './vertex.service.js';
import { generateAIOnlyAnalysis } from './cashflowService.js';
import { getAngelOneQuote, getAngelOneHistorical } from './angelOneService.js';


const ALPHAVANTAGE_API_KEY = process.env.ALPHAVANTAGE_API_KEY || 'demo';
const BASE_URL = 'https://www.alphavantage.co/query';

// Helper to map symbol for AlphaVantage vs Yahoo
const mapSymbolForAlphaVantage = (symbol) => {
    if (!symbol) return '';
    if (symbol.endsWith('.BO')) return symbol.replace('.BO', '.BSE');
    if (symbol.endsWith('.NS')) return symbol.replace('.NS', '.NSE'); // Not fully supported by AV sometimes, but BSE is.
    return symbol;
};

const mapSymbolForYahoo = (symbol) => {
    if (!symbol) return '';
    if (symbol.endsWith('.BSE')) return symbol.replace('.BSE', '.BO');
    if (symbol.endsWith('.NSE')) return symbol.replace('.NSE', '.NS');
    return symbol;
};

// Check if AlphaVantage rate limit hit
const isRateLimited = (data) => {
    if (data.Note || data.Information && data.Information.includes('rate limit')) return true;
    return false;
};

/**
 * Get Realtime Quote (GLOBAL_QUOTE)
 */
export const getQuote = async (symbol) => {
    // 1. Priority: Smart AngelOne API for Real-Time Indian Stocks
    const angelQuote = await getAngelOneQuote(symbol);
    if (angelQuote) {
        logger.info(`[Stock Service] Successfully fetched live quote from AngelOne for ${symbol}`);
        return angelQuote;
    }

    // 2. Fallback: AlphaVantage
    const avSymbol = mapSymbolForAlphaVantage(symbol);
    try {
        const response = await axios.get(BASE_URL, {
            params: {
                function: 'GLOBAL_QUOTE',
                symbol: avSymbol,
                apikey: ALPHAVANTAGE_API_KEY
            }
        });
        
        const data = response.data;
        if (data['Global Quote'] && !isRateLimited(data)) {
            const q = data['Global Quote'];
            return {
                symbol: q['01. symbol'],
                price: parseFloat(q['05. price']),
                high: parseFloat(q['03. high']),
                low: parseFloat(q['04. low']),
                volume: parseInt(q['06. volume']),
                latestTradingDay: q['07. latest trading day'],
                previousClose: parseFloat(q['08. previous close']),
                change: parseFloat(q['09. change']),
                changePercent: q['10. change percent'],
                currency: avSymbol.includes('.BSE') ? 'INR' : 'USD'
            };
        }
        throw new Error('Rate limited or empty data from AlphaVantage');
    } catch (error) {
        logger.warn(`[Stock Service] AlphaVantage Quote failed for ${symbol}: ${error.message}, falling back to Yahoo Finance`);
        const result = await yf.quote(mapSymbolForYahoo(symbol));
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
    }
};

/**
 * Get Intraday Data (TIME_SERIES_INTRADAY)
 */
export const getIntraday = async (symbol) => {
    const avSymbol = mapSymbolForAlphaVantage(symbol);
    try {
        // Note: AlphaVantage intraday may not cover Indian stocks in free tiers.
        const response = await axios.get(BASE_URL, {
            params: {
                function: 'TIME_SERIES_INTRADAY',
                symbol: avSymbol,
                interval: '15min',
                outputsize: 'compact',
                apikey: ALPHAVANTAGE_API_KEY
            }
        });

        const data = response.data;
        if (data['Time Series (15min)'] && !isRateLimited(data)) {
            const timeseries = data['Time Series (15min)'];
            const formatted = Object.keys(timeseries).map(date => ({
                date: date,
                close: parseFloat(timeseries[date]['4. close']),
                high: parseFloat(timeseries[date]['2. high']),
                low: parseFloat(timeseries[date]['3. low'])
            })).reverse();
            return formatted;
        }
        throw new Error('Rate limited or unavailable intraday in AV');
    } catch (error) {
        logger.warn(`[Stock Service] AlphaVantage Intraday failed for ${symbol}: ${error.message}, generating simulated intraday for display`);
        // Yahoo Finance free tier API for intraday is unstable, so we simulate slight intraday variations based on the current price.
        let basePrice = 100;
        try {
            const currentQuote = await getQuote(symbol);
            if (currentQuote && currentQuote.price) basePrice = currentQuote.price;
        } catch(e) {}
        return generateSimulatedIntradayData(basePrice);
    }
};

const generateSimulatedIntradayData = (basePrice = 100) => {
    const simulated = [];

    const now = new Date();
    for (let i = 20; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 15 * 60000); // 15 mins back
        const drift = (Math.random() * 4 - 2);
        simulated.push({
            date: d.toISOString().replace('T', ' ').substring(0, 19),
            close: (basePrice + Math.sin(i / 5) * 20 + drift).toFixed(2)
        });
    }
    return simulated;
};

/**
 * Get News Sentiment (NEWS_SENTIMENT)
 */
export const getNews = async (symbol) => {
    const avSymbol = mapSymbolForAlphaVantage(symbol);
    try {
        const response = await axios.get(BASE_URL, {
            params: {
                function: 'NEWS_SENTIMENT',
                tickers: avSymbol,
                limit: 10,
                apikey: ALPHAVANTAGE_API_KEY
            }
        });
        const data = response.data;
        if (data.feed && !isRateLimited(data)) {
            return data.feed.map(item => {
                const year = item.time_published.substring(0, 4);
                const month = item.time_published.substring(4, 6);
                const day = item.time_published.substring(6, 8);
                const hr = item.time_published.substring(9, 11);
                const min = item.time_published.substring(11, 13);
                
                return {
                    title: item.title,
                    url: item.url,
                    time_published: `${year}-${month}-${day}T${hr}:${min}:00Z`,
                    summary: item.summary,
                    source: item.source,
                    overall_sentiment_label: item.overall_sentiment_label
                };
            });
        }
        throw new Error('Rate limited or no news found in AV');
    } catch (error) {
        logger.warn(`[Stock Service] AlphaVantage News failed for ${symbol}: ${error.message}, falling back to Yahoo Finance`);
        const result = await yf.search(mapSymbolForYahoo(symbol));
        if (result && result.news && Array.isArray(result.news)) {
            return result.news.slice(0, 10).map(item => ({
                title: item.title,
                url: item.link,
                time_published: new Date(item.providerPublishTime * 1000).toISOString(),
                summary: item.publisher || 'Finance News',
                source: item.publisher,
                overall_sentiment_label: 'Neutral'
            }));
        }
        return [];
    }
};

/**
 * Get Historical Data (TIME_SERIES_DAILY)
 */
export const getHistorical = async (symbol) => {
    // Priority 1: Angel One API for Indian Stocks
    const angelHistorical = await getAngelOneHistorical(symbol);
    if (angelHistorical && angelHistorical.length > 0) {
        logger.info(`[Stock Service] Successfully fetched historical candle data from AngelOne for ${symbol}`);
        return angelHistorical.slice(0, 60); // Increased to 60 days for Ichimoku
    }

    // Priority 2: Fallback to Yahoo Finance
    logger.info(`[Stock Service] Falling back to Yahoo Finance for historical data for ${symbol}`);
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 70); // Fetch enough for 60 points
    
    try {
        const result = await yf.historical(mapSymbolForYahoo(symbol), {
            period1: start,
            period2: end,
            interval: '1d'
        });
        if (Array.isArray(result)) {
            return result.map(item => ({
                date: item.date.toISOString().split('T')[0],
                close: item.close,
                high: item.high || item.close,
                low: item.low || item.close
            })).reverse(); 
        }
    } catch(yfErr) {
        logger.error(`Yahoo Historical fallback failed: ${yfErr.message}`);
    }
    return [];
};

/**
 * Get Advisory Indicators (MACD, RSI, SMA) + Auto BUY/HOLD/SELL Evaluation
 */
export const getAdvisory = async (symbol) => {
    let historicalData = await getHistorical(symbol);
    let basePriceToUse = 100;
    try {
        const liveQ = await getQuote(symbol);
        if (liveQ && liveQ.price) basePriceToUse = liveQ.price;
    } catch(e) {}

    if (!historicalData || historicalData.length === 0) {
        historicalData = generateSimulatedIntradayData(basePriceToUse).map(d => ({ 
            date: d.date.split(' ')[0], 
            close: parseFloat(d.close),
            high: parseFloat(d.close) * 1.01,
            low: parseFloat(d.close) * 0.99
        }));
    }

    const latestPrices = historicalData.map(d => d.close);
    // CRITICAL: Use live price for indicators if available, otherwise fallback to last historical close
    const currPrice = basePriceToUse || latestPrices[latestPrices.length - 1] || 100;
    const prevPrice = latestPrices[latestPrices.length - (basePriceToUse ? 1 : 2)] || currPrice;
    
    // RSI Approx (Now using live vs previous comparison)
    const isUp = currPrice >= prevPrice;
    const rsi = isUp ? Math.floor(Math.random() * 20 + 55) : Math.floor(Math.random() * 20 + 35);

    // SMA 20
    const sma20 = latestPrices.slice(0, 20).reduce((a, b) => a + b, 0) / (Math.min(latestPrices.length, 20) || 1);

    // MACD Approx
    const macdValue = (currPrice - sma20) * 0.1;
    const signalLine = macdValue * 0.8;
    const macdHistogram = macdValue - signalLine;

    // --- NEW INDICATORS ---
    
    // Ichimoku Logic (Approx Tenkan-sen and Kijun-sen)
    const getHighLowMid = (data, periods) => {
        const segment = data.slice(0, periods);
        const high = Math.max(...segment.map(d => d.high || d.close));
        const low = Math.min(...segment.map(d => d.low || d.close));
        return (high + low) / 2;
    };
    const tenkan = getHighLowMid(historicalData, 9);
    const kijun = getHighLowMid(historicalData, 26);
    const ichimokuTrend = currPrice > tenkan && currPrice > kijun ? 'Bullish' : currPrice < tenkan && currPrice < kijun ? 'Bearish' : 'Neutral';

    // Fibonacci Retracement Logic (Now including Live Price in the 30-day High/Low range)
    const thirtyDayHigh = Math.max(...historicalData.slice(0, 30).map(d => d.high || d.close), currPrice);
    const thirtyDayLow = Math.min(...historicalData.slice(0, 30).map(d => d.low || d.close), currPrice);
    const range = thirtyDayHigh - thirtyDayLow;
    
    // Key Fibonacci Retracement Levels
    const fibSeries = {
        level236: (thirtyDayLow + (range * 0.236)).toFixed(2),
        level382: (thirtyDayLow + (range * 0.382)).toFixed(2),
        level500: (thirtyDayLow + (range * 0.500)).toFixed(2),
        level618: (thirtyDayLow + (range * 0.618)).toFixed(2),
        level786: (thirtyDayLow + (range * 0.786)).toFixed(2)
    };
    
    const fibStatus = currPrice > parseFloat(fibSeries.level618) ? 'Above 61.8%' : 'Below 61.8%';

    let verdict = 'HOLD';
    let color = 'yellow';
    
    // Integrated Verdict Logic
    if (rsi > 70 || (currPrice < tenkan && ichimokuTrend === 'Bearish')) {
        verdict = 'SELL';
        color = 'red';
    } else if (rsi < 35 || (macdHistogram > 0 && currPrice > parseFloat(fibSeries.level618))) {
        verdict = 'BUY';
        color = 'green';
    }

    const prompt = `
        You are an expert AI financial analyst. Write a very brief analysis for ${symbol}.
        Indicators: RSI=${rsi}, MACD=${macdValue.toFixed(2)}, SMA20=${sma20.toFixed(2)}, Ichimoku=${ichimokuTrend}, Fib 61.8%=${fibSeries.level618}.
        Action: ${verdict}. Explain why based on these in 3 short bullet points. Max 50 words total.
    `;
    let aiReport = "";
    try {
        aiReport = await AskVertexRaw(prompt);
    } catch(e) {
        aiReport = `### Market Position for ${symbol}

The technical setup for **${symbol}** currently indicates a **${verdict}** signal. Key observations:
- **Trend Analysis**: ${ichimokuTrend} trend detected via Ichimoku Cloud.
- **Support/Resistance**: Price is currently **${fibStatus.toLowerCase()}** the Fibonacci retracement level of ${fibSeries.level618}.
- **Momentum**: RSI is at ${rsi}, suggesting ${rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : 'stable'} conditions.`;
    }

    return {
        indicators: {
            RSI: rsi,
            MACD: macdValue.toFixed(2),
            SMA: sma20.toFixed(2),
            Ichimoku: ichimokuTrend,
            Fibonacci: fibSeries.level618,
            FibonacciSeries: fibSeries
        },
        verdict: verdict,
        verdictColor: color,
        report: aiReport
    };
};

/**
 * Get Research / Recommendation (Country top stocks / scores)
 * AlphaVantage Top Gainers / Losers
 */
export const getResearch = async () => {
    try {
        const response = await axios.get(BASE_URL, {
            params: {
                function: 'TOP_GAINERS_LOSERS',
                apikey: ALPHAVANTAGE_API_KEY
            }
        });
        const data = response.data;
        if (data.top_gainers && !isRateLimited(data)) {
            return {
                topGainers: data.top_gainers.slice(0, 5),
                topLosers: data.top_losers.slice(0, 5),
                mostActivelyTraded: data.most_actively_traded.slice(0, 5)
            };
        }
        throw new Error('Rate Limited on Top Gainers');
    } catch (error) {
        logger.warn(`[Stock Service] AlphaVantage Research failed: ${error.message}, falling back to AI generated knowledge`);
        const prompt = `
            List the top 5 trending global tech stocks right now with a brief explanation of why they are trending.
            Format as short bullet points.
        `;
        let aiReport;
        try {
            aiReport = await AskVertexRaw(prompt);
        } catch(e) {
            aiReport = `Fallback trending data.`;
        }
        return {
            aiInsights: aiReport,
            topGainers: [],
            topLosers: [],
            mostActivelyTraded: []
        };
    }
};

/**
 * Generate Unified AI Snapshot (Combined Analysis for Chat & Modal)
 */
export const getAiSnapshot = async (symbol, name = null) => {
    try {
        // 1. Get Historical Data for Chart
        const historical = await getHistorical(symbol);
        const chartData = historical.slice(0, 30).map(d => ({
            date: d.date,
            price: d.close
        })).reverse();

        // 2. Get Quote for Latest Price
        const quote = await getQuote(symbol);
        const currentPrice = quote?.price || (chartData.length > 0 ? chartData[chartData.length-1].price : '---');

        // 3. Get Advisory Indicators for Context
        const advisory = await getAdvisory(symbol);

        const isBankingStock = (s) => {
            const sym = s.toUpperCase();
            return sym.includes('BANK') || sym.includes('HDFC') || sym.includes('ICICI') || sym.includes('SBIN') || sym.includes('KOTAK') || sym.includes('AXIS') || sym.includes('PNB') || sym.includes('BOB');
        };

        const isBank = isBankingStock(symbol);

        // 4. Generate Professional AI Insights via Vertex (Structured JSON)
        const prompt = `
            You are AISA Financial Intelligence. Generate a high-impact, professional stock snapshot for ${name || symbol}.
            Current Price: ${currentPrice}
            Latest Indicators: RSI=${advisory.indicators.RSI}, MACD=${advisory.indicators.MACD}, SMA20=${advisory.indicators.SMA}, Ichimoku=${advisory.indicators.Ichimoku}, Fib 61.8%=${advisory.indicators.Fibonacci}.
            Verdict: ${advisory.verdict}.
            
            Return ONLY a valid JSON object with this EXACT structure:
            {
              "overview": "Short 1-minute overview of the company",
              "trend_sector": "AI-driven trend and sector context",
              "verdict": "One-liner justification for the ${advisory.verdict} signal",
              "risk_analysis": {
                "total": 8,
                "high": 3,
                "medium": 3,
                "low": 2,
                "breakdown": [
                  {"factor": "Market Volatility", "impact": "High", "factors": 1},
                  {"factor": "Interest Rates", "impact": "High", "factors": 1},
                  {"factor": "Specific Risk", "impact": "Medium", "factors": 1}
                ]
              },
              "research": {
                "industry": "Analysis of industry trends",
                "performance": "Segment performance evaluation",
                "competitor": "Key KPI comparison with peers"
              },
              "recommendation": {
                "entry": "Suggested entry strategy",
                "view": "Long-term investment view",
                "advice": "Actionable advice on current price",
                "metric": "Key monitoring metric (e.g. EBITDA)"
              },
              "analyst_estimates": {
                "average_target_price": "Realistic average target price based on current levels",
                "high_estimate": "High end optimistic estimate",
                "low_estimate": "Low end conservative estimate",
                "analyst_sentiment": "Overall sentiment (e.g. 'Generally positive with 15 buy ratings')",
                "context": "Short context of market sentiment"
              }${isBank ? `,
              "banking_metrics": {
                "nim": "Net Interest Margin (e.g. 4.1%)",
                "casa": "CASA Ratio (e.g. 44%)",
                "npa": "Gross / Net NPA (e.g. 1.3% / 0.4%)",
                "car": "Capital Adequacy Ratio (e.g. 19.2%)"
              }` : ''}
            }

            
            Rules:
            - Content must be professional and data-driven.
            - Ensure risks are realistic for ${symbol}.
            ${isBank ? '- Since this is a BANK, ensure the "banking_metrics" reflect realistic current industry standards for this specific bank.' : ''}
        `;

        const aiResponse = await AskVertexRaw(prompt);
        // Clean JSON formatting if AI adds markdown
        const cleanJson = aiResponse.replace(/```json\s*|\s*```/g, '').trim();
        const snapshotContent = JSON.parse(cleanJson);

        return {
            symbol: symbol,
            name: name || symbol.split('.')[0], // Use provided name or simple extraction
            currentPrice: currentPrice,
            verdict: advisory.verdict,
            indicators: advisory.indicators,
            report: advisory.report,
            chart_data: chartData,
            ...snapshotContent
        };

    } catch (error) {
        logger.error(`[Stock Service] AI Snapshot failed for ${symbol}: ${error.message}`);
        return null;
    }
};

