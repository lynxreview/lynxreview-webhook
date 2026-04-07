/**
 * Notification Service - Multichannel Router (Email + WhatsApp)
 * Central hub that dispatches notifications to configured channels
 */

const User = require('../models/User');
const WhatsAppService = require('./whatsappService');
const NotificationLog = require('../models/NotificationLog');
const nodemailer = require('nodemailer');

// Email transporter (lazy init)
let emailTransporter;
function getEmailTransporter() {
  if (!emailTransporter) {
    emailTransporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
  }
  return emailTransporter;
}

class NotificationService {

  // =========================================
  // MAIN ROUTER
  // =========================================

  static async send(userId, eventType, data = {}) {
    const user = await User.findById(userId);
    if (!user) {
      console.error(`NotificationService: User ${userId} not found`);
      return [];
    }

    const channels = user.notificationPreferences?.channels || ['email'];
    const results = [];

    for (const channel of channels) {
      try {
        let result;
        switch (channel) {
          case 'email':
            result = await this._sendEmail(user, eventType, data);
            break;
          case 'whatsapp':
            result = await this._sendWhatsApp(user, eventType, data);
            break;
          default:
            continue;
        }

        await this._logNotification(userId, channel, eventType, data, result);
        results.push({ channel, ...result });
      } catch (error) {
        console.error(`Notification error (${channel}):`, error.message);
        await this._logNotification(userId, channel, eventType, data, {
          success: false, error: error.message
        });
      }
    }

    return results;
  }

  // =========================================
  // EMAIL CHANNEL
  // =========================================

