import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { generate30DayStrategy } from './services/generation.service.js';
import SocialAgentWorkspace from './models/SocialAgentWorkspace.js';
import BrandProfile from './models/BrandProfile.js';

async function test() {
  await mongoose.connect(process.env.MONGODB_ATLAS_URI || 'mongodb://localhost:27017/AISA');
  console.log('Connected to DB:', process.env.MONGODB_ATLAS_URI);
  
  const workspaces = await SocialAgentWorkspace.find().sort({createdAt: -1}).limit(10);
  for (const ws of workspaces) {
    const brand = await BrandProfile.findOne({ workspaceId: ws._id });
    if (brand) {
      console.log('Testing generate30DayStrategy for workspace:', ws._id, '| Brand:', brand.companyName);
      try {
        const res = await generate30DayStrategy(ws._id);
        console.log('Success:', res.status);
      } catch (e) {
        console.error('FAILED WITH 500 EQUIVALENT:');
        console.error(e.message);
        console.error(e.stack);
      }
      process.exit(0);
    }
  }
  
  console.log('No brand found in recent workspaces');
  process.exit(0);
}

test();
