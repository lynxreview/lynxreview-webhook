const OpenAI = require('openai');

let openai;
try {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} catch (e) {
  console.warn('OpenAI not configured - AI responses will use fallback templates');
}

class AIService {
  static async generateResponse(review, businessName) {
    if (!openai || !process.env.OPENAI_API_KEY) {
      return this.generateTemplateResponse(review, businessName);
    }
    try {
      const prompt = this.buildPrompt(review, businessName);
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Eres un asistente profesional que genera respuestas a resenas de Google para negocios locales en Espana. Reglas: Responde siempre en espanol. Usa un tono profesional pero cercano. No uses emojis excesivos (maximo 1-2). Personaliza la respuesta mencionando detalles de la resena si los hay. Si la resena es positiva (4-5 estrellas), agradece y anima a volver. Si es negativa (1-3 estrellas), muestra empatia, pide disculpas si procede, e invita a contactar para resolver. Maximo 3-4 frases. No inventes hechos sobre el negocio. Firma siempre como El equipo de [nombre del negocio]'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 300,
        temperature: 0.7
      });
      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error('AI generation error:', error.message);
      return this.generateTemplateResponse(review, businessName);
    }
  }

  static buildPrompt(review, businessName) {
    return `Genera una respuesta para esta resena de Google:\n\nNegocio: ${businessName}\nPuntuacion: ${review.rating}/5 estrellas\nNombre del cliente: ${review.reviewerName || 'Cliente'}\nTexto de la resena: "${review.reviewText || '(sin texto)'}"\n\nGenera una respuesta apropiada para publicar en Google.`;
  }

  static generateTemplateResponse(review, businessName) {
    const name = review.reviewerName || 'estimado/a cliente';
    if (review.rating === 5) {
      const templates = [
        `Muchas gracias por tu resena, ${name}. Nos alegra saber que tu experiencia fue excelente. Te esperamos pronto de nuevo en ${businessName}.`,
        `Gracias por tus amables palabras, ${name}. Es un placer saber que disfrutaste de tu visita. Esperamos verte pronto. El equipo de ${businessName}.`,
        `${name}, agradecemos enormemente tu valoracion. Tu opinion nos motiva a seguir mejorando cada dia. Hasta la proxima. El equipo de ${businessName}.`
      ];
      return templates[Math.floor(Math.random() * templates.length)];
    }
    if (review.rating === 4) {
      return `Gracias por tu resena, ${name}. Nos alegra que tu experiencia haya sido positiva. Trabajamos cada dia para alcanzar la excelencia y esperamos sorprenderte aun mas en tu proxima visita. El equipo de ${businessName}.`;
    }
    if (review.rating === 3) {
      return `Gracias por tu comentario, ${name}. Lamentamos que tu experiencia no haya sido completamente satisfactoria. Tomamos nota de tu feedback para seguir mejorando. Nos encantaria tener la oportunidad de ofrecerte una mejor experiencia. El equipo de ${businessName}.`;
    }
    return `${name}, lamentamos mucho saber que tu experiencia no fue la esperada. Tu opinion es muy importante para nosotros y queremos resolver esta situacion. Por favor, no dudes en contactarnos directamente para que podamos atenderte personalmente. El equipo de ${businessName}.`;
  }
}

module.exports = AIService;
