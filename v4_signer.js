import { GoogleAuth } from 'google-auth-library';
import crypto from 'crypto';

export async function constructV4SignedUrl(bucketName, objectName, expiresMinutes = 10) {
    const targetPrincipal = process.env.VIDEO_SERVICE_ACCOUNT;
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    
    const method = 'GET';
    const expiresSeconds = expiresMinutes * 60;
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStr = timestamp.substring(0, 8);
    
    const host = 'storage.googleapis.com';
    const canonicalUri = /\/\;
    const canonicalQueryString = [
        \X-Goog-Algorithm=GOOG4-RSA-SHA256\,
        \X-Goog-Credential=\\,
        \X-Goog-Date=\\,
        \X-Goog-Expires=\\,
        \X-Goog-SignedHeaders=host\
    ].join('&');
    
    const canonicalHeaders = \host:\System.Management.Automation.Internal.Host.InternalHost\n\;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';
    
    const canonicalRequest = [
        method,
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash
    ].join('\n');
    
    const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
    
    const stringToSign = [
        'GOOG4-RSA-SHA256',
        timestamp,
        \\/auto/storage/goog4_request\,
        canonicalRequestHash
    ].join('\n');
    
    const b64Encoded = Buffer.from(stringToSign).toString('base64');
    
    // IAM signBlob
    const res = await client.request({
        url: \https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/\:signBlob\,
        method: 'POST',
        data: { delegates: [], payload: b64Encoded }
    });
    
    const signature = Buffer.from(res.data.signedBlob, 'base64').toString('hex');
    
    return \https://\System.Management.Automation.Internal.Host.InternalHost\?\&X-Goog-Signature=\\;
}
