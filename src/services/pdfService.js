const PDFDocument = require('pdfkit');
const Review = require('../models/Review');
const User = require('../models/User');
const MonthlyReport = require('../models/MonthlyReport');
const ReviewService = require('./reviewService');
const NotificationService = require('./notificationService');

// Common Spanish stop words to exclude from keyword analysis
const SPANISH_STOP_WORDS = new Set([
  'el', 'la', 'de', 'que', 'y', 'a', 'en', 'un', 'ser', 'se', 'no', 'haber', 'por',
  'con', 'su', 'para', 'estar', 'tener', 'le', 'lo', 'todo', 'pero', 'más', 'hacer',
  'o', 'poder', 'decir', 'este', 'ir', 'otro', 'ese', 'la', 'si', 'me', 'ya', 'ver',
  'porque', 'dar', 'cuando', 'él', 'muy', 'sin', 'vez', 'mucho', 'saber', 'qué', 'sobre',
  'mi', 'alguno', 'mismo', 'yo', 'también', 'hasta', 'año', 'dos', 'querer', 'entre',
  'así', 'primero', 'desde', 'grande', 'eso', 'ni', 'nos', 'llegar', 'pasar', 'tiempo',
  'ella', 'sí', 'día', 'uno', 'bien', 'poco', 'deber', 'entonces', 'poner', 'cosa',
  'tanto', 'hombre', 'parecer', 'nuestro', 'tan', 'donde', 'ahora', 'parte', 'después',
  'vida', 'quedar', 'siempre', 'creer', 'hablar', 'llevar', 'dejar', 'nada', 'cada',
  'seguir', 'menos', 'nuevo', 'encontrar', 'algo', 'solo', 'pedir', 'salir', 'pensar',
  'es', 'fue', 'son', 'está', 'estoy', 'fueron', 'somos', 'son', 'eres', 'soy', 'es',
  'muy', 'más', 'menos', 'bastante', 'tan', 'tanto', 'una', 'unos', 'unas',
  'los', 'las', 'les', 'me', 'te', 'nos', 'os', 'les', 'mí', 'ti', 'sí',
  'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'vuestro', 'vuestra', 'vuestros', 'vuestras', 'mío', 'mía', 'míos', 'mías',
  'tuyo', 'tuya', 'tuyos', 'tuyas', 'suyo', 'suya', 'suyos', 'suyas'
]);

class PDFService {

  /**
   * Generate a monthly PDF report for a user
   * @param {string} userId - User ID
   * @param {number} month - Month (1-12)
   * @param {number} year - Year
   * @returns {Buffer} PDF as buffer
   */
  static async generateMonthlyReport(userId, month, year) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // Get reviews for the month
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const reviews = await Review.find({
      userId,
      reviewDate: { $gte: startDate, $lte: endDate }
    }).sort({ reviewDate: -1 });

    // Calculate metrics for this month
    const metrics = this._calculateMetrics(reviews);

    // Calculate month-over-month change
    const previousMonthStart = new Date(year, month - 2, 1);
    const previousMonthEnd = new Date(year, month - 1, 0, 23, 59, 59);
    const previousReviews = await Review.find({
      userId,
      reviewDate: { $gte: previousMonthStart, $lte: previousMonthEnd }
    });

    const previousAvgRating = previousReviews.length > 0
      ? previousReviews.reduce((sum, r) => sum + r.rating, 0) / previousReviews.length
      : 0;
    const monthOverMonthChange = previousReviews.length > 0
      ? Math.round(((metrics.avgRating - previousAvgRating) / previousAvgRating) * 100)
      : 0;

    // Extract top keywords from reviews
    const topKeywords = this._extractTopKeywords(reviews, 10);

    // Get critical reviews (unresponded low ratings)
    const criticalReviews = reviews
      .filter(r => r.rating <= 2 && r.status === 'pending_response')
      .slice(0, 5)
      .map(r => ({
        reviewId: r._id,
        rating: r.rating,
        reviewText: r.reviewText,
        reviewerName: r.reviewerName,
        reviewDate: r.reviewDate,
        daysWithoutResponse: Math.floor((Date.now() - r.reviewDate) / (1000 * 60 * 60 * 24))
      }));

    // Generate PDF
    const pdfBuffer = await this._generatePDF(
      user,
      month,
      year,
      metrics,
      monthOverMonthChange,
      topKeywords,
      criticalReviews,
      reviews
    );

    // Save report to database
    const report = await MonthlyReport.findOneAndUpdate(
      { userId, month, year },
      {
        userId,
        month,
        year,
        generatedAt: new Date(),
        metrics,
        topKeywords,
        criticalReviews,
        pdfBuffer
      },
      { upsert: true, new: true }
    );

