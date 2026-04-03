const Review = require('../models/Review');
const User = require('../models/User');
const GoogleService = require('./googleService');
const AIService = require('./aiService');

class ReviewService {
  static async syncReviewsForUser(userId) {
    const user = await User.findById(userId);
    if (!user || !user.googleLinkedAt) {
      return { synced: 0, message: 'Google not linked' };
    }
    try {
      const googleReviews = await GoogleService.getReviews(user);
      let synced = 0;
      for (const gReview of googleReviews) {
        const exists = await Review.findOne({ googleReviewId: gReview.name });
        if (exists) continue;
        const ratingMap = { 'ONE': 1, 'TWO': 2, 'THREE': 3, 'FOUR': 4, 'FIVE': 5 };
        const review = new Review({
          userId: user._id,
          businessName: user.businessName,
          googleReviewId: gReview.name,
          rating: ratingMap[gReview.starRating] || 5,
          reviewText: gReview.comment || '',
          reviewerName: gReview.reviewer?.displayName || 'Cliente',
          reviewDate: new Date(gReview.createTime),
          status: 'unprocessed',
          syncedAt: new Date()
        });
        await review.save();
        synced++;
      }
      user.lastReviewSync = new Date();
      await user.save();
      return { synced, total: googleReviews.length };
    } catch (error) {
      console.error(`Sync error for ${user.email}:`, error.message);
      return { synced: 0, error: error.message };
    }
  }

  static async processUnprocessedReviews() {
    const reviews = await Review.find({ status: 'unprocessed' }).populate('userId');
    let processed = 0;
    for (const review of reviews) {
      try {
        const user = await User.findById(review.userId);
        if (!user) continue;
        const responseText = await AIService.generateResponse(review, user.businessName);
        review.proposedResponse = responseText;
        review.responseGeneratedAt = new Date();
        if (review.rating === 5) {
          review.status = 'auto_published';
          review.publishedResponse = responseText;
          review.publishedAt = new Date();
          try {
            if (user.googleLinkedAt && review.googleReviewId) {
              await GoogleService.replyToReview(user, review.googleReviewId, responseText);
            }
          } catch (publishErr) {
            console.error('Auto-publish to Google failed:', publishErr.message);
          }
        } else {
          review.status = 'pending_response';
        }
        await review.save();
        processed++;
      } catch (error) {
        console.error(`Error processing review ${review._id}:`, error.message);
      }
    }
    return { processed };
  }

  static async approveReview(reviewId, customResponse, adminEmail) {
    const review = await Review.findById(reviewId);
    if (!review) throw new Error('Review not found');
    const finalResponse = customResponse || review.proposedResponse;
    review.publishedResponse = finalResponse;
    review.status = 'published';
    review.approvedBy = adminEmail;
    review.approvedAt = new Date();
    review.publishedAt = new Date();
    try {
      const user = await User.findById(review.userId);
      if (user && user.googleLinkedAt && review.googleReviewId) {
        await GoogleService.replyToReview(user, review.googleReviewId, finalResponse);
      }
    } catch (error) {
      console.error('Error publishing to Google:', error.message);
    }
    await review.save();
    return review;
  }

  static async denyReview(reviewId, reason, adminEmail) {
    const review = await Review.findById(reviewId);
    if (!review) throw new Error('Review not found');
    review.status = 'denied';
    review.deniedReason = reason;
    review.approvedBy = adminEmail;
    review.approvedAt = new Date();
    await review.save();
    return review;
  }

  static async getReviewsForUser(userId, filters = {}) {
    const query = { userId };
    if (filters.status) query.status = filters.status;
    if (filters.rating) query.rating = parseInt(filters.rating);
    const reviews = await Review.find(query).sort({ reviewDate: -1 }).limit(filters.limit || 100);
    return reviews;
  }

  static async getPendingReviews() {
    return Review.find({ status: 'pending_response' }).sort({ rating: 1, reviewDate: -1 }).populate('userId', 'businessName email');
  }

  static async getMetrics(userId) {
    const reviews = await Review.find({ userId });
    const total = reviews.length;
    const avgRating = total > 0 ? (reviews.reduce((sum, r) => sum + r.rating, 0) / total).toFixed(1) : 0;
    const fiveStarCount = reviews.filter(r => r.rating === 5).length;
    const lowRatingCount = reviews.filter(r => r.rating <= 4).length;
    const criticalCount = reviews.filter(r => r.rating <= 2).length;
    const pendingCount = reviews.filter(r => r.status === 'pending_response').length;
    const publishedCount = reviews.filter(r => r.status === 'published' || r.status === 'auto_published').length;
    return { total, avgRating: parseFloat(avgRating), fiveStarCount, lowRatingCount, criticalCount, pendingCount, publishedCount };
  }
}

module.exports = ReviewService;
