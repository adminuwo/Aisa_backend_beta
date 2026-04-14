import dotenv from 'dotenv';
dotenv.config();

import { enhancePrompt } from './services/generationPipeline.js';
import * as aiService from './services/ai.service.js';
import mongoose from 'mongoose';

async function test() {
    console.log("Testing aiService.chat with misspelled 'panada' and correct 'panda'");
    
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/aisa');
    console.log("MongoDB Connected");

    const chatResponsePanda = await aiService.chat("generate image of panda", null, { mode: 'IMAGE_GEN' });
    console.log("Chat Response Panda:", chatResponsePanda.text);

    const chatResponsePanada = await aiService.chat("generate image of panada", null, { mode: 'IMAGE_GEN' });
    console.log("Chat Response Panada:", chatResponsePanada.text);

    console.log("\nTesting enhancePrompt with 'generate image of panda'");
    const enhanced1 = await enhancePrompt('generate image of panda', 'image');
    console.log("Enhanced 1:", enhanced1);

    console.log("\nTesting enhancePrompt with 'generate image of panada'");
    const enhanced2 = await enhancePrompt('generate image of panada', 'image');
    console.log("Enhanced 2:", enhanced2);

    process.exit();
}
test();
