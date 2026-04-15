import express from 'express';
import { Storage } from '@google-cloud/storage';

const router = express.Router();
const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
});

/**
 * Proxy media from GCS to bypass client-side CORS/Auth issues when using ADC locally.
 * Usage: GET /api/media/proxy?url=https://storage.googleapis.com/bucket-name/folder/file.png
 */
router.get('/proxy', async (req, res) => {
  let { url } = req.query;
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }

  // Guard: Detect double-proxied URLs (e.g. the url param is itself a /api/media/proxy?url=... URL)
  // This happens when the frontend wraps an already-proxied URL in another proxy call.
  // Unwrap the inner URL so we proxy the real resource, not ourselves.
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/proxy') && parsed.searchParams.has('url')) {
      const innerUrl = parsed.searchParams.get('url');
      console.warn(`[Media Proxy] Double-proxy detected — unwrapping inner URL: ${innerUrl}`);
      url = innerUrl;
    }
  } catch (_) {
    // url is not a valid absolute URL — leave it as-is and let the handler below deal with it
  }

  try {
    // 1. If it's a GCS URL, use the Storage SDK for authenticated/optimized access
    if (url.includes('storage.googleapis.com')) {
      const rawParts = url.split('storage.googleapis.com/')[1];

      // Safety guard: malformed or missing GCS path
      if (!rawParts) {
        return res.status(400).send('Invalid GCS URL — missing bucket/object path');
      }

      const bucketInUrl = rawParts.split('/')[0];
      const fileName = rawParts.split('/').slice(1).join('/');

      const bucket = storage.bucket(bucketInUrl);
      const file = bucket.file(fileName);

      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).send('File not found in GCS');
      }

      const [metadata] = await file.getMetadata();
      res.setHeader('Content-Type', metadata.contentType || 'application/octet-stream');
      res.setHeader('Content-Length', metadata.size);
      res.setHeader('Cache-Control', 'public, max-age=31536000'); 
      res.setHeader('Access-Control-Allow-Origin', '*'); 
      
      file.createReadStream().pipe(res);
    } 
    // 2. If it's a generic external URL (scraped logo, etc.), use axios to proxy & bypass CORS
    else {
      const axios = (await import('axios')).default;
      const response = await axios.get(url, { responseType: 'stream', timeout: 10000 });
      
      res.setHeader('Content-Type', response.headers['content-type'] || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      response.data.pipe(res);
    }
  } catch (error) {
    console.error('[Media Proxy] Error proxying file:', error.message);
    if (!res.headersSent) {
      res.status(500).send('Failed to proxy media');
    }
  }
});

export default router;
