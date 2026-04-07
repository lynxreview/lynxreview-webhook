/**
 * WhatsApp Service - Twilio WhatsApp Business API
 * Sends WhatsApp messages to clients for notifications
 */

let twilioClient;

try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch (e) {
  console.warn('Twilio not configured - WhatsApp notifications disabled');
}

class WhatsAppService {

  static FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

  static isConfigured() {
    return !!twilioClient;
  }

  // Send a plain text WhatsApp message
  static async sendMessage(toNumber, messageBody) {
    if (!twilioClient) {
      console.warn('WhatsApp: Twilio not configured, skipping message');
      return { success: false, error: 'Twilio not configured' };
    }

    try {
      const message = await twilioClient.messages.create({
        from: this.FROM,
        to: `whatsapp:${toNumber}`,
        body: messageBody
      });

      return {
        success: true,
        sid: message.sid,
        status: message.status
      };
    } catch (error) {
      console.error('WhatsApp send error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = WhatsAppService;
