// Quick test of the new deep search service
import { performDeepSearch } from '../services/deepSearch.service.js';

console.log('Testing new Deep Search (Gemini-powered)...');
const result = await performDeepSearch('latest news about Claude AI models from Anthropic', 'English');
console.log('\n=== RESULT ===');
console.log('Summary length:', result.summary?.length, 'chars');
console.log('Sources found:', result.sources?.length);
console.log('\nFirst 500 chars of summary:');
console.log(result.summary?.substring(0, 500));
console.log('\nSources:');
result.sources?.slice(0, 3).forEach((s, i) => console.log(`[${i+1}] ${s.title} - ${s.url}`));
