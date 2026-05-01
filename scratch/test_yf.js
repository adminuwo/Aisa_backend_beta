import yahooFinanceLib from 'yahoo-finance2';
const yf = new (yahooFinanceLib.YahooFinance || yahooFinanceLib)();

async function test() {
    try {
        console.log("Testing Yahoo Finance for TCS.BO...");
        const result = await yf.quote('TCS.BO');
        console.log("Result:", JSON.stringify(result, null, 2));
    } catch (err) {
        console.error("Error:", err.message);
    }
}

test();
