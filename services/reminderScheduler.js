import cron from 'node-cron';
import Reminder from '../models/Reminder.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';
// Add email service if later needed for email reminders, for now let's just log or push notification
// import * as emailService from './emailService.js';

export const initReminderScheduler = () => {
    logger.info('[ReminderScheduler] Initializing Multi Schedule Reminder System...');

    // Runs every minute
    cron.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            // Start of current minute
            const currentMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
            // End of current minute
            const nextMinute = new Date(currentMinute.getTime() + 60000);

            // Find all pending, active reminders whose datetime falls exactly in this minute
            const dueReminders = await Reminder.find({
                isActive: true,
                status: 'pending',
                datetime: { $gte: currentMinute, $lt: nextMinute }
            });

            if (dueReminders.length > 0) {
                logger.info(`[ReminderScheduler] Found ${dueReminders.length} due reminders.`);
            }

            for (const reminder of dueReminders) {
                await processDueReminder(reminder, now);
            }
        } catch (error) {
            logger.error(`[ReminderScheduler] Error running cron: ${error.message}`);
        }
    });
};

const processDueReminder = async (reminder, now) => {
    try {
        logger.info(`[ReminderScheduler] Processing reminder: ${reminder.title} - ${reminder._id}`);
        // 1. Send Notification based on type
        if (reminder.notificationType === 'in-app' || reminder.notificationType === 'both') {
            const { createNotification } = await import('./notificationService.js');
            await createNotification(reminder.userId, {
                id: `reminder_${reminder._id}`,
                title: `Reminder: ${reminder.title}`,
                desc: reminder.description || 'Time to check your scheduled task.',
                type: 'alert',
                voice: reminder.voice || 'none'
            });

            logger.info(`[ReminderScheduler] Real-time notification sent to user ${reminder.userId}`);
        }

        
        // Handle Repeat Logic
        if (reminder.repeat === 'none') {
            reminder.status = 'completed';
        } else {
            // Calculate next datetime
            const nextTime = new Date(reminder.datetime);
            
            if (reminder.repeat === 'daily') {
                nextTime.setDate(nextTime.getDate() + 1);
            } else if (reminder.repeat === 'weekly') {
                nextTime.setDate(nextTime.getDate() + 7);
            } else if (reminder.repeat === 'monthly') {
                nextTime.setMonth(nextTime.getMonth() + 1);
            } else if (reminder.repeat === 'custom') {
                // Find next day strictly greater than today based on customDays
                const currentDay = nextTime.getDay(); // 0-6
                let daysToAdd = 1;
                let found = false;
                
                if (reminder.customDays && reminder.customDays.length > 0) {
                    for (let i = 1; i <= 7; i++) {
                        const nextDayToCheck = (currentDay + i) % 7;
                        if (reminder.customDays.includes(nextDayToCheck)) {
                            daysToAdd = i;
                            found = true;
                            break;
                        }
                    }
                }
                nextTime.setDate(nextTime.getDate() + daysToAdd);
            }
            
            reminder.datetime = nextTime;
        }

        await reminder.save();
    } catch (error) {
        logger.error(`[ReminderScheduler] Error processing reminder ${reminder._id}: ${error.message}`);
    }
};
