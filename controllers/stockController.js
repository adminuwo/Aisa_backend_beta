import * as stockService from '../services/stockService.js';
import * as cashflowService from '../services/cashflowService.js';
import logger from '../utils/logger.js';
import { subscriptionService } from '../services/subscriptionService.js';
import { retrieveContextFromRag } from '../services/vertex.service.js';
import { AskVertexRaw } from '../services/vertex.service.js';

export const getQuote = async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol is required' });
        
        const quote = await stockService.getQuote(symbol);
        res.json({ quote });
    } catch (error) {
        logger.error(`[Stock Controller] Quote Error: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch quote' });
    }
};

export const getIntraday = async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

        const intraday = await stockService.getIntraday(symbol);
        
        if (req.creditMeta) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.json({ intraday });
    } catch (error) {
        logger.error(`[Stock Controller] Intraday Error: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch intraday' });
    }
};

export const getNews = async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

        const news = await stockService.getNews(symbol);

        if (req.creditMeta) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.json({ news });
    } catch (error) {
        logger.error(`[Stock Controller] News Error: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch news' });
    }
};

export const getHistorical = async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

        const historical = await stockService.getHistorical(symbol);

        if (req.creditMeta) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.json({ historical });
    } catch (error) {
        logger.error(`[Stock Controller] Historical Error: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch historical data' });
    }
};

