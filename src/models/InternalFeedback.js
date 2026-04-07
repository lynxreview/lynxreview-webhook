const mongoose = require('mongoose');

const internalFeedbackSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  businessName: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  feedbackText: { type: String, required: true },
  customerName: String,
  customerEmail: String,
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: false
});

internalFeedbackSchema.index({ userId: 1, createdAt: -1 });
internalFeedbackSchema.index({ rating: 1 });

module.exports = mongoose.model('InternalFeedback', internalFeedbackSchema);
