const express = require('express');
const authMiddleware = require('../middleware/auth');
const ReviewService = require('../services/reviewService');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const reviews = await ReviewService.getReviewsForUser(req.userId, req.query);
    const metrics = await ReviewService.getMetrics(req.userId);
    res.json({ success: true, reviews, metrics });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/metrics', async (req, res) => {
  try {
    const metrics = await ReviewService.getMetrics(req.userId);
    res.json({ success: true, metrics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const result = await ReviewService.syncReviewsForUser(req.userId);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
