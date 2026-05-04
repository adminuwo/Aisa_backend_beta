import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function list() {
    try {
        await mongoose.connect(process.env.MONGODB_ATLAS_URI);
        const collections = await mongoose.connection.db.listCollections().toArray();
        console.log('Collections:', collections.map(c => c.name));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
list();
