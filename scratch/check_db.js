import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: 'AISA/Aisa_backend_beta/.env' });

const userSchema = new mongoose.Schema({
    name: String,
    email: String,
});

const User = mongoose.model('User', userSchema);

async function checkUser() {
    try {
        await mongoose.connect(process.env.MONGODB_ATLAS_URI);
        console.log('Connected to AISA DB');
        
        const admin = await User.findOne({ email: 'admin@uwo24.com' });
        if (admin) {
            console.log('Admin User found in AISA:');
            console.log(JSON.stringify(admin, null, 2));
        } else {
            console.log('Admin User NOT found in AISA');
        }

        const bhumika = await User.findOne({ email: 'bhumika@uwo24.com' });
        if (bhumika) {
            console.log('Bhumika User found in AISA:');
            console.log(JSON.stringify(bhumika, null, 2));
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

checkUser();
