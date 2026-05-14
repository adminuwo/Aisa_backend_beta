import 'dotenv/config';
console.log('--- Environment Check ---');
console.log('APP_NAME:', process.env.APP_NAME);
console.log('GCP_PROJECT_ID:', process.env.GCP_PROJECT_ID);
console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'FOUND (HIDDEN)' : 'NOT FOUND');
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'FOUND (HIDDEN)' : 'NOT FOUND');
console.log('------------------------');
