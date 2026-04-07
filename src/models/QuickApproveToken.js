const mongoose = require('mongoose');

const quickApproveTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', required: true },
  token: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
  usedAt: Date,
  action: { type: String, enum: ['approved', 'edited', 'denied'] },
  createdAt: { type: Date, default: Date.now }
});

// Auto-delete 7 days after expiry
quickApproveTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model('QuickApproveToken', quickApproveTokenSchema);
