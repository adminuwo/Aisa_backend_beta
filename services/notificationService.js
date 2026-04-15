import userModel from '../models/User.js';
import { notifyUser } from '../utils/socket.js';
import mongoose from 'mongoose';

export const createNotification = async (userId, { title, desc, type = 'info', voice = 'none', id = null }) => {
    try {
        const notification = {
            id: id || `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            title,
            desc,
            type,
            voice,
            time: new Date(),
            isRead: false
        };


        if (mongoose.connection.readyState === 1) {
            await userModel.findByIdAndUpdate(userId, {
                $push: { 
                    notificationsInbox: { 
                        $each: [notification], 
                        $position: 0 // Newest first
                    } 
                }
            });
        }

        // Send real-time update
        notifyUser(userId, notification);


        return notification;
    } catch (error) {
        console.error('Failed to create notification:', error);
        throw error;
    }
};
