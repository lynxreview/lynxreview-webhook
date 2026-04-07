const mongoose = require('mongoose');

const monthlyReportSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },

  // Timestamps
  generatedAt: { type: Date, default: Date.now },
  sentAt: Date,

  // Metrics snapshot
  metrics: {
    totalReviews: { type: Number, default: 0 },
    avgRating: { type: Number, default: 0 },
    reputationScore: { type: Number, default: 0 },
    fiveStarCount: { type: Number, default: 0 },
    fourStarCount: { type: Number, default: 0 },
    threeStarCount: { type: Number, default: 0 },
    twoStarCount: { type: Number, default: 0 },
    oneStarCount: { type: Number, default: 0 },
    criticalCount: { type: Number, default: 0 },
    positiveCount: { type: Number, default: 0 },
    negativeCount: { type: Number, default: 0 },
    monthOverMonthChange: { type: Number, default: 0 } // percentage
  },

  // PDF storage
  pdfBuffer: Buffer,
  pdfUrl: String,

  // Top keywords (word frequency analysis)
  topKeywords: [
    {
      word: String,
      frequency: Number
    }
  ],

  // Unresponded low-rating reviews for attention
  criticalReviews: [
    {
      reviewId: mongoose.Schema.Types.ObjectId,
      rating: Number,
      reviewText: String,
      reviewerName: String,
      reviewDate: Date,
      daysWithoutResponse: Number
    }
  ]
}, {
  timestamps: true
});

// Compound index to ensure one report per user per month/year
monthlyReportSchema.index({ userId: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('MonthlyReport', monthlyReportSchema);
