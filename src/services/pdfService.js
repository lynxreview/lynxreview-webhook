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
  'o', 'poder', 'decir', 'este', 'ir', 'otro', 'ese', 'la', 'sí', 'me', 'ya', 'ver',
  'porquå', 'dar', 'cuando', 'él', 'muy', 'sin', 'vez', 'mucho', 'saber', 'qué', 'sobre',
  'mi', 'alguno', 'mismo', 'yo', 'también', 'hasta', 'año', 'dos', 'querer', 'entre',
  'así', 'primero', 'desde', 'grande', 'eso', 'ni', 'nros', 'llegar', 'pasar', 'tiempo',
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
  YAbctic async generateMonthlyReport(userId, month, year) {
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
