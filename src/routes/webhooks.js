const express = require('express');
const User = require('../models/User');

const router = express.Router();

// POST /webhooks/stripe - Handle Stripe webhook events
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];

    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('Payment completed:', session.id);

        // Find user by stripe session ID and activate
        const user = await User.findOne({ stripeSessionId: session.id });
        if (user) {
          user.subscriptionStatus = 'active';
          user.stripeCustomerId = session.customer;
          user.stripeSubscriptionId = session.subscription;
          await user.save();
          console.log(`Activated subscription for: ${user.email}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const user = await User.findOne({ stripeCustomerId: subscription.customer });
        if (user) {
          user.subscriptionStatus = subscription.status === 'active' ? 'active' : 'paused';
          await user.save();
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const user = await User.findOne({ stripeCustomerId: subscription.customer });
        if (user) {
          user.subscriptionStatus = 'cancelled';
          await user.save();
          console.log(`Subscription cancelled for: ${user.email}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = await User.findOne({ stripeCustomerId: invoice.customer });
        if (user) {
          user.subscriptionStatus = 'paused';
          await user.save();
          console.log(`Payment failed for: ${user.email}`);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing error:', error);
    res.status(500).json({ error: 'Processing error' });
  }
});

module.exports = router;
