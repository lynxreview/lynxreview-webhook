const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// Map planId to Stripe Price IDs from environment
const PLAN_PRICES = {
  basic: process.env.STRIPE_PRICE_BASICO,
  plus: process.env.STRIPE_PRICE_PLUS,
  premium: process.env.STRIPE_PRICE_PREMIUM,
};

const PLAN_LABELS = {
  basic: 'LynxReview Básico',
  plus: 'LynxReview Plus',
  premium: 'LynxReview Premium',
};

// POST /api/payment/create-checkout
// Creates a Stripe Checkout Session and returns the URL
router.post('/create-checkout', async (req, res) => {
  try {
    const { planId, email, businessName } = req.body;

    if (!planId) {
      return res.status(400).json({ success: false, error: 'Plan requerido' });
    }

    const priceId = PLAN_PRICES[planId];
    if (!priceId) {
      return res.status(400).json({ success: false, error: `Plan no válido: ${planId}` });
    }

    // Base URL for redirects: use env var or auto-detect from request
    const baseUrl = process.env.APP_BASE_URL || `https://${req.get('host')}`;

    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      success_url: `${baseUrl}/register.html?session_id={CHECKOUT_SESSION_ID}&plan=${planId}`,
      cancel_url: `${baseUrl}/register.html?cancelled=true&plan=${planId}`,
      metadata: {
        planId,
        businessName: businessName || '',
      },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    };

    // Pre-fill email if provided
    if (email) {
      sessionParams.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ success: true, url: session.url, sessionId: session.id });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/payment/verify-session/:sessionId
// Verifies a completed Stripe session (optional, for frontend confirmation)
router.get('/verify-session/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);

    if (session.payment_status === 'paid' || session.status === 'complete') {
      res.json({
        success: true,
        paid: true,
        planId: session.metadata?.planId,
        email: session.customer_email || session.customer_details?.email,
        subscriptionId: session.subscription,
      });
    } else {
      res.json({ success: true, paid: false, status: session.status });
    }
  } catch (error) {
    res.status(400).json({ success: false, error: 'Sesión no encontrada' });
  }
});

module.exports = router;
