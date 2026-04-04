const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Admin = require('../models/Admin');
const GoogleService = require('../services/googleService');
const { encrypt } = require('../utils/encryption');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, businessName, ownerName, phone, planId, stripeSessionId } = req.body;
    if (!email || !password || !businessName || !ownerName || !phone) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }
    // Verificar pago completado en Stripe antes de crear la cuenta
    if (!stripeSessionId) {
      return res.status(400).json({ success: false, error: 'Se requiere sesion de pago valida' });
    }

    try {
      const stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const stripeSession = await stripeClient.checkout.sessions.retrieve(stripeSessionId);
      if (stripeSession.payment_status !== 'paid') {
        return res.status(402).json({ success: false, error: 'Pago no completado. Completa el pago antes de registrarte.' });
      }
    } catch (stripeErr) {
      console.error('Stripe verify error:', stripeErr.message);
      return res.status(400).json({ success: false, error: 'No se pudo verificar el pago de Stripe.' });
    }
    const user = new User({
      email: email.toLowerCase(),
      passwordHash: password,
      businessName, ownerName, phone,
      planId: planId || 'basic',
      subscriptionStatus: 'active',
      subscriptionStartDate: new Date(),
      stripeSessionId: stripeSessionId || null,
    });
    await user.save();
    const token = jwt.sign({ userId: user._id, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ success: true, token, user: user.toSafeObject() });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const valid = await user.comparePassword(password);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: user.toSafeObject() });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/auth/profile
router.get('/profile', authMiddleware, async (req, res) => {
  res.json({ success: true, user: req.user.toSafeObject() });
});

// GET /auth/google - redirect to Google OAuth
router.get('/google', authMiddleware, (req, res) => {
  const state = Buffer.from(JSON.stringify({ userId: req.userId })).toString('base64');
  const authUrl = GoogleService.getAuthUrl(state);
  res.redirect(authUrl);
});

// GET /api/auth/google/start - for frontend button
router.get('/google/start', authMiddleware, (req, res) => {
  const state = Buffer.from(JSON.stringify({ userId: req.userId })).toString('base64');
  const authUrl = GoogleService.getAuthUrl(state);
  res.json({ success: true, authUrl });
});

// GET /api/auth/google/callback
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect('/dashboard.html?error=no_code');
    let userId;
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      userId = stateData.userId;
    } catch (e) {
      return res.redirect('/dashboard.html?error=invalid_state');
    }
    const tokens = await GoogleService.exchangeCode(code);
    let locations = [];
    try {
      locations = await GoogleService.getLocations(tokens.access_token);
    } catch (locErr) {
      console.error('Error fetching locations:', locErr.message);
    }
    const locationData = locations.length > 0 ? locations[0] : null;
    await GoogleService.saveTokens(userId, tokens, locationData);
    res.redirect('/dashboard.html?google=connected');
  } catch (error) {
    console.error('Google callback error:', error);
    res.redirect('/dashboard.html?error=google_failed');
  }
});

// GET /api/auth/google/status
router.get('/google/status', authMiddleware, async (req, res) => {
  const user = req.user;
  const connected = !!(user.googleLinkedAt && user.googleAccessToken);
  res.json({ success: true, connected, businessName: user.googleBusinessName || user.businessName, linkedAt: user.googleLinkedAt });
});

// POST /api/auth/admin/login
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (!admin) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const valid = await admin.comparePassword(password);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    admin.lastLoginAt = new Date();
    await admin.save();
    const token = jwt.sign({ userId: admin._id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, admin: { email: admin.email, name: admin.name, role: admin.role } });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
