import express from 'express';
import { verifyToken } from '../middleware/authorization.js';
import { createNotification } from '../services/notificationService.js';
import userModel from '../models/User.js';

const router = express.Router();

// GET /api/notifications - Get user notifications
router.get('/', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const user = await userModel.findById(userId).select('notificationsInbox').lean();
        if (!user) return res.status(404).json({ error: "User not found" });

        let inbox = user.notificationsInbox || [];
        
        // If empty, we can return defaults or just empty
        if (inbox.length === 0) {
            inbox = [
                {
                    id: `demo_1`,
                    title: 'Welcome to AISA!',
                    desc: 'Start your journey with your Artificial Intelligence Super Assistant. Need help? Ask us anything!',
                    type: 'promo',
                    time: new Date(),
                    isRead: false
                }
            ];
        }

        res.status(200).json(inbox);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/notifications/test - Trigger a test notification (For Demo/Testing)
router.post('/test', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const { title, desc, type, voice } = req.body;

        const notification = await createNotification(userId, {
            title: title || 'Real-time Update',
            desc: desc || 'This notification was sent via WebSockets!',
            type: type || 'info',
            voice: voice || 'none'
        });

        res.status(201).json({ success: true, notification });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/notifications/:id/read - Mark as read
router.put('/:id/read', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const { id } = req.params;

        await userModel.findOneAndUpdate(
            { _id: userId, "notificationsInbox.id": id },
            { $set: { "notificationsInbox.$.isRead": true } }
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/notifications/:id - Delete a notification
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const { id } = req.params;

        await userModel.findByIdAndUpdate(userId, {
            $pull: { notificationsInbox: { id: id } }
        });

        res.json({ success: true, msg: "Notification deleted" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/notifications - Clear all notifications
router.delete('/', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;

        await userModel.findByIdAndUpdate(userId, {
            $set: { notificationsInbox: [] }
        });

        res.json({ success: true, msg: "All notifications cleared" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
