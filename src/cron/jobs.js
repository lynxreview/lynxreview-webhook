const cron = require('node-cron');
const User = require('../models/User');
const ReviewService = require('../services/reviewService');

function startCronJobs() {
  console.log('Starting cron jobs...');

  // ============================================
  // SYNC REVIEWS - Every hour at :00
  // ============================================
  cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Syncing reviews from Google...');
    try {
      const users = await User.find({
        googleLinkedAt: { $exists: true, $ne: null },
        subscriptionStatus: 'active'
      });

      let totalSynced = 0;
      for (const user of users) {
        try {
          const result = await ReviewService.syncReviewsForUser(user._id);
          totalSynced += result.synced || 0;
          if (result.synced > 0) {
            console.log(`  Synced ${result.synced} reviews for ${user.businessName}`);
          }
        } catch (err) {
          console.error(`  Error syncing ${user.email}:`, err.message);
        }
      }

      console.log(`[CRON] Review sync complete. Total synced: ${totalSynced}`);
    } catch (error) {
      console.error('[CRON] Critical error in review sync:', error.message);
    }
  });

  // ============================================
  // PROCESS AI RESPONSES - Every 30 minutes
  // ============================================
  cron.schedule('*/30 * * * *', async () => {
    console.log('[CRON] Processing unprocessed reviews...');
    try {
      const result = await ReviewService.processUnprocessedReviews();
      if (result.processed > 0) {
        console.log(`[CRON] Processed ${result.processed} reviews`);
      }
    } catch (error) {
      console.error('[CRON] Error processing reviews:', error.message);
    }
  });

  // ============================================
  // INITIAL SYNC ON STARTUP (after 30 seconds)
  // ============================================
  setTimeout(async () => {
    console.log('[STARTUP] Running initial review processing...');
    try {
      const result = await ReviewService.processUnprocessedReviews();
      console.log(`[STARTUP] Processed ${result.processed} pending reviews`);
    } catch (error) {
      console.error('[STARTUP] Error:', error.message);
    }
  }, 30000);

  console.log('Cron jobs started:');
  console.log('  - Review sync: every hour');
  console.log('  - AI processing: every 30 minutes');
}

module.exports = startCronJobs;
