require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const QRCode = require('qrcode');
const connectDB = require('./src/config/database');
const Admin = require('./src/models/Admin');

// Import routes
const authRoutes = require('./src/routes/auth');
const clientRoutes = require('./src/routes/client');
const adminRoutes = require('./src/routes/admin');
const webhookRoutes = require('./src/routes/webhooks');
const paymentRoutes = require('./src/routes/payment');
const quickApproveRoutes = require('./src/routes/quickApprove');

// Import cron
const startCronJobs = require('./src/cron/jobs');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================

// Security headers (relaxed CSP for inline scripts in our HTML)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
  origin: [
    'https://lynxreview.com',
    'https://www.lynxreview.com',
    'https://lynxreview-webhook.onrender.com',
    'http://localhost:3000'
  ],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Auth rate limiting (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' }
});

// Cookie parser
app.use(cookieParser());

// Body parsers (JSON and URL-encoded form data)
// Exception: Stripe webhooks use raw body for signature verification
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});
// URL-encoded form parser for quick-approve forms and other form submissions
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// STATIC FILES
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API ROUTES
// ============================================

// Auth routes (login, register, Google OAuth)
app.use('/api/auth', authRoutes);

// Also mount Google OAuth start at /auth/google for backward compat — preserve token
app.get('/auth/google', (req, res) => {
  const qs = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
  res.redirect(`/api/auth/google${qs}`);
});

// Admin routes (clients, metrics) - under /api/admin
app.use('/api/admin', adminRoutes);

// Admin review routes MUST be registered BEFORE clientRoutes to avoid
// clientRoutes intercepting /api/reviews/pending with user auth middleware
const adminAuth = require('./src/middleware/adminAuth');
const ReviewService = require('./src/services/reviewService');
const User = require('./src/models/User');
const Review = require('./src/models/Review');

