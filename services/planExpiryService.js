import cron from 'node-cron';
import Subscription from '../models/Subscription.js';
import { createNotification } from './notificationService.js';
import logger from '../utils/logger.js';

export const startPlanExpiryService = () => {
    logger.info('[PlanExpiryService] Initializing Plan Expiry Notification System...');

    // Run every day at midnight (00:00)
    cron.schedule('0 0 * * *', async () => {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // 1. Check for plans expiring in exactly 3 days
            const threeDaysFromNow = new Date(today);
            threeDaysFromNow.setDate(today.getDate() + 3);
            const threeDaysEnd = new Date(threeDaysFromNow);
            threeDaysEnd.setDate(threeDaysEnd.getDate() + 1);

            const expiringIn3Days = await Subscription.find({
                subscriptionStatus: 'active',
                renewalDate: { $gte: threeDaysFromNow, $lt: threeDaysEnd }
            }).populate('planId');

            for (const sub of expiringIn3Days) {
                await createNotification(sub.userId, {
                    title: 'Plan Expiring Soon',
                    desc: `Your "${sub.planId?.planName || 'Pro'}" plan will end in 3 days. Renew now to keep enjoying unlimited AI access.`,
                    type: 'alert'
                });
            }

            // 2. Check for plans expiring tomorrow
            const tomorrow = new Date(today);
            tomorrow.setDate(today.getDate() + 1);
            const tomorrowEnd = new Date(tomorrow);
            tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

            const expiringTomorrow = await Subscription.find({
                subscriptionStatus: 'active',
                renewalDate: { $gte: tomorrow, $lt: tomorrowEnd }
            }).populate('planId');

            for (const sub of expiringTomorrow) {
                await createNotification(sub.userId, {
                    title: 'Plan Expiring Tomorrow',
                    desc: `Time is running out! Your plan expires tomorrow. Renew now to avoid any interruption.`,
                    type: 'alert'
                });
            }

            // 3. Mark plans as expired if the renewal date has passed
            const expiredPlans = await Subscription.find({
                subscriptionStatus: 'active',
                renewalDate: { $lt: today }
            });

            for (const sub of expiredPlans) {
                sub.subscriptionStatus = 'expired';
                await sub.save();
                
                await createNotification(sub.userId, {
                    title: 'Plan Expired',
                    desc: 'Your subscription has ended. Access to premium features is now restricted. Renew to continue.',
                    type: 'error'
                });
            }

            logger.info(`[PlanExpiryService] Daily check completed. Notified ${expiringIn3Days.length + expiringTomorrow.length} users.`);
        } catch (error) {
            logger.error(`[PlanExpiryService] Error during daily check: ${error.message}`);
        }
    });
};
