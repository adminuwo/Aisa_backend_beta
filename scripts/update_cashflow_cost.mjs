import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const featureCreditSchema = new mongoose.Schema({
  featureKey: { type: String, required: true, unique: true },
  cost: { type: Number, required: true },
  description: { type: String }
});

const FeatureCredit = mongoose.model('FeatureCredit', featureCreditSchema, 'featurecredits');

(async () => {
  try {
    const uri = process.env.MONGODB_ATLAS_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/AISA';
    console.log('Connecting to:', uri);
    await mongoose.connect(uri);
    
    const cashflow = await FeatureCredit.findOne({ featureKey: 'ai_cashflow' });
    console.log('Current ai_cashflow feature:', cashflow);
    
    if (cashflow) {
      if (cashflow.cost !== 5) {
        await FeatureCredit.updateOne({ featureKey: 'ai_cashflow' }, { $set: { cost: 5 } });
        console.log('Updated ai_cashflow cost to 5');
      } else {
        console.log('ai_cashflow is already 5');
      }
    } else {
      await FeatureCredit.create({ featureKey: 'ai_cashflow', cost: 5, description: 'AISA CashFlow Explorer (Tab Access)' });
      console.log('Inserted ai_cashflow cost as 5');
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
