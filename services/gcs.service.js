import { Storage } from '@google-cloud/storage';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import logger from '../utils/logger.js';
import path from 'path';

// ---------------------------------------------------------------------------
// Google Cloud Storage — aisa_objects bucket
// Impersonated Signed URL Architecture
// ---------------------------------------------------------------------------

const BUCKET_NAME = 'aisa_objects';
const TARGET_PRINCIPAL = process.env.VIDEO_SERVICE_ACCOUNT || 'video-signer@ai-mall-484810.iam.gserviceaccount.com';

let storage;
let bucket;

try {
    process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN = 'googleapis.com';
    storage = new Storage({ 
        projectId: process.env.GCP_PROJECT_ID || 'ai-mall-484810',
        universe_domain: 'googleapis.com',
        // Enable impersonated signing
        impersonatedServiceAccount: TARGET_PRINCIPAL 
    });
    
    bucket = storage.bucket(BUCKET_NAME);
    logger.info(`[GCS] Storage initialized with Impersonation for ${TARGET_PRINCIPAL}`);
} catch (error) {
    logger.error(`[GCS] Failed to initialize storage: ${error.message}`);
    // Fallback if impersonation fails
    storage = new Storage({ projectId: process.env.GCP_PROJECT_ID || 'ai-mall-484810' });
    bucket = storage.bucket(BUCKET_NAME);
}

/**
 * Generates an Impersonated Signed URL for a GCS object.
 * Default expiration is 7 days (maximum for V4 signing).
 *
 * @param {string} gcsPath - Path within the bucket
 * @param {number} [expiresInMinutes=10080] - (7 days default)
 * @returns {Promise<string>}
 */
export const getSignedUrl = async (gcsPath, expiresInMinutes = 10080) => {
    try {
        const file = bucket.file(gcsPath);
        const expires = Date.now() + expiresInMinutes * 60 * 1000;

        const [url] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires
        });
        return url;

    } catch (err) {
        console.error('[GCS SIGNING ERROR]', err.response?.data || err.message);
        logger.error(`[GCS] Failed to generate signed URL: ${err.message}`);
        throw err;
    }
};

/**
 * Uploads a Buffer to the aisa_objects GCS bucket and ALWAYS returns a signed URL.
 * Internal Proxy URLs have been fully removed.
 *
 * @param {Buffer}  fileBuffer  - Raw file data
 * @param {Object}  options
 * @param {string}  options.folder      - Logical folder prefix (e.g. 'generated_images')
 * @param {string}  [options.filename]  - Override the filename (without folder)
 * @param {string}  [options.mimeType]  - MIME type (default: 'image/png')
 *
 * @returns {Promise<{ publicUrl: string, gcsPath: string }>}
 */
export const uploadToGCS = async (fileBuffer, options = {}) => {
    const {
        folder = 'uploads',
        filename = `file_${Date.now()}.png`,
        mimeType = 'image/png',
    } = options;

    const gcsPath = `${folder}/${filename}`;
    const file = bucket.file(gcsPath);

    logger.info(`[GCS] Uploading to gs://${BUCKET_NAME}/${gcsPath} ...`);

    await file.save(fileBuffer, {
        metadata: { contentType: mimeType },
        resumable: false, // small files — single-shot upload
    });

    // Primary Architecture enforces Signed URL generation.
    const resultUrl = await getSignedUrl(gcsPath);

    logger.info(`[GCS] Upload success, Signed URL generated.`);

    return { publicUrl: resultUrl, gcsPath };
};

export const gcsFilename = (base = 'file', ext = 'png') =>
    `${base}_${Date.now()}.${ext}`;

export default { uploadToGCS, gcsFilename, getSignedUrl };
