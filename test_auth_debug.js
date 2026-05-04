import { VertexAI } from '@google-cloud/vertexai';
import 'dotenv/config';

async function testAuth() {
    const projectId = process.env.GCP_PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'us-central1';
    const model  = 'gemini-1.5-flash';   // ← exact model your app uses
    
    console.log('━'.repeat(50));
    console.log('Project  :', projectId);
    console.log('Location :', location);
    console.log('Model    :', model);
    console.log('ADC File :', process.env.GOOGLE_APPLICATION_CREDENTIALS || '(using gcloud default)');
    console.log('━'.repeat(50));

    try {
        const vertexAI = new VertexAI({ project: projectId, location: location });
        const gemini = vertexAI.getGenerativeModel({ model });
        
        console.log('\n⏳ Sending test message to Vertex AI...');
        const result = await gemini.generateContent('Say: AISA auth test OK');
        const response = await result.response;
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '(empty)';
        console.log('\n✅ SUCCESS! Response:', text);
    } catch (error) {
        console.error('\n❌ FAILED!');
        console.error('Error Name   :', error.name);
        console.error('Error Message:', error.message?.substring(0, 400));
    }
}

testAuth();
