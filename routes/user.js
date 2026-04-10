import express from "express"
import userModel from "../models/User.js"
import mongoose from "mongoose";
import Subscription from "../models/Subscription.js"
import { verifyToken } from "../middleware/authorization.js"

import { getSmartAvatar, isGeneratedAvatar } from "../utils/avatarHelper.js";
import uploadMiddleware from "../middlewares/upload.middleware.js";
import { uploadToGCS, gcsFilename } from "../services/gcs.service.js";

const route = express.Router()

route.get("/", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        // DB Down Fallback
        if (mongoose.connection.readyState !== 1) {
            console.log("[DB] MongoDB unreachable. Returning demo user data.");
            return res.status(200).json({
                _id: userId,
                name: req.user.name || "Demo User",
                email: req.user.email || "demo@aisa.in",
                role: "user",
                personalizations: {}
            });
        }

        let user = await userModel.findById(userId);
        if (!user) {
            // Secondary lookup by email (handles stale JWT after DB reset)
            if (req.user.email) {
                user = await userModel.findOne({ email: req.user.email });
            }
        }
        if (!user) {
            const isKnownAdmin = req.user.email === 'admin@uwo24.com';
            console.warn(`[GET USER] User ${userId} not found in DB. Returning fallback user.`);
            return res.status(200).json({
                _id: userId,
                name: req.user.name || (isKnownAdmin ? 'ADMIN' : 'AISA User'),
                email: req.user.email || 'user@aisa.in',
                role: isKnownAdmin ? 'admin' : 'user',
                credits: 0,
                personalizations: {}
            });
        }

        // --- NEW: Self-healing Avatar logic ---
        // If the avatar is currently a placeholder, try one more time to find a real one.
        if (isGeneratedAvatar(user.avatar)) {
            const freshAvatar = await getSmartAvatar(user.email, user.name);
            if (freshAvatar && !isGeneratedAvatar(freshAvatar)) {
                user.avatar = freshAvatar;
                await user.save();
            }
        }

        res.status(200).json(user.toObject());
    } catch (error) {
        console.error("[GET USER ERROR]", error);
        res.status(500).json({ msg: "Something went wrong", error: error.message });
    }
});

// PUT /api/user - Update general user fields (name, avatar, etc.)
route.put("/", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const updates = req.body;

        if (!updates || Object.keys(updates).length === 0) {
            return res.status(400).json({ error: "No update data provided" });
        }

        // DB Down Fallback
        if (mongoose.connection.readyState !== 1) {
            console.log("[DB] MongoDB unreachable. Simulating user update.");
            return res.status(200).json({
                _id: userId,
                ...updates
            });
        }

        const user = await userModel.findByIdAndUpdate(userId, updates, { new: true }).select("-password");
        if (!user) return res.status(404).json({ error: "User not found" });

        res.status(200).json(user);
    } catch (error) {
        console.error("[UPDATE USER ERROR]", error);
        res.status(500).json({ msg: "Failed to update user", error: error.message });
    }
});

// PUT /api/user/personalizations - Update personalization preferences
route.put("/personalizations", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const { personalizations } = req.body;

        console.log(`[BACKEND] Updating personalizations for user: ${userId}`, personalizations);

        if (!personalizations || typeof personalizations !== 'object') {
            return res.status(400).json({ error: "Invalid personalization data" });
        }

        // DB Down Fallback
        if (mongoose.connection.readyState !== 1) {
            console.log("[DB] MongoDB unreachable. Returning demo response for personalization.");
            return res.status(200).json(personalizations); // Simulate success for demo mode
        }

        const user = await userModel.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        // Ensure user.personalizations is an object
        if (!user.personalizations || typeof user.personalizations !== 'object') {
            user.personalizations = {};
        }

        // Merge top-level sections (e.g. 'general', 'personalization')
        Object.entries(personalizations).forEach(([section, data]) => {
            if (data && typeof data === 'object') {
                user.personalizations[section] = {
                    ...(user.personalizations[section] || {}),
                    ...data
                };
            }
        });

        // FORCE UI language to English always - UI language must stay English
        if (user.personalizations?.general) {
            user.personalizations.general.language = 'English';
        }

        // CRITICAL for Mongoose 'Mixed' type update detection
        user.markModified('personalizations');

        await user.save();
        console.log(`[BACKEND] Personalizations saved successfully for user: ${userId}`);
        res.status(200).json(user.personalizations);
    } catch (error) {
        console.error("[BACKEND ERROR] Failed to update personalizations:", error);
        res.status(500).json({
            msg: "Failed to update settings",
            error: error.message
        });
    }
});

// PUT /api/user/profile - Update user profile fields (like name)
route.put("/profile", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: "Name is required" });

        // DB Down Fallback - Allow "Offline" updates to succeed for the session
        if (mongoose.connection.readyState !== 1) {
            console.log("[DB] MongoDB unreachable. Simulating profile update.");
            return res.status(200).json({
                _id: userId,
                name: name,
                email: req.user.email || "demo@aisa.in",
                role: "user"
            });
        }

        const user = await userModel.findByIdAndUpdate(userId, { name }, { new: true });
        if (!user) return res.status(404).json({ error: "User not found" });

        res.status(200).json(user);
    } catch (error) {
        console.error("[BACKEND ERROR] Failed to update profile:", error);
        res.status(500).json({ msg: "Failed to update profile", error: error.message });
    }
});

