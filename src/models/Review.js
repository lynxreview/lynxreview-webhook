const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  businessName: String,
  googleReviewId: { type: String, unique: true, sparse: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  reviewText: { type: String, default: '' },
  reviewerName: { type: String, default: 'Cliente' },
  reviewerEmail: String,
  reviewDate: { type: Date, default: Date.now },
  proposedResponse: String,
  responseGeneratedAt: Date,
  status: {
    type: String,
    enum: ['unprocessed', 'pending_response', 'approved', 'denied', 'published', 'auto_published'],
    default: 'unprocessed'
  },
  approvedBy: String,
  approvedAt: Date,
  deniedReason: String,
  publishedResponse: String,
  publishedAt: Date,
  syncedAt: Date,
}, { timestamps: true });

reviewSchema.index({ userId: 1, createdAt: -1 });
reviewSchema.index({ status: 1 });
reviewSchema.index({ googleReviewId: 1 });

module.exports = mongoose.model('Review', reviewSchema);
