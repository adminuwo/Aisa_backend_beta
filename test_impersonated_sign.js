import { Storage } from '@google-cloud/storage';

const testSign = async () => {
    try {
        const storage = new Storage({
            projectId: 'ai-mall-484810',
            impersonatedServiceAccount: 'video-signer@ai-mall-484810.iam.gserviceaccount.com'
        });

        const bucket = storage.bucket('aisa_objects');
        const file = bucket.file('generated_images/test.png');

        const [url] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000
        });

        console.log("SUCCESS:", url);
    } catch(err) {
        console.error("ERROR:", err.message);
    }
}
testSign();
