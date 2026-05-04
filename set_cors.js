import { Storage } from '@google-cloud/storage';
const storage = new Storage({ projectId: 'ai-mall-484810' });
async function setCors() {
    try {
        await storage.bucket('aisa_objects').setCorsConfiguration([
            {
                maxAgeSeconds: 3600,
                method: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
                origin: ['*'],
                responseHeader: ['*'],
            },
        ]);
        console.log('CORS policy updated successfully');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
setCors();
