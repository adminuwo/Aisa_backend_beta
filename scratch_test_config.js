import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { initializeConfigs } from './services/configService.js';
import { enhancePrompt } from './services/generationPipeline.js';

async function fixConfig() {
    console.log("Connecting to mongoose...");
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/aisa');
    console.log("MongoDB Connected");

    console.log("Initializing and Synchronizing Configs...");
    await initializeConfigs();

    console.log("\nTesting enhancePrompt with 'generate image of panada'");
    const enhanced = await enhancePrompt('generate image of panada', 'image');
    console.log("Enhanced 3:", enhanced);

    process.exit();
}
fixConfig();
