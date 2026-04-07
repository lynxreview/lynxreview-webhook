const mongoose = require('mongoose');

const notificationLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  channel: { type: String, enum: ['email', 'whatsapp', 'sms'], required: true },
  type: {
    type: String,
    enum: [
      'new_review', 'critical_alert', 'quick_approve',
      'response_published', 'weekly_digest', 'trial_drip',
      'trial_converted', 'trial_expired'
    ],
    required: true
  },
  metadata: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: ['sent', 'delivered', 'read', 'failed'], default: 'sent' },
  externalId: String,
  sentAt: Date,
  deliveredAt: Date,
  readAt: Date
}, {
  timestamps: true
});

notificationLogSchema.index({ userId: 1, type: 1, sentAt: -1 });

module.exports = mongoose.model('NotificationLog', notificationLogSchema);
