import cron from 'node-cron';
import KnowledgeSource from '../models/KnowledgeSource.model.js';
import * as ingestionService from './knowledgeIngestion.service.js';
import logger from '../utils/logger.js';

/**
 * Initialize Knowledge Update Scheduler
 * Runs every hour to check for sources that need re-crawling
 */
export const initScheduler = () => {
    logger.info('[Scheduler] Initializing Automatic Knowledge Update System...');

    // Run every hour: 0 * * * *
    // For production "daily" re-crawling at 2AM, we could also use: 0 2 * * *
    // But checking hourly for "due" captures is more robust for diverse frequencies.
    cron.schedule('0 * * * *', async () => {
        logger.info('[Scheduler] Checking for scheduled knowledge updates...');
        try {
            const now = new Date();
            const sourcesToUpdate = await KnowledgeSource.find({
                status: 'active',
                next_crawl_at: { $lte: now }
            });

            logger.info(`[Scheduler] Found ${sourcesToUpdate.length} sources due for update.`);

            for (const source of sourcesToUpdate) {
                await processScheduledUpdate(source);
            }
        } catch (error) {
            logger.error(`[Scheduler] Critical Error: ${error.message}`);
        }
    });

    logger.info('[Scheduler] System active. Hourly checks enabled.');
};

/**
 * Process a single scheduled update
 */
export const processScheduledUpdate = async (source) => {
    try {
        logger.info(`[Scheduler] Starting update for: ${source.url}`);
        
        // Update status to prevent overlapping crawls if one takes a long time
        source.status = 'active'; // Could add 'crawling' state if needed
        await source.save();

        const result = await ingestionService.processUrlIngestion(source.url, source._id, {
            category: source.category || 'GENERAL',
            maxDepth: source.crawl_depth || 2,
            maxPages: source.max_pages || 20
        });

        // Update metadata
        source.last_crawled_at = new Date();
        source.pages_indexed = result.total_pages;
        source.status = 'active';
        source.last_error = null;

        // Calculate next crawl time based on frequency
        const nextCrawl = new Date();
        if (source.update_frequency === 'daily') nextCrawl.setDate(nextCrawl.getDate() + 1);
        else if (source.update_frequency === 'weekly') nextCrawl.setDate(nextCrawl.getDate() + 7);
        else if (source.update_frequency === 'monthly') nextCrawl.setMonth(nextCrawl.getMonth() + 1);
        else nextCrawl.setDate(nextCrawl.getDate() + 1); // Default to daily

        source.next_crawl_at = nextCrawl;
        await source.save();

        logger.info(`[Scheduler] Update completed for ${source.url}. Updated ${result.updated_pages} pages.`);
    } catch (error) {
        logger.error(`[Scheduler] Update failed for ${source.url}: ${error.message}`);
        source.status = 'error';
        source.last_error = error.message;
        await source.save();
    }
};

/**
 * Manual trigger for a source update
 */
export const triggerManualUpdate = async (sourceId) => {
    const source = await KnowledgeSource.findById(sourceId);
    if (!source) throw new Error('Source not found');
    return await processScheduledUpdate(source);
};
