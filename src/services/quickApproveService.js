/**
 * Quick Approve Service
 * Generates temporary tokens for one-click review approval from email/WhatsApp
 */

const crypto = require('crypto');
const QuickApproveToken = require('../models/QuickApproveToken');
const Review = require('../models/Review');
const GoogleService = require('./googleService');
const User = require('../models/User');

class QuickApproveService {

  static TOKEN_EXPIRY_HOURS = 24;

  // Generate a quick-approve token for a review
  static async generateToken(userId, reviewId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.TOKEN_EXPIRY_HOURS);

    const quickToken = new QuickApproveToken({
      userId,
      reviewId,
      token,
      expiresAt,
      used: false
    });

    await quickToken.save();

    const baseUrl = process.env.FRONTEND_URL || 'https://lynxreview-webhook.onrender.com';
    return {
      token,
      approveUrl: `${baseUrl}/api/quick-approve/${reviewId}?token=${token}&action=approve`,
      editUrl: `${baseUrl}/api/quick-approve/${reviewId}?token=${token}&action=edit`,
      denyUrl: `${baseUrl}/api/quick-approve/${reviewId}?token=${token}&action=deny`
    };
  }

  // Validate token without executing
  static async validateToken(reviewId, token) {
    const quickToken = await QuickApproveToken.findOne({
      reviewId,
      token,
      used: false,
      expiresAt: { $gt: new Date() }
    });

    if (!quickToken) return null;

    const review = await Review.findById(reviewId);
    return { quickToken, review };
  }

  // Execute quick approval
  static async execute(reviewId, token, action, editedResponse = null) {
    // 1. Validate token
    const quickToken = await QuickApproveToken.findOne({
      reviewId,
      token,
      used: false,
      expiresAt: { $gt: new Date() }
    });

    if (!quickToken) {
      throw new Error('Enlace inválido, expirado o ya utilizado');
    }

    // 2. Get review
    const review = await Review.findById(reviewId);
    if (!review) throw new Error('Reseña no encontrada');

    // 3. Execute action
    switch (action) {
      case 'approve': {
        const finalResponse = editedResponse || review.proposedResponse;
        review.publishedResponse = finalResponse;
        review.status = 'published';
        review.approvedBy = 'quick_approve';
        review.approvedAt = new Date();
        review.publishedAt = new Date();

        // Try to publish to Google
        try {
          const user = await User.findById(review.userId);
          if (user && user.googleLinkedAt && review.googleReviewId) {
            await GoogleService.replyToReview(user, review.googleReviewId, finalResponse);
          }
        } catch (err) {
          console.error('Quick approve: Google publish failed:', err.message);
          // Still save locally
        }
        break;
      }

      case 'deny':
        review.status = 'denied';
        review.approvedBy = 'quick_approve';
        review.approvedAt = new Date();
        break;

      default:
        throw new Error('Acción no válida');
    }

    await review.save();

    // 4. Mark token as used
    quickToken.used = true;
    quickToken.usedAt = new Date();
    quickToken.action = action === 'approve' ? 'approved' : 'denied';
    await quickToken.save();

    return review;
  }

  // Cleanup expired tokens
  static async cleanupExpired() {
    const result = await QuickApproveToken.deleteMany({
      $or: [
        { expiresAt: { $lt: new Date() }, used: false },
        { used: true, usedAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
      ]
    });
    return { deleted: result.deletedCount };
  }
}

module.exports = QuickApproveService;
