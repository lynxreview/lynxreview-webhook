const express = require('express');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const Admin = require('../models/Admin');
const GoogleService = require('../services/googleService');
const TrialService = require('../services/trialService');
const { encrypt } = require('../utils/encryption');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ============================================
// CLIENT AUTH
// ============================================

// POST /api/auth/register - Create client account (requires verified Stripe payment)
router.post('/register', async (req, res) => {
  try {
    const { email, password, businessName, ownerName, phone, stripeSessionId } = req.body;

    if (!email || !password || !businessName || !ownerName || !phone) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // ─── PAYMENT GATE ────────────────────────────────────────────────────────
    // Require a Stripe session ID — no payment = no account
    if (!stripeSessionId) {
      return res.status(403).json({
        success: false,
        error: 'Debes completar el pago antes de crear tu cuenta. Visita www.lynxreview.com para suscribirte.'
      });
    }

    // Verify the session with Stripe
    let stripeSession;
    try {
      stripeSession = await stripe.checkout.sessions.retrieve(stripeSessionId);
    } catch (stripeErr) {
      return res.status(400).json({
        success: false,
        error: 'Sesión de pago no encontrada. Por favor contacta con soporte.'
      });
    }

    // Session must be paid/complete
    if (stripeSession.payment_status !== 'paid' && stripeSession.status !== 'complete') {
      return res.status(403).json({
        success: false,
        error: 'El pago no se ha completado. Completa el pago en www.lynxreview.com.'
      });
    }

    // Session must not have been used to create another account
    const sessionAlreadyUsed = await User.findOne({ stripeSessionId });
    if (sessionAlreadyUsed) {
      return res.status(400).json({
        success: false,
        error: 'Esta sesión de pago ya fue utilizada. Si tienes problemas, contacta con soporte.'
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Check if email already exists
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, error: 'Este email ya está registrado' });
    }

    // Extract plan from session metadata (set when creating the checkout session)
    const planId = stripeSession.metadata?.planId || 'basic';

    // Create user
    const user = new User({
      email: email.toLowerCase(),
      passwordHash: password, // Will be hashed by pre-save hook
      businessName,
      ownerName,
      phone,
      planId,
      subscriptionStatus: 'active',
      subscriptionStartDate: new Date(),
      stripeSessionId,
      stripeCustomerId: stripeSession.customer || null,
      stripeSubscriptionId: stripeSession.subscription || null,
    });

    await user.save();

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: user.toSafeObject()
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/login - Client login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user._id, role: 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: user.toSafeObject()
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/auth/profile - Get current user profile
router.get('/profile', authMiddleware, async (req, res) => {
  res.json({ success: true, user: req.user.toSafeObject() });
});

// ============================================
// TRIAL
// ============================================

// POST /api/auth/signup-trial - Create free trial (no credit card)
router.post('/signup-trial', async (req, res) => {
  try {
    const { email, password, businessName, ownerName, phone } = req.body;

    if (!email || !password || !businessName || !ownerName) {
      return res.status(400).json({ success: false, error: 'Email, password, business name and owner name are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    // Check if email already exists
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }

    // Create trial via TrialService
    const user = await TrialService.createTrial({
      email: email.toLowerCase(),
      passwordHash: password, // Will be hashed by pre-save hook
      businessName,
      ownerName,
      phone: phone || ''
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, role: 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: user.toSafeObject(),
      trial: {
        endsAt: user.trialEndDate,
        maxResponses: TrialService.MAX_RESPONSES,
        daysLeft: TrialService.TRIAL_DAYS
      }
    });
  } catch (error) {
    console.error('Trial signup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/convert-trial - Convert trial to paid plan
router.post('/convert-trial', authMiddleware, async (req, res) => {
  try {
    const { planId, stripeCustomerId, stripeSubscriptionId, stripeSessionId } = req.body;

    if (!planId || !['basic', 'plus', 'premium'].includes(planId)) {
      return res.status(400).json({ success: false, error: 'Valid plan required (basic, plus, premium)' });
    }

    const user = await TrialService.convertTrial(req.userId, planId, {
      customerId: stripeCustomerId,
      subscriptionId: stripeSubscriptionId,
      sessionId: stripeSessionId
    });

    res.json({
      success: true,
      user: user.toSafeObject(),
      message: `Trial converted to ${planId} plan`
    });
  } catch (error) {
    console.error('Trial conversion error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// GOOGLE OAUTH
// ============================================

// GET /api/auth/google - Start Google OAuth flow (redirects to Google)
// Accepts token via query string (?token=...) because the browser navigates
// directly to this URL and cannot set Authorization headers.
router.get('/google', async (req, res) => {
  try {
    // Accept token from query string OR Authorization header
    let token = req.query.token;
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }
    if (!token) {
      return res.redirect('/dashboard.html?error=no_token');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.redirect('/dashboard.html?error=user_not_found');
    }

    const state = Buffer.from(JSON.stringify({ userId: decoded.userId })).toString('base64');
    const authUrl = GoogleService.getAuthUrl(state);
    res.redirect(authUrl);
  } catch (err) {
    console.error('Google OAuth start error:', err.message);
    res.redirect('/dashboard.html?error=invalid_token');
  }
});

// Also support /api/auth/google/start for frontend button
router.get('/google/start', authMiddleware, (req, res) => {
  const state = Buffer.from(JSON.stringify({ userId: req.userId })).toString('base64');
  const authUrl = GoogleService.getAuthUrl(state);
  res.json({ success: true, authUrl });
});

// GET /api/auth/google/callback - Google OAuth callback
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.redirect('/dashboard.html?error=no_code');
    }

    // Decode state to get userId
    let userId;
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      userId = stateData.userId;
    } catch (e) {
      return res.redirect('/dashboard.html?error=invalid_state');
    }

    // Exchange code for tokens
    const tokens = await GoogleService.exchangeCode(code);

    // Get user's business locations
    let locations = [];
    try {
      locations = await GoogleService.getLocations(tokens.access_token);
    } catch (locErr) {
      console.error('Error fetching locations:', locErr.message);
    }

    // Save tokens and first location (or just tokens if no locations found)
    const locationData = locations.length > 0 ? locations[0] : null;
    await GoogleService.saveTokens(userId, tokens, locationData);

    // Redirect to dashboard with success
    res.redirect('/dashboard.html?google=connected');

  } catch (error) {
    console.error('Google callback error:', error);
    res.redirect('/dashboard.html?error=google_failed');
  }
});

// GET /api/auth/google/status - Check if Google is connected
router.get('/google/status', authMiddleware, async (req, res) => {
  const user = req.user;
  const connected = !!(user.googleLinkedAt && user.googleAccessToken);

  res.json({
    success: true,
    connected,
    businessName: user.googleBusinessName || user.businessName,
    linkedAt: user.googleLinkedAt
  });
});

// ============================================
// ADMIN AUTH
// ============================================

// POST /api/auth/admin/login - Admin login
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (!admin) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const valid = await admin.comparePassword(password);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    admin.lastLoginAt = new Date();
    await admin.save();

    const token = jwt.sign(
      { userId: admin._id, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      admin: { email: admin.email, name: admin.name, role: admin.role }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
