import { Storage } from '@google-cloud/storage';
import logger from '../utils/logger.js';
import path from 'path';

// ---------------------------------------------------------------------------
// Google Cloud Storage — aisa_objects bucket
// Uses Application Default Credentials (ADC).
// On GCP (Cloud Run / App Engine) this is automatic.
// Locally: run `gcloud auth application-default login`
// ---------------------------------------------------------------------------

const BUCKET_NAME = 'aisa_objects';

const storageOptions = {
    projectId: process.env.GCP_PROJECT_ID,
};

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (credPath) {
    storageOptions.keyFilename = credPath;
}

const storage = new Storage(storageOptions);

const bucket = storage.bucket(BUCKET_NAME);

/**
 * Generates a Signed URL for a GCS object.
 * Default expiration is 7 days (maximum for V4 signing).
 *
 * @param {string} gcsPath - Path within the bucket
 * @param {number} [expiresInMinutes=10080] - (7 days default)
 * @returns {Promise<string>}
 */

export const getSignedUrl = async (gcsPath, expiresInMinutes = 360) => {
    try {
        const file = bucket.file(gcsPath);
        const expires = Date.now() + expiresInMinutes * 60 * 1000;
        const targetPrincipal = process.env.VIDEO_SERVICE_ACCOUNT;

        const signOptions = {
            version: 'v4',
            action: 'read',
            expires,
        };

        // If a service account is configured, use it as the issuer for the signed URL.
        // The ADC user (sanskar@uwo24.com) must have Service Account Token Creator on this SA.
        if (targetPrincipal) {
            signOptions.issuer = targetPrincipal;
        }

        const [url] = await file.getSignedUrl(signOptions);
        return url;

    } catch (err) {
        console.error('[GCS SIGNING ERROR]', err.response?.data || err.message);
        logger.error(`[GCS] Failed to generate signed URL: ${err.message}`);
        return `https://storage.googleapis.com/${BUCKET_NAME}/${gcsPath}`;
    }
};

/**
 * Uploads a Buffer to the aisa_objects GCS bucket.
 *
 * @param {Buffer}  fileBuffer  - Raw file data
 * @param {Object}  options
 * @param {string}  options.folder      - Logical folder prefix (e.g. 'generated_images')
 * @param {string}  [options.filename]  - Override the filename (without folder)
 * @param {string}  [options.mimeType]  - MIME type (default: 'image/png')
 * @param {boolean} [options.isPublic]  - Make the object publicly readable (default: true)
 * @param {boolean} [options.useSignedUrl] - If true, returns a signed URL instead of the public one
 *
 * @returns {Promise<{ publicUrl: string, gcsPath: string }>}
 */
export const uploadToGCS = async (fileBuffer, options = {}) => {
    const {
        folder = 'uploads',
        filename = `file_${Date.now()}.png`,
        mimeType = 'image/png',
        isPublic = true,
        useSignedUrl = false,
    } = options;

    const gcsPath = `${folder}/${filename}`;
    const file = bucket.file(gcsPath);

    logger.info(`[GCS] Uploading to gs://${BUCKET_NAME}/${gcsPath} ...`);

    await file.save(fileBuffer, {
        metadata: { contentType: mimeType },
        resumable: false,          // small files — single-shot upload
    });

    if (isPublic && !useSignedUrl) {
        try {
            await file.makePublic();
        } catch (err) {
            if (err.message.includes('uniform bucket-level access')) {
                logger.warn(`[GCS] Uniform bucket-level access enabled. Skipping granular makePublic().`);
            } else {
                logger.error(`[GCS] Failed to make file public: ${err.message}`);
            }
        }
    }

    let resultUrl;
    if (useSignedUrl) {
        resultUrl = await getSignedUrl(gcsPath);
    } else {
        resultUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${gcsPath}`;
    }

    logger.info(`[GCS] Upload success → ${resultUrl}`);

    return { publicUrl: resultUrl, gcsPath };
};

/**
 * Convenience: derive a clean filename from an optional base + timestamp.
 * Example: gcsFilename('aisa_magic_edit') → 'aisa_magic_edit_1712345678901.png'
 */
export const gcsFilename = (base = 'file', ext = 'png') =>
    `${base}_${Date.now()}.${ext}`;

export default { uploadToGCS, gcsFilename, getSignedUrl };
