import 'dotenv/config';
import { getSignedUrl } from './services/gcs.service.js';

console.log('[TEST] Testing signed URL generation...');
console.log('[TEST] VIDEO_SERVICE_ACCOUNT:', process.env.VIDEO_SERVICE_ACCOUNT);

try {
    const url = await getSignedUrl('generated_images/test.png', 10);
    console.log('\n[RESULT] Generated URL:');
    console.log(url.substring(0, 120) + '...');
    
    if (url.includes('X-Goog-Signature')) {
        console.log('\n✅ SUCCESS - Signed URL generated correctly!');
    } else {
        console.log('\n❌ FALLBACK - Returned plain public URL (signing failed silently)');
    }
} catch (err) {
    console.error('\n❌ ERROR:', err.message);
}