export const getAdvisory = async (req, res) => {
    try {
        const { symbol } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

        const advisory = await stockService.getAdvisory(symbol);

        if (req.creditMeta) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.json({ advisory });
    } catch (error) {
        logger.error(`[Stock Controller] Advisory Error: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch advisory details' });
    }
};

export const getResearch = async (req, res) => {
    try {
        const { symbol, name } = req.query;
        if (symbol) {
            const snapshot = await stockService.getAiSnapshot(symbol, name);
            if (req.creditMeta) {
                await subscriptionService.deductCreditsFromMeta(req.creditMeta);
            }
            return res.json({ research: snapshot });
        }
        
        if (req.creditMeta) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.json({ research });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch research' });
    }
};

/**
 * GET /api/stock/graham-analysis
 * Generates a Benjamin Graham-style analysis for a stock,
 * retrieving context from "The Intelligent Investor" in the RAG corpus.
 */
export const getGrahamAnalysis = async (req, res) => {
    try {
        const { symbol, name, price } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

        const stockName = name || symbol.split('.')[0];
        
        // Stock-specific + principle-focused query for better RAG retrieval
        const query = `value investing margin of safety intrinsic value defensive investor enterprising investor Benjamin Graham Intelligent Investor ${stockName} stock analysis`;

        // 1. Retrieve relevant passages from "The Intelligent Investor" via RAG
        logger.info(`[Graham] Retrieving context from RAG for ${symbol} with query: "${query}"`);
        const ragResult = await retrieveContextFromRag(query, 8, 'FINANCE');
        const bookContext = ragResult?.text || '';
        const ragUsed = !!(ragResult && bookContext.length > 50);
        console.log(`[Graham DEBUG] RAG used: ${ragUsed} | Sources: ${ragResult?.sources?.length || 0} | Context length: ${bookContext.length}`);

        // 2. Get current advisory data for indicators
        const advisory = await stockService.getAdvisory(symbol);

        // 3. Build the Graham analysis prompt
        const bookSection = ragUsed 
            ? `Relevant excerpts from "The Intelligent Investor" (your actual teachings):\n${bookContext}`
            : `Apply your core principles from memory: margin of safety, intrinsic value, Mr. Market metaphor, defensive vs enterprising investor, and never speculate.`;

        const prompt = `
You are Benjamin Graham, the father of value investing, author of "The Intelligent Investor".
Analyze the stock ${stockName} (${symbol}) from your core investment philosophy.

Current Market Data for ${stockName}:
- Stock Symbol: ${symbol}
- Current Price: ₹${price || 'Unknown'}
- RSI: ${advisory?.indicators?.RSI || 'N/A'}
- MACD: ${advisory?.indicators?.MACD || 'N/A'}
- SMA20: ${advisory?.indicators?.SMA || 'N/A'}
- Ichimoku Trend: ${advisory?.indicators?.Ichimoku || 'N/A'}
- 61.8% Fibonacci Level: ₹${advisory?.indicators?.Fibonacci || 'N/A'}

${bookSection}

Based on your philosophy from "The Intelligent Investor", provide a structured analysis SPECIFIC to ${stockName}.
IMPORTANT: Your analysis must be relevant to ${stockName} stock (${symbol}), not generic.
Return ONLY valid JSON with this EXACT structure:
{
  "graham_verdict": "BUY" | "HOLD" | "AVOID",
  "margin_of_safety": "Specific assessment for ${stockName}: whether the current price offers a margin of safety",
  "intrinsic_value_note": "Commentary on ${stockName}'s estimated intrinsic value vs current price",
  "defensive_investor": "Is ${stockName} suitable for a defensive (passive) investor? Give specific reasons.",
  "enterprising_investor": "Is ${stockName} suitable for an enterprising (active) investor? Give specific reasons.",
  "graham_number_note": "P/E and P/B considerations specifically for ${stockName}",
  "key_principle_applied": "Which specific principle from The Intelligent Investor is most relevant for ${stockName}?",
  "graham_quote": "A relevant quote or paraphrase from your teachings that applies to ${stockName}",
  "final_advice": "Your final one-paragraph advice as Benjamin Graham specifically about ${stockName}"
}
`;

        logger.info(`[Graham] Generating Benjamin Graham analysis for ${symbol}...`);
        const aiResponse = await AskVertexRaw(prompt, { temperature: 0.4, maxOutputTokens: 2048 });
        
        let grahamData = {};
        try {
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            const cleanJson = jsonMatch ? jsonMatch[0] : aiResponse.replace(/```json\s*|\s*```/g, '').trim();
            grahamData = JSON.parse(cleanJson);
        } catch (parseErr) {
            logger.error(`[Graham] JSON Parse Error. Raw: ${aiResponse.substring(0, 100)}...`);
            throw new Error(`AI generated invalid format: ${parseErr.message}`);
        }

        if (req.creditMeta) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.json({ 
            graham: {
                ...grahamData,
                symbol,
                name: stockName,
                source: 'The Intelligent Investor — Benjamin Graham',
                rag_used: ragUsed
            }
        });

    } catch (error) {
        logger.error(`[Graham Analysis] CRITICAL FAILURE: ${error.stack || error.message}`);
        res.json({
            graham: {
                graham_verdict: 'HOLD',
                margin_of_safety: 'Unable to retrieve full analysis. Apply caution.',
                intrinsic_value_note: 'Evaluate P/E ratio and book value independently.',
                defensive_investor: 'Verify earnings stability over 10 years before investing.',
                enterprising_investor: 'Look for net-current-asset value opportunities.',
                graham_number_note: 'Ensure P/E × P/B < 22.5 before committing capital.',
                key_principle_applied: 'Margin of Safety',
                graham_quote: '"The intelligent investor is a realist who sells to optimists and buys from pessimists."',
                final_advice: 'Exercise patience, demand a margin of safety, and never speculate.',
                source: 'The Intelligent Investor — Benjamin Graham',
                rag_used: false,
                error_context: error.message
            }
        });
    }
};

/**
 * GET /api/stock/kiyosaki-analysis
 * Generates a Robert Kiyosaki-style analysis for a stock,
 * retrieving context from "Rich Dad Poor Dad" in the RAG corpus.
 */
export const getKiyosakiAnalysis = async (req, res) => {
    try {
        const { symbol, name, price } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

        const stockName = name || symbol.split('.')[0];
        
        // Stock-specific + principle-focused query for better RAG retrieval
        const query = `cashflow assets liabilities financial education wealth building Rich Dad Poor Dad Robert Kiyosaki ${stockName} investment stock`;

        logger.info(`[Kiyosaki] Retrieving context from RAG for ${symbol} with query: "${query}"`);
        const ragResult = await retrieveContextFromRag(query, 8, 'FINANCE');
        const bookContext = ragResult?.text || '';
        const ragUsed = !!(ragResult && bookContext.length > 50);
        console.log(`[Kiyosaki DEBUG] RAG used: ${ragUsed} | Sources: ${ragResult?.sources?.length || 0} | Context Length: ${bookContext.length}`);

        const advisory = await stockService.getAdvisory(symbol);

        const bookSection = ragUsed
            ? `Relevant excerpts from "Rich Dad Poor Dad" (your actual teachings):\n${bookContext}`
            : `Apply your core principles from memory: assets put money in your pocket, liabilities take money out. Focus on cashflow, financial education, and making money work for you.`;
        
        const prompt = `
You are Robert Kiyosaki, author of "Rich Dad Poor Dad".
Analyze the stock ${stockName} (${symbol}) from your perspective on wealth building and cashflow.

Current Market Data for ${stockName}:
- Stock Symbol: ${symbol}
- Current Price: ₹${price || 'Unknown'}
- RSI: ${advisory?.indicators?.RSI || 'N/A'}
- MACD: ${advisory?.indicators?.MACD || 'N/A'}
- Trend: ${advisory?.indicators?.Ichimoku || 'N/A'}

${bookSection}

Return ONLY valid JSON SPECIFIC to ${stockName}. Do NOT be generic — analyze THIS specific company.
{
  "kiyosaki_verdict": "BUY" | "HOLD" | "AVOID",
  "cashflow_perspective": "How does ${stockName} (${symbol}) fit into a cashflow-focused portfolio?",
  "asset_vs_liability": "Is ${stockName} a true asset by your definition? Why?",
  "financial_literacy_tip": "A specific tip for investing in ${stockName}'s sector to improve financial IQ",
  "risk_assessment": "Specific risk assessment for ${stockName} as an investment",
  "rich_dad_advice": "What would Rich Dad say about investing in ${stockName} right now?",
  "kiyosaki_quote": "A relevant quote or principle from your teachings that applies to ${stockName}",
  "final_summary": "Your final one-paragraph advice on whether ${stockName} helps build true wealth"
}
`;

        logger.info(`[Kiyosaki] Generating analysis for ${symbol}...`);
        const aiResponse = await AskVertexRaw(prompt, { temperature: 0.5, maxOutputTokens: 2048 });
        
        let kiyosakiData = {};
        try {
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            const cleanJson = jsonMatch ? jsonMatch[0] : aiResponse.replace(/```json\s*|\s*```/g, '').trim();
            kiyosakiData = JSON.parse(cleanJson);
        } catch (parseErr) {
            logger.error(`[Kiyosaki] JSON Parse Error. Raw: ${aiResponse.substring(0, 100)}...`);
            throw new Error(`AI generated invalid format: ${parseErr.message}`);
        }

        if (req.creditMeta) {
            await subscriptionService.deductCreditsFromMeta(req.creditMeta);
        }

        res.json({ 
            kiyosaki: {
                ...kiyosakiData,
                symbol,
                name: stockName,
                source: 'Rich Dad Poor Dad — Robert Kiyosaki',
                rag_used: ragUsed
            }
        });

    } catch (error) {
        logger.error(`[Kiyosaki Analysis] CRITICAL FAILURE: ${error.stack || error.message}`);
        res.json({
            kiyosaki: {
                kiyosaki_verdict: 'HOLD',
                cashflow_perspective: 'Looking for assets that provide consistent cashflow.',
                asset_vs_liability: 'Remember: An asset puts money in your pocket.',
                financial_literacy_tip: 'Mind your own business and keep your daytime job but start buying real assets.',
                risk_assessment: 'Risk comes from not knowing what you are doing.',
                rich_dad_advice: 'Don’t work for money, make money work for you.',
                kiyosaki_quote: 'It’s not how much money you make. It’s how much money you keep.',
                final_summary: 'Focus on financial education and building an asset column that generates enough income to cover your expenses.',
                source: 'Rich Dad Poor Dad — Robert Kiyosaki',
                rag_used: false,
                error_context: error.message
            }
        });
    }
};

export const searchStocks = async (req, res) => {
    try {
        const { q, keywords } = req.query;
        const searchTerm = q || keywords;
        if (!searchTerm) return res.status(400).json({ error: 'Search term is required' });

        const matches = await cashflowService.searchStocks(searchTerm);
        res.json(matches);
    } catch (error) {
        logger.error(`[Stock Controller] Search Error: ${error.message}`);
        res.status(500).json({ error: 'Failed to search stocks' });
    }
};
