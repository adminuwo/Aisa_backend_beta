import { detectRAGNeed, analyzeRAGRequirements } from './services/vertex.service.js';

async function test() {
    const q1 = "Explain diffferent types of courses that student can pursue after 12th?";
    const res1 = await detectRAGNeed(q1);
    console.log("Needs RAG for Q1:", res1);
    
    const res2 = await analyzeRAGRequirements(q1);
    console.log("analyzeRAGRequirements for Q1:", res2);
}
test();