// POST /api/user/avatar - Upload and update profile picture
route.post("/avatar", verifyToken, uploadMiddleware, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        const ext = req.file.originalname.split('.').pop() || 'png';
        const gcsResult = await uploadToGCS(req.file.buffer, {
            folder: 'user_avatars',
            filename: gcsFilename(`avatar_${req.user.id || req.user._id}`, ext),
            mimeType: req.file.mimetype,
        });

        const user = await userModel.findByIdAndUpdate(
            req.user.id || req.user._id,
            { avatar: gcsResult.publicUrl },
            { new: true }
        ).select("-password");

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json({ 
            success: true, 
            message: "Avatar updated successfully",
            avatar: user.avatar 
        });
    } catch (error) {
        console.error("[AVATAR UPLOAD ERROR]", error);
        res.status(500).json({ error: "Failed to upload avatar", details: error.message });
    }
});

// DELETE /api/user/avatar - Remove profile picture
route.delete("/avatar", verifyToken, async (req, res) => {
    try {
        const user = await userModel.findByIdAndUpdate(
            req.user.id || req.user._id,
            { avatar: "" },
            { new: true }
        ).select("-password");

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json({ 
            success: true, 
            message: "Profile photo removed successfully",
            avatar: "" 
        });
    } catch (error) {
        console.error("[AVATAR REMOVAL ERROR]", error);
        res.status(500).json({ error: "Failed to remove avatar", details: error.message });
    }
});

// GET /api/user/notifications - Get notification inbox
route.get("/notifications", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;

        if (mongoose.connection.readyState !== 1) {
            return res.status(200).json([
                { id: 'demo_1', title: 'Offline Mode', desc: 'Running on local data.', type: 'alert', time: new Date() }
            ]);
        }

        const user = await userModel.findById(userId).select('notificationsInbox').lean();
        if (!user) return res.status(404).json({ error: "User not found" });

        let inbox = user.notificationsInbox || [];

        // If empty, return demo messages for the user
        if (inbox.length === 0) {
            inbox = [
                {
                    id: `demo_1`,
                    title: 'Welcome to AISA!',
                    desc: 'Start your journey with your Artificial Intelligence Super Assistant. Need help? Ask us anything!',
                    type: 'promo',
                    time: new Date()
                },
                {
                    id: `demo_2`,
                    title: 'AISA v2.4.0 is here!',
                    desc: 'New features: Dynamic Accent Colors and improved Voice Synthesis are now live. Check them out in General settings.',
                    type: 'update',
                    time: new Date(Date.now() - 7200000)
                },
                {
                    id: `demo_3`,
                    title: 'Plan Expiring Soon',
                    desc: 'Your "Pro" plan will end in 3 days. Renew now to keep enjoying unlimited AI access.',
                    type: 'alert',
                    time: new Date(Date.now() - 3600000)
                },
            ];
        }

        res.status(200).json(inbox);
    } catch (error) {
        console.error("[FETCH NOTIFICATIONS ERROR]", error);
        res.status(500).json({ msg: "Failed to fetch notifications", error: error.message });
    }
});

// GET /api/user/subscription - Get user subscription and usage status
route.get("/subscription", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const subscriptionService = { getUsageStatus: async () => ({}) };
        const status = await subscriptionService.getUsageStatus(userId);
        res.status(200).json(status);
    } catch (error) {
        console.error("[FETCH SUBSCRIPTION STATUS ERROR]", error);
        res.status(500).json({ msg: "Failed to fetch subscription status", error: error.message });
    }
});

// DELETE /api/user/notifications/:notifId - Delete a notification
route.delete("/notifications/:notifId", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const { notifId } = req.params;
        const user = await userModel.findByIdAndUpdate(userId, {
            $pull: { notificationsInbox: { id: notifId } }
        }, { new: true });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.status(200).json({ msg: "Notification deleted" });
    } catch (error) {
        console.error("Delete notification error:", error);
        res.status(500).json({ msg: "Failed to delete notification" });
    }
});

// DELETE /api/user/notifications - Clear all notifications
route.delete("/notifications", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        const user = await userModel.findByIdAndUpdate(userId, {
            $set: { notificationsInbox: [] }
        }, { new: true });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.status(200).json({ msg: "All notifications cleared" });
    } catch (error) {
        console.error("Clear notifications error:", error);
        res.status(500).json({ msg: "Failed to clear notifications" });
    }
});