  static async _sendEmail(user, eventType, data) {
    const transporter = getEmailTransporter();
    if (!process.env.EMAIL_USER) {
      return { success: false, error: 'Email not configured' };
    }

    const emailContent = this._buildEmailContent(user, eventType, data);
    if (!emailContent) return { success: false, error: 'Unknown event type' };

    try {
      const info = await transporter.sendMail({
        from: `"LynxReview" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: emailContent.subject,
        html: emailContent.html
      });

      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Email send error:', error.message);
      return { success: false, error: error.message };
    }
  }

  static _buildEmailContent(user, eventType, data) {
    const baseUrl = process.env.FRONTEND_URL || 'https://lynxreview-webhook.onrender.com';
    const businessName = user.businessName || 'tu negocio';

    const templates = {

      new_review: {
        subject: `Nueva reseña en ${businessName} (${'⭐'.repeat(data.rating || 5)})`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>🔔 Nueva reseña en ${businessName}</h2>
            <div style="background:#f9f9f9;padding:16px;border-radius:8px;margin:16px 0;">
              <p><strong>${data.authorName || 'Cliente'}</strong> — ${'⭐'.repeat(data.rating || 5)}</p>
              <p style="font-style:italic;">"${(data.reviewText || '').substring(0, 200)}"</p>
            </div>
            <a href="${baseUrl}/dashboard.html" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">Ver en dashboard</a>
          </div>`
      },

      critical_alert: {
        subject: `🚨 Reseña negativa en ${businessName}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2 style="color:#dc2626;">🚨 Alerta: Reseña negativa</h2>
            <div style="background:#fef2f2;padding:16px;border-radius:8px;border-left:4px solid #dc2626;">
              <p><strong>${data.authorName || 'Cliente'}</strong> — ${'⭐'.repeat(data.rating || 1)}</p>
              <p>"${(data.reviewText || '').substring(0, 300)}"</p>
            </div>
            ${data.approveUrl ? `<div style="margin:16px 0;">
              <a href="${data.approveUrl}" style="display:inline-block;background:#22c55e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-right:8px;">✅ Aprobar respuesta</a>
              <a href="${data.editUrl}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">✏️ Editar</a>
            </div>` : ''}
          </div>`
      },

      quick_approve: {
        subject: `📝 Respuesta lista: ${data.authorName || 'Cliente'} (${'⭐'.repeat(data.rating || 3)})`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>📝 Respuesta lista para aprobación</h2>
            <div style="background:#f9f9f9;padding:16px;border-radius:8px;margin:16px 0;">
              <p><strong>Reseña de ${data.authorName || 'Cliente'}</strong> (${'⭐'.repeat(data.rating || 3)})</p>
              <p style="font-style:italic;">"${(data.reviewText || '').substring(0, 200)}"</p>
            </div>
            <div style="background:#f0fdf4;padding:16px;border-radius:8px;margin:16px 0;border-left:4px solid #22c55e;">
              <p><strong>Respuesta propuesta:</strong></p>
              <p>"${(data.responseText || '').substring(0, 300)}"</p>
            </div>
            <div style="margin:16px 0;">
              <a href="${data.approveUrl}" style="display:inline-block;background:#22c55e;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:16px;margin-right:8px;">✅ Aprobar y publicar</a>
              <a href="${data.editUrl}" style="display:inline-block;background:#3b82f6;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:16px;margin-right:8px;">✏️ Editar</a>
              <a href="${data.denyUrl}" style="display:inline-block;background:#9ca3af;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:16px;">❌ Rechazar</a>
            </div>
            <p style="color:#6b7280;font-size:13px;">Este enlace expira en 24 horas.</p>
          </div>`
      },

      response_published: {
        subject: `✅ Respuesta publicada en Google`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>✅ Respuesta publicada</h2>
            <p>La respuesta a la reseña de <strong>${data.authorName || 'Cliente'}</strong> se ha publicado en Google.</p>
            <a href="${baseUrl}/dashboard.html" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">Ver en dashboard</a>
          </div>`
      },

      weekly_digest: {
        subject: `📊 Resumen semanal - ${businessName}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>📊 Resumen semanal</h2>
            <div style="background:#f9f9f9;padding:16px;border-radius:8px;">
              <p>📝 <strong>${data.newReviews || 0}</strong> reseñas nuevas</p>
              <p>⭐ Rating promedio: <strong>${data.avgRating || '—'}</strong></p>
              <p>📈 Puntuación de reputación: <strong>${data.reputationScore || '—'}/100</strong></p>
              <p>⏳ <strong>${data.pendingResponses || 0}</strong> respuestas pendientes</p>
            </div>
            <a href="${baseUrl}/dashboard.html" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:16px;">Ver dashboard</a>
          </div>`
      },

      trial_drip: {
        subject: data.subject || 'LynxReview',
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>${data.subject || ''}</h2>
            <p>${data.body || ''}</p>
            <a href="${baseUrl}/dashboard.html" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:16px;">Ir a LynxReview</a>
          </div>`
      },

      trial_converted: {
        subject: `🎉 ¡Bienvenido a LynxReview ${data.planId || ''}!`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>🎉 ¡Bienvenido al plan ${data.planId || ''}!</h2>
            <p>Tu cuenta está ahora completamente activa. Todas las respuestas se publicarán automáticamente en Google.</p>
            <a href="${baseUrl}/dashboard.html" style="display:inline-block;background:#22c55e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;">Ir al dashboard</a>
          </div>`
      },

      monthly_report: {
        subject: `📊 Tu informe de reputación - ${data.month || 'Mes'} ${data.year || ''}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>📊 Informe mensual de reputación</h2>
            <p>Tu informe detallado para <strong>${data.month || ''} de ${data.year || ''}</strong> está listo.</p>
            <div style="background:#f0fdf4;padding:16px;border-radius:8px;margin:16px 0;border-left:4px solid #22c55e;">
              <p>El informe incluye:</p>
              <ul style="margin:8px 0;padding-left:20px;">
                <li>Resumen ejecutivo de métricas</li>
                <li>Distribución de calificaciones</li>
                <li>Palabras clave más mencionadas</li>
                <li>Reseñas críticas sin responder</li>
                <li>Recomendaciones personalizadas</li>
              </ul>
            </div>
            <a href="${baseUrl}/dashboard.html" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:16px;">Ver informe completo</a>
          </div>`
      }
    };

    return templates[eventType] || null;
  }

  // =========================================
  // WHATSAPP CHANNEL
  // =========================================

  static async _sendWhatsApp(user, eventType, data) {
    const phone = user.notificationPreferences?.whatsappNumber;
    if (!phone) return { success: false, error: 'No WhatsApp number configured' };

    if (!WhatsAppService.isConfigured()) {
      return { success: false, error: 'WhatsApp not configured' };
    }

    const message = this._buildWhatsAppMessage(user, eventType, data);
    if (!message) return { success: false, error: 'No template for event' };

    return await WhatsAppService.sendMessage(phone, message);
  }

  static _buildWhatsAppMessage(user, eventType, data) {
    const name = user.businessName || 'tu negocio';
    const baseUrl = process.env.FRONTEND_URL || 'https://lynxreview-webhook.onrender.com';

    const templates = {
      new_review: () =>
        `🔔 Nueva reseña en ${name}\n` +
        `${'⭐'.repeat(data.rating || 5)} - ${data.authorName || 'Cliente'}\n` +
        `"${(data.reviewText || '').substring(0, 100)}"\n\n` +
        `📊 Este mes: ${data.monthReviews || '?'} reseñas | ${data.avgRating || '?'} promedio`,

      critical_alert: () =>
        `🚨 ALERTA: Reseña negativa en ${name}\n` +
        `${'⭐'.repeat(data.rating || 1)} - ${data.authorName || 'Cliente'}\n` +
        `"${(data.reviewText || '').substring(0, 150)}"\n\n` +
        (data.approveUrl ? `✅ Aprobar: ${data.approveUrl}` : ''),

      quick_approve: () =>
        `📝 Respuesta lista para aprobación\n\n` +
        `Reseña de ${data.authorName || 'Cliente'} (${'⭐'.repeat(data.rating || 3)}):\n` +
        `"${(data.reviewText || '').substring(0, 80)}"\n\n` +
        `Respuesta propuesta:\n` +
        `"${(data.responseText || '').substring(0, 120)}"\n\n` +
        `✅ Aprobar: ${data.approveUrl || ''}\n` +
        `✏️ Editar: ${data.editUrl || ''}`,

      response_published: () =>
        `✅ Respuesta publicada en Google\n` +
        `Reseña de ${data.authorName || 'Cliente'} (${'⭐'.repeat(data.rating || 5)})`,

      weekly_digest: () =>
        `📊 Resumen semanal - ${name}\n\n` +
        `• ${data.newReviews || 0} reseñas nuevas\n` +
        `• Rating promedio: ${data.avgRating || '—'}\n` +
        `• Reputación: ${data.reputationScore || '—'}/100\n` +
        `• ${data.pendingResponses || 0} respuestas pendientes`,

      trial_drip: () => data.whatsappMessage || null,

      monthly_report: () =>
        `📊 Informe mensual - ${data.month || ''} ${data.year || ''}\n\n` +
        `Tu informe de reputación está listo. ` +
        `Incluye métricas, análisis de palabras clave y recomendaciones personalizadas.\n\n` +
        `Ver en dashboard: ${baseUrl}/dashboard.html`
    };

    const builder = templates[eventType];
    return builder ? builder() : null;
  }

  // =========================================
  // LOGGING
  // =========================================

  static async _logNotification(userId, channel, type, metadata, result) {
    try {
      await new NotificationLog({
        userId,
        channel,
        type,
        metadata: { ...metadata, responseText: undefined }, // Don't log full response texts
        status: result.success ? 'sent' : 'failed',
        externalId: result.sid || result.messageId || null,
        sentAt: result.success ? new Date() : null
      }).save();
    } catch (error) {
      console.error('Error logging notification:', error.message);
    }
  }
}

module.exports = NotificationService;
