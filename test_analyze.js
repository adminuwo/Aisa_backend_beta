import { analyzeCaseDetails } from './services/legalIntelligence.service.js';

async function run() {
    console.log("Starting analysis...");
    const rawText = "Rajesh Gupta lent ₹5,00,000 to Amit Traders for business purposes on 15 June 2023, with a repayment deadline of 15 December 2023. Amit Traders failed to repay the amount, and are now not responding to calls.";
    
    try {
        const result = await analyzeCaseDetails(rawText, {
            clientName: "Rajesh Gupta",
            opponentName: "Amit Traders",
            caseType: "Debt Recovery"
        });
        console.log("Result:", JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("Error:", e);
    }
}
run();
