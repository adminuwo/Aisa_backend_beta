import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { uploadBrandAssets } from './controllers/socialAgent.controller.js';
import SocialAgentWorkspace from './models/SocialAgentWorkspace.js';

async function test() {
  await mongoose.connect(process.env.MONGODB_ATLAS_URI || 'mongodb://localhost:27017/AISA');
  console.log('Connected to DB');
  
  const ws = await SocialAgentWorkspace.findOne().sort({createdAt: -1});
  if (!ws) return console.log('no ws');

  const req = {
    body: {
      workspaceId: ws._id.toString(),
      companyName: 'Test Brand',
      targetIndustry: 'Tech',
      targetAudience: JSON.stringify(['Devs']),
      contentObjective: JSON.stringify(['Sales']),
      campaignMonth: 'May',
      postingFrequency: '3x/week'
    },
    files: {},
    creditMeta: null
  };

  const res = {
    status: (code) => {
      console.log('Status set to:', code);
      return res;
    },
    json: (data) => {
      console.log('Response JSON:', JSON.stringify(data, null, 2));
    }
  };

  try {
    console.log('Calling uploadBrandAssets...');
    await uploadBrandAssets(req, res);
  } catch (e) {
    console.error('Test crashed:', e);
  }
  process.exit(0);
}

test();
