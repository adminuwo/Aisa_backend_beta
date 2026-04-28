import axios from 'axios';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

(async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const User = (await import('./models/User.js')).default;
        const user = await User.findOne({});
        if (!user) {
            console.log("No user found");
            process.exit(0);
        }
        
        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'fallback', { expiresIn: '1h' });
        
        console.log("Sending request...");
        const res = await axios.post('http://localhost:8080/api/projects/69ef4ce53338af4d30f818eb/analyze', 
            { rawText: "Test case analysis" },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log("Success:", res.status);
    } catch (err) {
        console.error("FAIL:", err.response?.status, err.response?.data || err.message);
    } finally {
        mongoose.disconnect();
    }
})();
