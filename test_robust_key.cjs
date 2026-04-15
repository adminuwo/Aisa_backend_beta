const crypto = require('crypto');

let badKeyFromEnv = "-----BEGIN PRIVATE KEY-----  MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgRuSE1CKBvtY/jmsl RBTS4kXxpOyxL1Pf1yD/yINXKfqgCgYIKoZIzj0DAQehRANCAAQ8nqfYblEePU9s 5Wch9kCh9i0esGWA79YRzwxS0nHjG5sMYp4Y1ZLfCv1NeikeP8biV2e8BCdmBdcC BNgs+QFV -----END PRIVATE KEY-----";

function fixAppleKey(key) {
    if (!key) return key;
    let k = key.trim();
    if (k.startsWith('"') && k.endsWith('"')) k = k.substring(1, k.length - 1);
    
    // Attempt standard replacement first
    k = k.replace(/\\n/g, '\n');
    
    // Robust Re-builder:
    // If there are spaces or missing newlines inside the base64 content
    if (k.includes('BEGIN PRIVATE KEY')) {
        let base64Data = k
            .replace(/-----BEGIN PRIVATE KEY-----/g, '')
            .replace(/-----END PRIVATE KEY-----/g, '')
            .replace(/\s+/g, ''); // remove all whitespaces/newlines
        
        // chunk every 64 chars
        let formattedKey = '-----BEGIN PRIVATE KEY-----\n';
        for (let i = 0; i < base64Data.length; i += 64) {
            formattedKey += base64Data.substring(i, i + 64) + '\n';
        }
        formattedKey += '-----END PRIVATE KEY-----';
        return formattedKey;
    }
    
    return k;
}

const fixed = fixAppleKey(badKeyFromEnv);
console.log(fixed);

try {
    const sign = crypto.createSign('SHA256');
    sign.update('123');
    sign.sign(fixed);
    console.log("Success! Robust rebuilt key works.");
} catch (e) {
    console.log("Failed:", e.message);
}
