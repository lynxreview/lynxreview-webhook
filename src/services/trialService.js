/**
 * Trial Service
 * Manages 14-day free trials, drip campaigns, expiration, and conversion
 */

const User = require('../models/User');
const NotificationService = require('./notificationService');

class TrialService {

  static TRIAL_DAYS = parseInt(process.env.TRIAL_DURATION_DAYS) || 14;
  static MAX_RESPONSES = parseInt(process.env.TRIAL_MAX_RESPONSES) || 5;

  // Drip campaign messages by day
  static DRIP_STEPS = {
    0: {
      subject: '¡Bienvenido a LynxReview!',
      body: 'Tu cuenta de prueba está activa. Conecta Google Business Profile para sincronizar tus reseñas.',
      whatsapp: '👋 ¡Bienvenido a LynxReview! Conecta tu Google Business para ver tus reseñas.'
    },
    1: {
      subject: 'Ya sincronizamos tus reseñas',
      body: 'Tus reseñas de Google ya están disponibles en tu dashboard. Échales un vistazo.',
      whatsapp: '📊 Tus reseñas están listas. Mira tus métricas en el dashboard.'
    },
    3: {
      subject: 'Mira cómo responderíamos a tus reseñas',
      body: 'Hemos generado respuestas automáticas para tus reseñas. Así es como quedarían si las publicáramos.',
      whatsapp: '💬 Hemos generado respuestas para tus reseñas. Así quedarían publicadas.'
    },
    7: {
      subject: 'Tu puntuación de reputación',
      body: 'A mitad de tu prueba, ya puedes ver tu puntuación de reputación. Con el plan Plus, podrías mejorarla significativamente.',
      whatsapp: '📈 Ya llevas 7 días. ¿Has visto tu puntuación de reputación en el dashboard?'
    },
    10: {
      subject: 'Te quedan 4 días de prueba',
      body: 'Tu prueba gratuita termina en 4 días. Activa el plan Plus y llévate una placa QR gratis (valor 30€).',
      whatsapp: '⏰ Te quedan 4 días. Activa Plus y llévate la placa QR gratis (valor 30€).'
    },
    13: {
      subject: 'Último día mañana',
      body: 'Mañana termina tu prueba. ¿Seguimos cuidando tu reputación online?',
      whatsapp: '⚡ Mañana termina tu prueba. ¿Seguimos cuidando tu reputación?'
    },
    14: {
      subject: 'Tu prueba ha terminado',
      body: 'Tu prueba gratuita ha terminado. Tus datos se guardan 30 días. Oferta especial: 20% de descuento en tu primer mes.',
      whatsapp: '🔒 Tu prueba terminó. Tus datos se guardan 30 días. 20% off si activas ahora.'
    }
  };

  // Create a new trial user
  static async createTrial(userData) {
    const now = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + this.TRIAL_DAYS);

    const user = new User({
      ...userData,
      planId: 'trial',
      subscriptionStatus: 'active',
      trialStartDate: now,
      trialEndDate: trialEnd,
      trialStatus: 'active',
      trialResponsesUsed: 0,
      trialEmailStep: 0,
      responsePreferences: {
        tone: 'friendly',
        autoApprove5Stars: false,
        language: 'es'
      },
      notificationPreferences: {
        channels: ['email'],
        quickApproveEnabled: true,
        weeklyDigest: true,
        digestDay: 'monday'
      }
    });

    await user.save();

    // Send welcome notification (step 0)
    await this._sendDripNotification(user, 0);

    return user;
  }

  // Check if trial user can generate AI responses
  static canGenerateResponse(user) {
    if (user.planId !== 'trial') return { allowed: true };
    if (user.trialStatus !== 'active') return { allowed: false, reason: 'Trial expirado' };
    if (user.trialResponsesUsed >= this.MAX_RESPONSES) {
      return { allowed: false, reason: `Límite de ${this.MAX_RESPONSES} respuestas alcanzado en trial` };
    }
    return { allowed: true, remaining: this.MAX_RESPONSES - user.trialResponsesUsed };
  }

  // Trial users cannot publish to Google
  static canPublishToGoogle(user) {
    return user.planId !== 'trial';
  }

  // Process daily drip campaign for all active trials
  static async processDripCampaign() {
    const activeTrials = await User.find({
      trialStatus: 'active',
      planId: 'trial'
    });

    let sent = 0;
    for (const user of activeTrials) {
      const daysSinceStart = Math.floor(
        (Date.now() - user.trialStartDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (this.DRIP_STEPS[daysSinceStart] && user.trialEmailStep < daysSinceStart) {
        await this._sendDripNotification(user, daysSinceStart);
        user.trialEmailStep = daysSinceStart;
        await user.save();
        sent++;
      }
    }

    return { processed: activeTrials.length, sent };
  }

  // Expire all overdue trials
  static async expireTrials() {
    const expired = await User.find({
      trialStatus: 'active',
      trialEndDate: { $lt: new Date() }
    });

    for (const user of expired) {
      user.trialStatus = 'expired';
      user.subscriptionStatus = 'cancelled';
      await user.save();

      // Send expiration notification
      await this._sendDripNotification(user, 14);
    }

    return { expired: expired.length };
  }

  // Convert trial to paid plan
  static async convertTrial(userId, planId, stripeData = {}) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.trialStatus !== 'active' && user.trialStatus !== 'expired') {
      throw new Error('No active or expired trial found');
    }

    user.planId = planId;
    user.trialStatus = 'converted';
    user.trialConvertedAt = new Date();
    user.subscriptionStatus = 'active';
    user.subscriptionStartDate = new Date();

    if (stripeData.customerId) user.stripeCustomerId = stripeData.customerId;
    if (stripeData.subscriptionId) user.stripeSubscriptionId = stripeData.subscriptionId;
    if (stripeData.sessionId) user.stripeSessionId = stripeData.sessionId;

    await user.save();

    await NotificationService.send(userId, 'trial_converted', {
      planId,
      businessName: user.businessName
    });

    return user;
  }

  // Helper: send drip notification
  static async _sendDripNotification(user, step) {
    const template = this.DRIP_STEPS[step];
    if (!template) return;

    await NotificationService.send(user._id, 'trial_drip', {
      step,
      subject: template.subject,
      body: template.body,
      whatsappMessage: template.whatsapp,
      ownerName: user.ownerName,
      businessName: user.businessName
    });
  }
}

module.exports = TrialService;