// GET /api/reviews/pending - Admin gets pending reviews
app.get('/api/reviews/pending', adminAuth, async (req, res) => {
  try {
    const query = { status: 'pending_response' };
    if (req.query.rating) query.rating = parseInt(req.query.rating);
    if (req.query.status) query.status = req.query.status;

    const reviews = await Review.find(query).sort({ rating: 1, reviewDate: -1 }).limit(200);
    const reviewsWithInfo = await Promise.all(
      reviews.map(async (review) => {
        const user = await User.findById(review.userId).select('businessName email');
        const obj = review.toObject();
        obj.clienteId = user ? user.businessName : 'Unknown';
        return obj;
      })
    );
    res.json({ success: true, reviews: reviewsWithInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reviews/:id/approve - Admin approves
app.post('/api/reviews/:id/approve', adminAuth, async (req, res) => {
  try {
    const review = await ReviewService.approveReview(req.params.id, req.body.response, req.adminEmail);
    res.json({ success: true, review });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/reviews/:id/deny - Admin denies
app.post('/api/reviews/:id/deny', adminAuth, async (req, res) => {
  try {
    const review = await ReviewService.denyReview(req.params.id, req.body.reason, req.adminEmail);
    res.json({ success: true, review });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Client routes (reviews, metrics) - requires client auth (after admin routes)
app.use('/api/reviews', clientRoutes);

// Quick Approve routes - PUBLIC (no JWT, uses token-based auth)
app.use('/api/quick-approve', quickApproveRoutes);

// Payment routes (Stripe checkout)
app.use('/api/payment', paymentRoutes);

// Client profile & QR — endpoints called by dashboard.html
const authMiddleware = require('./src/middleware/auth');

app.get('/api/client/profile', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({
    success: true,
    businessName: u.businessName || '',
    ownerName: u.ownerName || '',
    email: u.email || '',
    plan: u.planId || 'basic',
    google: u.googleLinkedAt ? '✅ Conectado' : null,
    subscriptionStatus: u.subscriptionStatus || 'active',
  });
});

app.get('/api/client/qr', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    const baseUrl = process.env.FRONTEND_URL || 'https://lynxreview-webhook.onrender.com';
    const reviewUrl = `${baseUrl}/review/${u.businessSlug || u._id}`;
    const qrUrl = u.qrUrl || reviewUrl;

    // Generate QR code as base64 data URL
    const qrCodeUrl = await QRCode.toDataURL(qrUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#0f3460', light: '#ffffff' }
    });

    res.json({ success: true, qrUrl, reviewUrl, qrCodeUrl });
  } catch (error) {
    console.error('QR generation error:', error.message);
    res.status(500).json({ success: false, error: 'Error generating QR code' });
  }
});

// ============================================
// CLIENT PREFERENCES
// ============================================

const TrialService = require('./src/services/trialService');

// POST /api/client/preferences/response - Update AI response preferences
app.post('/api/client/preferences/response', authMiddleware, async (req, res) => {
  try {
    const { tone, brandKeywords, forbiddenPhrases, businessContext, signatureName, autoApprove5Stars, language } = req.body;
    const user = req.user;

    if (tone && !['formal', 'friendly', 'professional', 'fun'].includes(tone)) {
      return res.status(400).json({ success: false, error: 'Invalid tone. Use: formal, friendly, professional, fun' });
    }

    if (tone) user.responsePreferences.tone = tone;
    if (brandKeywords !== undefined) user.responsePreferences.brandKeywords = brandKeywords;
    if (forbiddenPhrases !== undefined) user.responsePreferences.forbiddenPhrases = forbiddenPhrases;
    if (businessContext !== undefined) user.responsePreferences.businessContext = businessContext;
    if (signatureName !== undefined) user.responsePreferences.signatureName = signatureName;
    if (autoApprove5Stars !== undefined) user.responsePreferences.autoApprove5Stars = autoApprove5Stars;
    if (language !== undefined) user.responsePreferences.language = language;

    await user.save();
    res.json({ success: true, responsePreferences: user.responsePreferences });
  } catch (error) {
    console.error('Update response preferences error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/client/preferences/response - Get current AI response preferences
app.get('/api/client/preferences/response', authMiddleware, (req, res) => {
  res.json({ success: true, responsePreferences: req.user.responsePreferences || {} });
});

// POST /api/client/preferences/notifications - Update notification preferences
app.post('/api/client/preferences/notifications', authMiddleware, async (req, res) => {
  try {
    const { channels, whatsappNumber, quickApproveEnabled, weeklyDigest, digestDay } = req.body;
    const user = req.user;

    if (channels) {
      const validChannels = channels.filter(c => ['email', 'whatsapp'].includes(c));
      user.notificationPreferences.channels = validChannels.length > 0 ? validChannels : ['email'];
    }
    if (whatsappNumber !== undefined) user.notificationPreferences.whatsappNumber = whatsappNumber;
    if (quickApproveEnabled !== undefined) user.notificationPreferences.quickApproveEnabled = quickApproveEnabled;
    if (weeklyDigest !== undefined) user.notificationPreferences.weeklyDigest = weeklyDigest;
    if (digestDay !== undefined) user.notificationPreferences.digestDay = digestDay;

    await user.save();
    res.json({ success: true, notificationPreferences: user.notificationPreferences });
  } catch (error) {
    console.error('Update notification preferences error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/client/preferences/notifications - Get current notification preferences
app.get('/api/client/preferences/notifications', authMiddleware, (req, res) => {
  res.json({ success: true, notificationPreferences: req.user.notificationPreferences || {} });
});

// GET /api/client/onboarding-status - Get trial/onboarding progress
app.get('/api/client/onboarding-status', authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const status = {
      plan: user.planId,
      isTrial: user.planId === 'trial',
      googleConnected: !!(user.googleLinkedAt),
      preferencesConfigured: !!(user.responsePreferences?.tone && user.responsePreferences?.signatureName),
      notificationsConfigured: (user.notificationPreferences?.channels?.length || 0) > 0
    };

    if (user.planId === 'trial') {
      const trialCheck = TrialService.canGenerateResponse(user);
      const daysLeft = Math.max(0, Math.ceil(
        (user.trialEndDate - Date.now()) / (1000 * 60 * 60 * 24)
      ));

      status.trial = {
        status: user.trialStatus,
        startDate: user.trialStartDate,
        endDate: user.trialEndDate,
        daysLeft,
        responsesUsed: user.trialResponsesUsed || 0,
        maxResponses: TrialService.MAX_RESPONSES,
        responsesRemaining: trialCheck.remaining || 0,
        canPublishToGoogle: false
      };
    }

    // Calculate onboarding completion
    const steps = [
      { name: 'account', done: true },
      { name: 'google', done: status.googleConnected },
      { name: 'preferences', done: status.preferencesConfigured },
      { name: 'notifications', done: status.notificationsConfigured }
    ];
    status.onboardingProgress = {
      steps,
      completed: steps.filter(s => s.done).length,
      total: steps.length,
      percentage: Math.round((steps.filter(s => s.done).length / steps.length) * 100)
    };

    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Onboarding status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Webhook routes
app.use('/webhooks', webhookRoutes);

// ============================================
// PAGE ROUTES (serve HTML pages)
// ============================================

// GET /checkout?plan=basico|plus|premium
// Links from lynxreview.com/store redirect here → forward to register page
app.get('/checkout', (req, res) => {
  const planMap = { basico: 'basic', plus: 'plus', premium: 'premium' };
  const plan = planMap[req.query.plan] || req.query.plan || 'plus';
  res.redirect(302, `/register.html?plan=${plan}`);
});

// Root -> marketing landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Registration page
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Client dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Admin login
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Admin dashboard
app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============================================
// QR REVIEW LANDING PAGE & API
// ============================================

const InternalFeedback = require('./src/models/InternalFeedback');

// GET /review/:id - Serve the review landing page
app.get('/review/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

// GET /api/review/:id/info - Get business info for review page (public, no auth)
app.get('/api/review/:id/info', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('businessName googlePlaceId');

    if (!user) {
      return res.status(404).json({ success: false, error: 'Business not found' });
    }

    // Build Google review URL if placeId exists
    let googleReviewUrl = null;
    if (user.googlePlaceId) {
      googleReviewUrl = `https://search.google.com/local/writereview?placeid=${user.googlePlaceId}`;
    }

    res.json({
      success: true,
      businessName: user.businessName,
      googleReviewUrl
    });
  } catch (error) {
    console.error('Error fetching review info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/review/:id/feedback - Save internal feedback from QR scan
app.post('/api/review/:id/feedback', async (req, res) => {
  try {
    const { rating, feedbackText, customerName, customerEmail } = req.body;

    // Validation
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, error: 'Invalid rating' });
    }

    if (!feedbackText || feedbackText.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Feedback text is required' });
    }

    // Get user to get business name
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Business not found' });
    }

    // Create feedback document
    const feedback = new InternalFeedback({
      userId: req.params.id,
      businessName: user.businessName,
      rating,
      feedbackText: feedbackText.trim(),
      customerName: customerName?.trim() || undefined,
      customerEmail: customerEmail?.trim() || undefined
    });

    await feedback.save();

    res.json({
      success: true,
      message: 'Feedback submitted successfully',
      feedbackId: feedback._id
    });
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// MONTHLY REPORTS
// ============================================

const PDFService = require('./src/services/pdfService');
const MonthlyReport = require('./src/models/MonthlyReport');

// GET /api/client/reports - List user's monthly reports (auth required)
app.get('/api/client/reports', authMiddleware, async (req, res) => {
  try {
    const reports = await MonthlyReport.find({ userId: req.user._id })
      .sort({ year: -1, month: -1 })
      .lean();

    res.json({ success: true, reports });
  } catch (error) {
    console.error('Error listing reports:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/client/reports/:id/download - Download a specific PDF (auth required)
app.get('/api/client/reports/:id/download', authMiddleware, async (req, res) => {
  try {
    const report = await MonthlyReport.findById(req.params.id);

    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    // Verify ownership
    if (report.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (!report.pdfBuffer) {
      return res.status(404).json({ success: false, error: 'PDF not available' });
    }

    // Send PDF
    const monthName = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'][report.month - 1];
    const filename = `LynxReview_Informe_${monthName}_${report.year}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(report.pdfBuffer);
  } catch (error) {
    console.error('Error downloading report:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================

async function startServer() {
  try {
    // Connect to MongoDB
    await connectDB();

    // Create default admin if doesn't exist
    await createDefaultAdmin();

    // Start cron jobs
    startCronJobs();

    // Start Express server
    app.listen(PORT, () => {
      console.log(`
========================================
  LynxReview Backend Server
========================================
  Environment: ${process.env.NODE_ENV || 'development'}
  Port: ${PORT}
  URL: http://localhost:${PORT}

  Pages:
    Login:      http://localhost:${PORT}/
    Register:   http://localhost:${PORT}/register.html
    Dashboard:  http://localhost:${PORT}/dashboard.html
    Admin:      http://localhost:${PORT}/admin-login.html

  API:
    Auth:       /api/auth/* (incl. signup-trial, convert-trial)
    Reviews:    /api/reviews/*
    Admin:      /api/admin/*
    Quick Approve: /api/quick-approve/*
    Client:     /api/client/* (profile, preferences, onboarding)
    Webhooks:   /webhooks/*
========================================
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Create default admin account on first run
async function createDefaultAdmin() {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@lynxreview.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'lynxreview2026';

    const existing = await Admin.findOne({ email: adminEmail });
    if (!existing) {
      const admin = new Admin({
        email: adminEmail,
        passwordHash: adminPassword, // Will be hashed by pre-save hook
        name: 'Xavier',
        role: 'superadmin'
      });
      await admin.save();
      console.log(`Default admin created: ${adminEmail}`);
    } else {
      // Sync password from env var on startup
      existing.passwordHash = adminPassword;
      await existing.save();
      console.log(`Default admin password synced: ${adminEmail}`);
    }
  } catch (error) {
    // Admin might already exist, that's fine
    if (error.code !== 11000) {
      console.error('Error creating default admin:', error.message);
    }
  }
}

startServer();