    return pdfBuffer;
  }

  /**
   * Generate and send monthly report via email
   * @param {string} userId - User ID
   */
  static async generateAndSendReport(userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // Generate report for previous month
    const today = new Date();
    const month = today.getMonth(); // 0-11
    const year = today.getFullYear();

    try {
      const pdfBuffer = await this.generateMonthlyReport(userId, month, year);

      // Update report with sentAt timestamp
      await MonthlyReport.findOneAndUpdate(
        { userId, month, year },
        { sentAt: new Date() }
      );

      // Send email with notification service
      await NotificationService.send(userId, 'monthly_report', {
        month: this._getMonthName(month),
        year
      });

      return { success: true, message: 'Report generated and sent' };
    } catch (error) {
      console.error(`Error generating report for ${user.email}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  static _calculateMetrics(reviews) {
    const total = reviews.length;
    const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let positiveCount = 0;
    let negativeCount = 0;

    reviews.forEach(r => {
      ratingCounts[r.rating]++;
      if (r.rating >= 4) positiveCount++;
      else if (r.rating <= 2) negativeCount++;
    });

    const avgRating = total > 0
      ? (reviews.reduce((sum, r) => sum + r.rating, 0) / total).toFixed(1)
      : 0;

    const reputationScore = Math.min(100, Math.round(
      parseFloat(avgRating) * 15 + Math.min(total * 2, 25) + (ratingCounts[1] === 0 ? 10 : 0)
    ));

    return {
      totalReviews: total,
      avgRating: parseFloat(avgRating),
      reputationScore,
      fiveStarCount: ratingCounts[5],
      fourStarCount: ratingCounts[4],
      threeStarCount: ratingCounts[3],
      twoStarCount: ratingCounts[2],
      oneStarCount: ratingCounts[1],
      criticalCount: ratingCounts[1] + ratingCounts[2],
      positiveCount,
      negativeCount
    };
  }

  static _extractTopKeywords(reviews, limit = 10) {
    const wordFreq = {};

    reviews.forEach(review => {
      if (!review.reviewText) return;

      const words = review.reviewText
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !SPANISH_STOP_WORDS.has(w));

      words.forEach(word => {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      });
    });

    return Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word, frequency]) => ({ word, frequency }));
  }

  static async _generatePDF(user, month, year, metrics, monthOverMonthChange, topKeywords, criticalReviews, allReviews) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        const chunks = [];

        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const monthName = this._getMonthName(month);
        const logoText = 'LynxReview';
        const businessName = user.businessName || 'Business';

        // ============================================
        // HEADER
        // ============================================
        doc.fontSize(28).font('Helvetica-Bold').text(logoText, { align: 'left' });
        doc.fontSize(10).font('Helvetica').text('Informe de Reputación Online', { align: 'left' });
        doc.moveDown(0.5);

        doc.fontSize(16).font('Helvetica-Bold').text(businessName, { align: 'right' });
        doc.fontSize(10).font('Helvetica').text(`${monthName} ${year}`, { align: 'right' });

        doc.moveTo(40, doc.y + 10).lineTo(550, doc.y + 10).stroke();
        doc.moveDown(1);

        // ============================================
        // EXECUTIVE SUMMARY
        // ============================================
        doc.fontSize(14).font('Helvetica-Bold').text('Resumen Ejecutivo', { underline: true });
        doc.moveDown(0.5);

        const summaryData = [
          ['Total de Reseñas', metrics.totalReviews.toString()],
          ['Calificación Promedio', metrics.avgRating.toFixed(1) + ' ⭐'],
          ['Puntuación de Reputación', metrics.reputationScore + '/100'],
          ['Cambio MoM', (monthOverMonthChange >= 0 ? '+' : '') + monthOverMonthChange + '%']
        ];

        doc.fontSize(10).font('Helvetica');
        summaryData.forEach((row, i) => {
          doc.text(row[0], 50, doc.y, { width: 200 });
          doc.font('Helvetica-Bold').text(row[1], 300, doc.y - doc.heightOfString(row[0]));
          doc.font('Helvetica').moveDown(0.5);
        });

        doc.moveDown(0.5);

        // ============================================
        // RATING DISTRIBUTION (BAR CHART)
        // ============================================
        doc.fontSize(14).font('Helvetica-Bold').text('Distribución de Calificaciones', { underline: true });
        doc.moveDown(0.5);

        const maxCount = Math.max(
          metrics.fiveStarCount,
          metrics.fourStarCount,
          metrics.threeStarCount,
          metrics.twoStarCount,
          metrics.oneStarCount
        ) || 1;

        const barWidth = 200;
        const bars = [
          { stars: 5, count: metrics.fiveStarCount, label: '5 estrellas' },
          { stars: 4, count: metrics.fourStarCount, label: '4 estrellas' },
          { stars: 3, count: metrics.threeStarCount, label: '3 estrellas' },
          { stars: 2, count: metrics.twoStarCount, label: '2 estrellas' },
          { stars: 1, count: metrics.oneStarCount, label: '1 estrella' }
        ];

        doc.fontSize(9).font('Helvetica');
        bars.forEach(bar => {
          const proportion = bar.count / maxCount;
          const filledWidth = barWidth * proportion;

          // Label
          doc.text(bar.label, 50, doc.y, { width: 80 });
          const labelY = doc.y - 12;

          // Bar background
          doc.rect(140, labelY, barWidth, 12).stroke();

          // Bar fill (green for 5-4, yellow for 3, red for 1-2)
          let color = '#4CAF50'; // green
          if (bar.stars === 3) color = '#FFC107'; // yellow
          else if (bar.stars <= 2) color = '#F44336'; // red

          doc.rect(140, labelY, filledWidth, 12).fill(color);

          // Count text
          doc.font('Helvetica-Bold').fillColor('black').text(bar.count.toString(), 350, labelY);
          doc.font('Helvetica');

          doc.moveDown(0.8);
        });

        doc.moveDown(0.5);

        // ============================================
        // TOP KEYWORDS
        // ============================================
        doc.fontSize(14).font('Helvetica-Bold').text('Palabras Clave Más Mencionadas', { underline: true });
        doc.moveDown(0.5);

        doc.fontSize(9).font('Helvetica');
        if (topKeywords.length > 0) {
          const keywordText = topKeywords
            .map(kw => `${kw.word} (${kw.frequency})`)
            .join('  •  ');
          doc.text(keywordText, { align: 'left', width: 470 });
        } else {
          doc.text('Sin palabras clave destacadas', { color: '#999' });
        }

        doc.moveDown(0.8);

        // ============================================
        // SENTIMENT SUMMARY
        // ============================================
        doc.fontSize(14).font('Helvetica-Bold').text('Resumen de Sentimiento', { underline: true });
        doc.moveDown(0.5);

        const sentimentData = [
          [`Positivas (4-5 ⭐)`, metrics.positiveCount.toString(), '#4CAF50'],
          [`Negativas (1-2 ⭐)`, metrics.negativeCount.toString(), '#F44336']
        ];

        doc.fontSize(10).font('Helvetica');
        sentimentData.forEach(([label, count, color]) => {
          doc.text(label, 50, doc.y, { width: 200 });
          doc.fillColor(color).font('Helvetica-Bold').text(count, 300, doc.y - 12);
          doc.fillColor('black').font('Helvetica').moveDown(0.5);
        });

        doc.moveDown(0.5);

        // ============================================
        // CRITICAL REVIEWS REQUIRING ATTENTION
        // ============================================
        if (criticalReviews.length > 0) {
          doc.fontSize(14).font('Helvetica-Bold').text('Reseñas Críticas sin Responder', { underline: true });
          doc.moveDown(0.5);

          doc.fontSize(9).font('Helvetica');
          criticalReviews.forEach((review, i) => {
            doc.fillColor('#F44336').font('Helvetica-Bold').text(`${review.rating}⭐ - ${review.reviewerName}`, 50);
            doc.fillColor('black').font('Helvetica');
            doc.text(review.reviewText.substring(0, 150), 50, doc.y, { width: 420 });
            doc.fontSize(8).text(`Sin respuesta por ${review.daysWithoutResponse} días`, { color: '#999' });
            doc.fontSize(9).moveDown(0.5);
          });

          doc.moveDown(0.5);
        }

        // ===========================================================
        // RECOMMENDATIONS
        // ============================================
        doc.fontSize(14).font('Helvetica-Bold').text('Recomendaciones', { underline: true });
        doc.moveDown(0.5);

        const recommendations = this._generateRecommendations(metrics);
        doc.fontSize(9).font('Helvetica');
        recommendations.forEach((rec, i) => {
          doc.text(`${i + 1}. ${rec}`, 50, doc.y, { width: 420 });
          doc.moveDown(0.4);
        });

        // ============================================
        // FOOTER
        // ============================================
        doc.moveDown(1);
        doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(0.5);
        doc.fontSize(8).font('Helvetica').text(
          `Generado por LynxReview • ${new Date().toLocaleDateString('es-ES')}`,
          { align: 'center', color: '#999' }
        );

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  static _generateRecommendations(metrics) {
    const recommendations = [];

    if (metrics.avgRating < 3.5) {
      recommendations.push('Tu calificación promedio está por debajo de 3.5. Considera mejorar la calidad del servicio y responder a todas las reseñas negativas.');
    }

    if (metrics.criticalCount > 0) {
      recommendations.push(`Tienes ${metrics.criticalCount} reseñas críticas (1-2 estrellas). Responde rápidamente a estas reseñas para demostrar que te importa el feedback del cliente.`);
    }

    if (metrics.positiveCount < metrics.totalReviews * 0.6) {
      recommendations.push('Menos del 60% de tus reseñas son positivas. Enfócate en mejorar la experiencia del cliente en las áreas problemáticas.');
    } else {
      recommendations.push('¡Excelente! El 60% o más de tus reseñas son positivas. Mantén este estándar y sigue recogiendo feedback de tus clientes.');
    }

    return recommendations.slice(0, 3);
  }

  static _getMonthName(monthIndex) {
    const months = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
    ];
    return months[monthIndex] || 'Mes desconocido';
  }
}

module.exports = PDFService;
