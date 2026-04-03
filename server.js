require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const connectDB = require('./src/config/database');
const Admin = require('./src/models/Admin');

// Import routes
const authRoutes = require('./src/routes/auth');
const clientRoutes = require('./src/routes/client');
const adminRoutes = require('./src/routes/admin');
const webhookRoutes = require('./src/routes/webhooks');

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

// Body parser for JSON (except Stripe webhooks which need raw body)
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));

// ============================================
// STATIC FILES
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API ROUTES
// ============================================

// Auth routes (login, register, Google OAuth)
app.use('/api/auth', authRoutes);

// Also mount Google OAuth start at /auth/google for backward compat with dashboard
app.get('/auth/google', (req, res) => {
  res.redirect('/api/auth/google?redirect=true');
});

// Admin routes (clients, metrics) - under /api/admin
app.use('/api/admin', adminRoutes);

// Admin review routes (pending, approve, deny) - also under /api/reviews for frontend compat
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

// Webhook routes
app.use('/webhooks', webhookRoutes);

// ============================================
// PAGE ROUTES (serve HTML pages)
// ============================================

// Root -> login page
app.get('/', (req, res) => {
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

// Google OAuth callback
app.get('/api/auth/google/callback', authRoutes);

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
    Auth:       /api/auth/*
    Reviews:    /api/reviews/*
    Admin:      /api/admin/*
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
    }
  } catch (error) {
    // Admin might already exist, that's fine
    if (error.code !== 11000) {
      console.error('Error creating default admin:', error.message);
    }
  }
}

startServer();
