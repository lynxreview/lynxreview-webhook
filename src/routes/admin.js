const express = require('express');
const adminAuth = require('../middleware/adminAuth');
const ReviewService = require('../services/reviewService');
const User = require('../models/User');
const Review = require('../models/Review');

const router = express.Router();

// All admin routes require admin authentication
router.use(adminAuth);

// GET /api/admin/clients - List all clients
router.get('/clients', async (req, res) => {
  try {
    const { search, limit = 50, skip = 0 } = req.query;
    const query = {};

    if (search) {
      query.$or = [
        { businessName: new RegExp(search, 'i') },
        { email: new RegExp(search, 'i') },
        { ownerName: new RegExp(search, 'i') }
      ];
    }

    const clients = await User.find(query)
      .select('-passwordHash -googleAccessToken -googleRefreshToken')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await User.countDocuments(query);

    // Add review count for each client
    const clientsWithMetrics = await Promise.all(
      clients.map(async (client) => {
        const reviewCount = await Review.countDocuments({ userId: client._id });
        const obj = client.toObject();
        obj.totalReviews = reviewCount;
        return obj;
      })
    );

    res.json({ success: true, total, clients: clientsWithMetrics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/clients/:id - Get client detail
router.get('/clients/:id', async (req, res) => {
  try {
    const client = await User.findById(req.params.id)
      .select('-passwordHash -googleAccessToken -googleRefreshToken');

    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const reviews = await Review.find({ userId: client._id }).sort({ reviewDate: -1 });
    const metrics = await ReviewService.getMetrics(client._id);

    res.json({ success: true, client, reviews, metrics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/reviews/pending - Get all pending reviews (admin view)
router.get('/reviews/pending', async (req, res) => {
  try {
    const { status = 'pending_response', rating } = req.query;

    const query = {};
    if (status) query.status = status;
    if (rating) query.rating = parseInt(rating);

    // If no specific status, default to pending
    if (!status && !rating) {
      query.status = 'pending_response';
    }

    const reviews = await Review.find(query)
      .sort({ rating: 1, reviewDate: -1 })
      .limit(200);

    // Add business info
    const reviewsWithInfo = await Promise.all(
      reviews.map(async (review) => {
        const user = await User.findById(review.userId).select('businessName email');
        const obj = review.toObject();
        obj.clienteId = user ? user.businessName : 'Unknown';
        obj.clientEmail = user ? user.email : '';
        return obj;
      })
    );

    res.json({ success: true, reviews: reviewsWithInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reviews/:id/approve - Approve a review response
router.post('/reviews/:id/approve', async (req, res) => {
  try {
    const { response } = req.body; // Optional custom response text
    const review = await ReviewService.approveReview(
      req.params.id,
      response,
      req.adminEmail
    );
    res.json({ success: true, review });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reviews/:id/deny - Deny a review response
router.post('/reviews/:id/deny', async (req, res) => {
  try {
    const { reason } = req.body;
    const review = await ReviewService.denyReview(
      req.params.id,
      reason || 'No reason provided',
      req.adminEmail
    );
    res.json({ success: true, review });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reviews/approve-batch - Approve multiple reviews
router.post('/reviews/approve-batch', async (req, res) => {
  try {
    const { reviewIds } = req.body;
    if (!reviewIds || !Array.isArray(reviewIds)) {
      return res.status(400).json({ success: false, error: 'reviewIds array required' });
    }

    const results = await Promise.allSettled(
      reviewIds.map(id => ReviewService.approveReview(id, null, req.adminEmail))
    );

    const approved = results.filter(r => r.status === 'fulfilled').length;
    res.json({ success: true, approved, total: reviewIds.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/metrics - System-wide metrics
router.get('/metrics', async (req, res) => {
  try {
    const totalClients = await User.countDocuments();
    const activeClients = await User.countDocuments({ subscriptionStatus: 'active' });
    const totalReviews = await Review.countDocuments();
    const pendingReviews = await Review.countDocuments({ status: 'pending_response' });
    const publishedReviews = await Review.countDocuments({
      status: { $in: ['published', 'auto_published'] }
    });

    res.json({
      success: true,
      metrics: {
        totalClients,
        activeClients,
        totalReviews,
        pendingReviews,
        publishedReviews
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
