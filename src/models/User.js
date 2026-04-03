const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  businessName: { type: String, required: true },
  ownerName: { type: String, required: true },
  phone: { type: String, required: true },
  planId: { type: String, enum: ['basic', 'plus', 'premium'], default: 'basic' },
  subscriptionStatus: { type: String, enum: ['active', 'paused', 'cancelled', 'pending'], default: 'pending' },
  subscriptionStartDate: Date,
  stripeCustomerId: String,
  stripeSubscriptionId: String,
  stripeSessionId: String,
  googleAccessToken: String,
  googleRefreshToken: String,
  googlePlaceId: String,
  googleLocationName: String,
  googleAccountName: String,
  googleBusinessName: String,
  googleLinkedAt: Date,
  tokenExpiresAt: Date,
  lastReviewSync: Date,
  emailNotifications: { type: Boolean, default: true },
  criticalAlerts: { type: Boolean, default: true },
}, { timestamps: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('passwordHash')) return next();
  if (!this.passwordHash.startsWith('$2')) {
    this.passwordHash = await bcrypt.hash(this.passwordHash, 10);
  }
  next();
});

userSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.methods.toSafeObject = function() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.googleAccessToken;
  delete obj.googleRefreshToken;
  return obj;
};

userSchema.index({ email: 1 });
userSchema.index({ stripeCustomerId: 1 });

module.exports = mongoose.model('User', userSchema);
