import express from "express";
import mongoose from "mongoose";
import Agent from "../models/Agents.js";
import User from "../models/User.js";
import { verifyToken } from "../middleware/authorization.js";

const router = express.Router();

// Get all available agents
router.get("/", verifyToken, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            console.warn("[DB] MongoDB unreachable. Returning mock agents.");
            return res.json([
                { _id: 'agt-1', name: 'AIFLOW', description: 'Streamline your AI workflows.', pricing: 'Free' },
                { _id: 'agt-2', name: 'AIMARKET', description: 'AI-driven marketplace insights.', pricing: 'Free' }
            ]);
        }
        const agents = await Agent.find();
        res.json(agents);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch agents" });
    }
});



// "Buy" an agent
router.post("/buy", verifyToken, async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            console.warn("[DB] MongoDB unreachable. Mocking purchase success.");
            return res.json({ success: true, message: "Agent added to your collection (Mock)" });
        }
        const { agentId } = req.body;
        const userId = req.user.id;

        const user = await User.findById(userId);
        if (!user.agents.includes(agentId)) {
            user.agents.push(agentId);
            await user.save();
        }
        res.json({ success: true, message: "Agent added to your collection" });
    } catch (err) {
        res.status(500).json({ error: "Failed to purchase agent" });
    }
});

export default router;
