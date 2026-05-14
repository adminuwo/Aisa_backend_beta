import mongoose from 'mongoose';
import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import connectDB from '../config/db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const injectCredits = async () => {
    try {
        await connectDB();
        
        console.log('--- MEGA CREDIT INJECTION START ---');
        
        const MEGA_CREDITS = 1000000;

        // 1. Update All Users
        const userUpdate = await User.updateMany({}, { $set: { credits: MEGA_CREDITS } });
        console.log(`✅ Updated ${userUpdate.modifiedCount} users with ${MEGA_CREDITS} credits.`);

        // 2. Update All Subscriptions
        const subUpdate = await Subscription.updateMany({}, { $set: { creditsRemaining: MEGA_CREDITS } });
        console.log(`✅ Updated ${subUpdate.modifiedCount} subscriptions.`);

        // 3. Verify Admin
        const admin = await User.findOne({ email: 'admin@uwo24.com' });
        if (admin) {
            console.log(`👑 Admin (${admin.email}) now has: ${admin.credits} credits.`);
        }

        console.log('--- INJECTION COMPLETE ---');
        process.exit(0);
    } catch (err) {
        console.error("Injection failed:", err);
        process.exit(1);
    }
}

injectCredits();
