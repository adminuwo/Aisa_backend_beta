import { Storage } from '@google-cloud/storage';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import * as xlsx from 'xlsx';

import officeparser from 'officeparser';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import SocialAgentWorkspace from '../models/SocialAgentWorkspace.js';
import BrandProfile from '../models/BrandProfile.js';
import ContentCalendar from '../models/ContentCalendar.js';
import CalendarEntry from '../models/CalendarEntry.js';
import PlanUsage from '../models/PlanUsage.js';
import UploadAsset from '../models/UploadAsset.js';

const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
});

const bucketName = process.env.GCS_social_media || process.env.GCS_VIDEO_BUCKET || 'aisageneratedvideo'; 
const bucket = storage.bucket(bucketName);

/**
 * Upload file to GCS
 */
export const uploadToGCS = async (file, folder = 'social-agent') => {
  const fileName = `${folder}/${uuidv4()}-${file.originalname}`;
  const blob = bucket.file(fileName);
  const blobStream = blob.createWriteStream({
    resumable: false,
    contentType: file.mimetype,
  });

  return new Promise((resolve, reject) => {
    blobStream.on('error', (err) => reject(err));
    blobStream.on('finish', async () => {
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
      resolve({ url: publicUrl, name: blob.name });
    });
    blobStream.end(file.buffer);
  });
};

/**
 * Upload buffer to GCS
 */
export const uploadBufferToGCS = async (buffer, originalname, mimetype, folder = 'social-agent') => {
  const fileName = `${folder}/${uuidv4()}-${originalname}`;
  const blob = bucket.file(fileName);
  const blobStream = blob.createWriteStream({
    resumable: false,
    contentType: mimetype,
  });

  return new Promise((resolve, reject) => {
    blobStream.on('error', (err) => reject(err));
    blobStream.on('finish', async () => {
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
      resolve({ url: publicUrl, name: blob.name });
    });
    blobStream.end(buffer);
  });
};

/**
 * Generate Excel Buffer from Calendar Entries
 */
export const generateCalendarExcel = async (entries) => {
  if (!entries || entries.length === 0) return null;

  // Flatten for Excel
  const data = entries.map(item => {
    // Robust Hashtag Handling: handle both strings and arrays
    let hashtagsText = '';
    if (Array.isArray(item.hashtags)) {
      hashtagsText = item.hashtags.join(' ');
    } else if (typeof item.hashtags === 'string') {
      hashtagsText = item.hashtags;
    }

    // Date normalization
    const dateVal = item.scheduledDate || item.date;
    const formattedDate = dateVal ? new Date(dateVal).toLocaleDateString() : 'TBD';

    return {
      "Date": formattedDate,
      "Phase": item.phase || '',
      "Platform": item.platform || '',
      "Format": item.post_type || item.postType || item.format || 'Post',
      "Post Type": item.contentType || 'Post',
      "Heading / Hook": item.hook || item.heading_hook || '',
      "Sub-Heading": item.sub_heading || item.subHeading || '',
      "SHORT CAPTION": item.short_caption || item.captionShort || '',
      "LONG CAPTION": item.long_caption || item.captionLong || '',
      "HASHTAGS": hashtagsText,
      "Slide / Reel Breakdown": item.breakdown || ''
    };
  });

  const worksheet = xlsx.utils.json_to_sheet(data);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "AI Content Calendar");

  // Output as buffer
  const buf = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return buf;
};
export const parseCalendarFile = async (buffer, fileType) => {
  let data = [];
  if (fileType === 'CSV' || fileType === 'XLSX' || fileType === 'XLS') {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    data = xlsx.utils.sheet_to_json(sheet);
  }
  return data;
};

/**
 * Parse Brand Document (PDF/DOCX)
 */
export const parseBrandDocument = async (buffer, mimeType) => {
  let text = '';
  if (mimeType === 'application/pdf' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    // officeparser handles both pdf and docx from buffers
    return await officeparser.parseOfficeAsync(buffer);
  }
  return text;
};

/**
 * Initialize or get workspace Plan Usage
 */
export const getOrInitPlanUsage = async (workspaceId, planType) => {
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  let usage = await PlanUsage.findOne({ workspaceId, billingMonth: currentMonth });

  if (!usage) {
    let limits = { image: 30, carousel: 0, video: 0 };
    if (planType === 'Medium') limits = { image: 15, carousel: 15, video: 0 };
    if (planType === 'High') limits = { image: 10, carousel: 10, video: 10 };

    usage = new PlanUsage({
      workspaceId,
      billingMonth: currentMonth,
      imageLimit: limits.image,
      carouselLimit: limits.carousel,
      videoLimit: limits.video,
      resetAt: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
    });
    await usage.save();
  }
  return usage;
};

let impersonatedStorageClient = null;

const getImpersonatedStorage = () => {
  if (impersonatedStorageClient) return impersonatedStorageClient;

  const targetPrincipal = process.env.VIDEO_SERVICE_ACCOUNT;
  if (!targetPrincipal) return storage;

  try {
    // Rely on the native Storage SDK option for impersonated signing
    impersonatedStorageClient = new Storage({
      projectId: process.env.GCP_PROJECT_ID,
      impersonatedServiceAccount: targetPrincipal
    });
    
    console.log(`[GCS] Successfully initialized impersonated storage API for ${targetPrincipal}`);
    return impersonatedStorageClient;
  } catch (error) {
    console.error(`[GCS] Failed to configure impersonated storage API: ${error.message}`);
    return storage; 
  }
};

/**
 * Generate a signed URL for a file in GCS
 */
export const generateSignedUrl = async (gcsUrl) => {
  try {
    if (!gcsUrl || !gcsUrl.includes('storage.googleapis.com')) return gcsUrl;

    // Strip any existing query parameters from previous signed URLs
    const urlWithoutQuery = gcsUrl.split('?')[0];

    const rawParts = urlWithoutQuery.split('storage.googleapis.com/')[1];
    const bucketInUrl = rawParts.split('/')[0];
    const fileName = rawParts.split('/').slice(1).join('/');

    // Use strictly impersonated storage for pure Signed URL architecture
    const activeStorage = getImpersonatedStorage();

    const file = activeStorage.bucket(bucketInUrl).file(fileName);

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });

    return url;
  } catch (error) {
    console.error("[GCS] Impersonated signed URL generation failed:", error.message);
    // Explicitly throwing the error rather than proxying, enforcing the architecture
    throw new Error(`Impersonated URL Generation Failed: ${error.message}`);
  }
};
