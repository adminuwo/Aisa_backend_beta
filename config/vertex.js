import { GoogleGenerativeAI } from '@google/generative-ai';
import { VertexAI, HarmCategory, HarmBlockThreshold } from '@google-cloud/vertexai';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dual-mode initialization: Try Gemini API Key first, fallback to Vertex AI
const apiKey = process.env.GEMINI_API_KEY;
const projectId = process.env.GCP_PROJECT_ID;
const location = process.env.GCP_LOCATION || 'us-central1'; // Defaulting to us-central1 for better model availability
const keyFilePath = path.join(__dirname, '../google_cloud_credentials.json');

let genAI;
let vertexAI;
let useVertexAI = false;

// Try Gemini API Key first (simpler, more portable)
if (apiKey) {
  console.log(`✅ Gemini AI initializing with API Key`);
  genAI = new GoogleGenerativeAI(apiKey);
  useVertexAI = false;
}
// Fallback to Vertex AI with service account / ADC
else if (projectId) {
  console.log(`✅ Vertex AI initializing with project: ${projectId}, location: ${location}`);
  try {
    if (existsSync(keyFilePath)) {
      // Service account JSON file exists - use it
      vertexAI = new VertexAI({
        project: projectId,
        location: location,
        googleAuthOptions: { keyFilename: keyFilePath }
      });
      console.log('✅ Vertex AI initialized with service account keyfile');
    } else {
      // Use ADC (Application Default Credentials - gcloud auth application-default login)
      vertexAI = new VertexAI({ project: projectId, location: location });
      console.log('✅ Vertex AI initialized with Application Default Credentials (ADC)');
    }
    useVertexAI = true;
  } catch (e) {
    console.error('❌ Vertex AI initialization failed:', e.message);
    useVertexAI = false;
  }
} else {
  console.error("❌ Error: Neither GEMINI_API_KEY nor GCP_PROJECT_ID found in environment variables.");
}

import { getConfig, getFullSystemInstruction } from '../services/configService.js';

// Model name - gemini-2.0-flash is latest stable and widely available on Vertex AI
export const modelName = "gemini-2.0-flash";

/**
 * Dynamic System Instruction Getter
 */
export const getDynamicSystemInstruction = () => {
  try {
    return getFullSystemInstruction();
  } catch (e) {
    console.warn('⚠️ Could not fetch system instructions from ConfigService:', e.message);
    return '';
  }
};

// Removed static systemInstructionText to avoid race conditions

// VertexAI-compatible safety settings (from @google-cloud/vertexai package)
const vertexSafetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
];

// Create generative model - with null safety checks
export const generativeModel = (() => {
  try {
    if (useVertexAI && vertexAI) {
      return vertexAI.getGenerativeModel({
        model: modelName,
        safetySettings: vertexSafetySettings,
        generationConfig: { maxOutputTokens: 8192 },
        // Instruction will be applied dynamically in services for better flexibility
      });
    } else if (genAI) {
      return genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { maxOutputTokens: 8192 },
      });
    } else {
      console.error('❌ CRITICAL: No AI provider available for generativeModel!');
      return null;
    }
  } catch (e) {
    console.error('❌ generativeModel creation failed:', e.message);
    return null;
  }
})();

// Export genAI instance for multi-model support in chatRoutes
export const genAIInstance = (() => {
  if (useVertexAI && vertexAI) {
    return {
      getGenerativeModel: (options) => vertexAI.getGenerativeModel(options)
    };
  }
  return genAI || null;
})();

// Export raw vertexAI instance so services can create fresh models
export { vertexAI };

// Export the flag so services know which mode is active
export { useVertexAI };
