import { VertexAI } from '@google-cloud/vertexai';
import 'dotenv/config';

async function testAuth() {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = 'us-central1';
  
  console.log(`Testing Vertex AI Auth...`);
  console.log(`Project ID: ${projectId}`);
  console.log(`Location: ${location}`);

  try {
    const vertexAI = new VertexAI({ project: projectId, location: location });
    const model = vertexAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    console.log('Sending test request...');
    const result = await model.generateContent('Say hello');
    const response = await result.response;
    console.log('✅ Success! Response:', response.text());
  } catch (error) {
    console.error('❌ Auth Test Failed!');
    console.error('Error Name:', error.name);
    console.error('Error Message:', error.message);
    if (error.stack) console.error('Stack Trace:', error.stack);
  }
}

testAuth();