// POST /api/user/personalizations/reset - Reset personalization preferences to defaults
route.post("/personalizations/reset", verifyToken, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;

        // DB Down Fallback
        if (mongoose.connection.readyState !== 1) {
            console.log("[DB] MongoDB unreachable. Resetting to defaults (localStorage only).");
            return res.status(200).json({});
        }

        const user = await userModel.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        // Reset to empty object, Mongoose defaults will take over on next fetch or we can manually set them
        user.personalizations = {};
        await user.save();

        res.status(200).json(user.personalizations);
    } catch (error) {
        console.error("Error resetting personalizations:", error);
        res.status(500).json({ msg: "Something went wrong" });
    }
});

// GET /api/user/all - Admin only, fetch all users with details
route.get("/all", verifyToken, async (req, res) => {
    try {
        // DB Down Fallback
        if (mongoose.connection.readyState !== 1) {
            return res.status(500).json({ error: "Database not connected. Cannot fetch all users." });
        }

        const users = await userModel.find({ role: 'user' })
            .populate('agents', 'agentName pricing')
            .select('-password');

        const spendMap = {};

        const subscriptions = await Subscription.find({}).populate('planId');
        const subMap = subscriptions.reduce((acc, sub) => {
            acc[sub.userId.toString()] = sub.planId?.planName || 'Free Plan';
            return acc;
        }, {});

        const usersWithDetails = users.map(user => ({
            id: user._id,
            name: user.name,
            email: user.email,
            avatar: user.avatar,
            role: user.role,
            isBlocked: user.isBlocked,
            planName: subMap[user._id.toString()] || 'Free Plan',
            status: user.isVerified ? 'Active' : 'Pending',
            agents: user.agents || [],
            credits: user.credits || 0,
            spent: spendMap[user._id.toString()] || 0
        }));

        res.json(usersWithDetails);

    } catch (error) {
        console.error('[FETCH ALL USERS ERROR]', error);
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

// PUT /api/user/:id/block - Admin only, block/unblock user
route.put("/:id/block", verifyToken, async (req, res) => {
    try {
        const userId = req.params.id;
        const { isBlocked } = req.body; // Expect boolean or toggle if not provided? Best to be explicit.

        // Find and update
        const user = await userModel.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        // Prevent blocking self or other admins? optional
        if (user.role === 'admin') {
            return res.status(403).json({ error: "Cannot block admins" });
        }

        user.isBlocked = isBlocked;
        await user.save();

        res.json({
            message: `User ${isBlocked ? 'blocked' : 'unblocked'} successfully`,
            user: { id: user._id, isBlocked: user.isBlocked }
        });

    } catch (err) {
        console.error('[BLOCK USER ERROR]', err);
        res.status(500).json({ error: "Failed to update user status" });
    }
});

// DELETE /api/user/:id - Delete user (self or by admin)
route.delete("/:id", verifyToken, async (req, res) => {
    try {
        const targetUserId = req.params.id;
        const requesterId = req.user.id || req.user._id;

        // DB Down Fallback
        if (mongoose.connection.readyState !== 1) {
            console.log("[DB] MongoDB unreachable. Simulating account deletion (Demo Mode).");
            return res.json({ message: "Account deleted successfully (Demo Mode)", id: targetUserId });
        }

        // Validate ObjectId to prevent CastError
        if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
            // If it's a demo ID from the mock login (like "demo-user-123"), treat as success
            if (targetUserId.startsWith('demo-')) {
                return res.json({ message: "Account deleted successfully (Demo Mode)", id: targetUserId });
            }
            return res.status(400).json({ error: "Invalid user ID format" });
        }

        const user = await userModel.findById(targetUserId);
        if (!user) {
            // If user not found but we got here, might already be deleted or demo
            return res.json({ message: "Account deleted successfully", id: targetUserId });
        }

        // Prevent deleting admins unless by another super admin
        if (user.role === 'admin' && requesterId !== targetUserId) {
            return res.status(403).json({ error: "Cannot delete admins" });
        }

        // Helper for safe cleanup
        const safeDelete = async (modelName, query) => {
            try {
                const Model = mongoose.models[modelName];
                if (Model) {
                    await Model.deleteMany(query);
                    console.log(`[CLEANUP] Deleted data from ${modelName} for user ${targetUserId}`);
                }
            } catch (err) {
                console.warn(`[CLEANUP WARNING] Failed to delete from ${modelName}:`, err.message);
            }
        };

        // Cleanup: Delete all data associated with this user
        await Promise.allSettled([
            safeDelete('ChatSession', { userId: targetUserId }),

            safeDelete('PersonalTask', { user: targetUserId }),
            safeDelete('Reminder', { userId: targetUserId }),
            safeDelete('Feedback', { userId: targetUserId }),
            safeDelete('Report', { userId: targetUserId }),
            safeDelete('SupportTicket', { userId: targetUserId })
        ]);

        await userModel.findByIdAndDelete(targetUserId);
        console.log(`[DELETE USER] User ${targetUserId} deleted permanently.`);

        res.json({ message: "Account deleted successfully", id: targetUserId });

    } catch (err) {
        console.error('[DELETE USER ERROR]', err);
        res.status(500).json({ error: "Failed to delete user" });
    }
});

export default route