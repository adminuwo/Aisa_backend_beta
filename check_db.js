import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);
dotenv.config();

async function check() {
    try {
        const uri = process.env.MONGODB_ATLAS_URI;
        if (!uri) throw new Error('MONGODB_ATLAS_URI not found');
        await mongoose.connect(uri);
        console.log('Connected to DB');
        const count = await mongoose.connection.db.collection('chatsessions').countDocuments();
        console.log('ChatSession Count:', count);
        
        const latest = await mongoose.connection.db.collection('chatsessions').find().sort({ lastModified: -1 }).limit(1).toArray();
        if (latest.length > 0) {
            console.log('Latest Session ID:', latest[0].sessionId);
            console.log('Message Count:', latest[0].messages ? latest[0].messages.length : 0);
            if (latest[0].messages && latest[0].messages.length > 0) {
                const last = latest[0].messages[latest[0].messages.length - 1];
                console.log('Last Message Role:', last.role);
                console.log('Last Message Content Preview:', (last.content || last.text || '').substring(0, 50));
                console.log('Full Last Message:', JSON.stringify(last, null, 2));
            }
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
check();