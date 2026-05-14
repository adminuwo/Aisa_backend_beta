import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import connectDB from '../config/db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const resetAdminPassword = async () => {
    try {
        await connectDB();
        
        const email = 'admin@uwo24.com';
        const newPassword = 'Admin@123';
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        
        const result = await User.findOneAndUpdate(
            { email: email },
            { 
                password: hashedPassword,
                role: 'admin',
                isVerified: true
            },
            { new: true }
        );
        
        if (result) {
            console.log(`\n✅ Success! Password for ${email} has been reset.`);
            console.log(`🔑 New Password: ${newPassword}`);
            console.log(`👤 Role: ${result.role}\n`);
        } else {
            console.log(`\n❌ User ${email} not found in database. Creating a new admin user...`);
            
            await User.create({
                name: 'Admin',
                email: email,
                password: hashedPassword,
                role: 'admin',
                isVerified: true,
                credits: 32000
            });
            
            console.log(`✅ Admin account created successfully with password: ${newPassword}\n`);
        }
        
        process.exit(0);
    } catch (err) {
        console.error("Failed to reset admin password:", err);
        process.exit(1);
    }
}

resetAdminPassword();
