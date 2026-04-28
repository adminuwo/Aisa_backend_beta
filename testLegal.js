import * as legalService from './services/legalIntelligence.service.js';
import dotenv from 'dotenv';
dotenv.config();

(async () => {
    try {
        console.log("Testing analyzeCaseDetails...");
        const result = await legalService.analyzeCaseDetails("Employee terminated without notice.", { clientName: "Rahul Sharma" });
        console.log("SUCCESS:", result);
    } catch (err) {
        console.error("FAIL:", err.message);
        console.error(err.stack);
    }
})();
