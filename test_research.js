import * as stockService from './services/stockService.js';
import logger from './utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
    console.log("Testing HDFCBANK research snapshot...");
    try {
        const result = await stockService.getAiSnapshot('HDFCBANK.BSE');
        console.log("Result for HDFCBANK:");
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("Error for HDFCBANK:", e);
    }

    console.log("\nTesting TCS research snapshot...");
    try {
        const result = await stockService.getAiSnapshot('TCS.BSE');
        console.log("Result for TCS:");
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("Error for TCS:", e);
    }
}

test();
