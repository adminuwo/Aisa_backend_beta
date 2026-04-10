import { VertexAI } from '@google-cloud/vertexai';

async function test() {
  try {
    console.log('Initializing VertexAI with ADC...');
    const vertexAI = new VertexAI({ project: 'ai-mall-484810', location: 'us-central1' });
    const model = vertexAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    
    console.log('Attempting to generate content...');
    const result = await model.generateContent('Say hello world');
    const response = await result.response;
    console.log('Response:', response.candidates[0].content.parts[0].text);
  } catch (error) {
    console.error('ERROR:', error);
  }
}

test();
