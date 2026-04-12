const fs = require('fs');
const crypto = require('crypto');

let privateKey = `"-----BEGIN PRIVATE KEY-----\\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgRuSE1CKBvtY/jmsl\\nRBTS4kXxpOyxL1Pf1yD/yINXKfqgCgYIKoZIzj0DAQehRANCAAQ8nqfYblEePU9s\\n5Wch9kCh9i0esGWA79YRzwxS0nHjG5sMYp4Y1ZLfCv1NeikeP8biV2e8BCdmBdcC\\nBNgs+QFV\\n-----END PRIVATE KEY-----"`;

privateKey = privateKey.trim();
if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
  privateKey = privateKey.substring(1, privateKey.length - 1);
}

// Convert literal \n to actual newlines
privateKey = privateKey.replace(/\\n/g, '\n');

console.log("Reconstructed Key:\\n" + privateKey);

try {
  const sign = crypto.createSign('SHA256');
  sign.update('test');
  sign.sign(privateKey);
  console.log("Success! Key parsed successfully.");
} catch (e) {
  console.error("Error signing:", e.message);
}
