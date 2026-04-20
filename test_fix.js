import { chat } from './services/ai.service.js';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// Mock dependencies if needed, or just connect to DB
async function test() {
    try {
        console.log("--- STARTING TEST FOR hasCompanyKeyword FIX ---");
        
        // We don't necessarily need DB for the variable definition check
        const response = await chat("rent agreement bnao", null, { mode: 'LEGAL_TOOLKIT' });
        console.log("Response:", response.text.substring(0, 100) + "...");
        console.log("--- TEST SUCCESSFUL (No ReferenceError) ---");
    } catch (err) {
        console.error("--- TEST FAILED ---");
        console.error(err);
    } finally {
        process.exit(0);
    }
}

test();
