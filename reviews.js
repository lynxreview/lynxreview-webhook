/**
 * LynxReview - Reviews Management Module
 * Google Business Profile Integration
 */

module.exports = function(app, mongoose, openai, google, Cliente) {
  // Review Schema
  const reviewSchema = new mongoose.Schema({
    clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente', required: true },
    googleReviewId: { type: String, unique: true, sparse: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    reviewText: { type: String, required: true },
    reviewerName: String,
    reviewerEmail: String,
    reviewDate: Date,
    status: { type: String, enum: ['pending_response', 'approved', 'denied', 'published'], default: 'pending_response' },
    proposedResponse: String,
    proposedResponseSource: { type: String, enum: ['ai', 'admin'], default: 'ai' },
    publishedResponse: String,
    publishedAt: Date,
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Cliente' },
    approvedAt: Date,
    deniedReason: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });

  const Review = mongoose.model('Review', reviewSchema);

  // Fetch Google Reviews
  async function fetchGoogleReviews(clienteId) {
    try {
      const cliente = await Cliente.findById(clienteId);
      if (!cliente.googleAuth || !cliente.googleAuth.accessToken) {
        throw new Error('No Google auth');
      }

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_CALLBACK_URL
      );
      oauth2Client.setCredentials({
        access_token: cliente.googleAuth.accessToken,
        refresh_token: cliente.googleAuth.refreshToken
      });

      const accountId = cliente.googleAuth.accountId;
      const locationId = cliente.googleAuth.locationId;
      if (!accountId || !locationId) throw new Error('Missing Google Business config');

      const businessprofiles = google.businessprofiles('v1');
      const reviews = await businessprofiles.accounts.locations.reviews.list({
        parent: `accounts/${accountId}/locations/${locationId}`,
        auth: oauth2Client
      });

      return reviews.data.reviews || [];
    } catch (error) {
      console.error('Error fetching reviews:', error);
      return [];
    }
  }

  // Publish Response
  async function publishReviewResponse(clienteId, reviewId, responseText) {
    try {
      const cliente = await Cliente.findById(clienteId);
      const accountId = cliente.googleAuth.accountId;
      const locationId = cliente.googleAuth.locationId;

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_CALLBACK_URL
      );
      oauth2Client.setCredentials({
        access_token: cliente.googleAuth.accessToken,
        refresh_token: cliente.googleAuth.refreshToken
      });

      const businessprofiles = google.businessprofiles('v1');
      const response = await businessprofiles.accounts.locations.reviews.reply({
        name: `accounts/${accountId}/locations/${locationId}/reviews/${reviewId}`,
        requestBody: { comment: responseText },
        auth: oauth2Client
      });

      return response.data;
    } catch (error) {
      console.error('Error publishing:', error);
      throw error;
    }
  }

  // Generate AI Response
  async function generateAIResponse(reviewText, rating) {
    try {
      const prompt = rating === 5
        ? `Reseña 5⭐: "${reviewText}". Respuesta profesional breve (máx 200 chars) agradeciendo.`
        : `Reseña ${rating}⭐: "${reviewText}". Respuesta profesional. Máximo 200 chars.`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.7
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating AI response:', error);
      return rating === 5
        ? '¡Gracias por tu reseña! Nos alegra haber brindado excelente servicio.'
        : 'Agradecemos tu reseña. Contáctanos para mejorar tu experiencia.';
    }
  }

  // Route Review (5⭐ auto vs 4⭐ admin)
  async function routeReview(clienteId, googleReview) {
    try {
      const rating = googleReview.rating;
      let review = await Review.findOneAndUpdate(
        { googleReviewId: googleReview.name },
        {
          clienteId, googleReviewId: googleReview.name, rating,
          reviewText: googleReview.reviewText || '',
          reviewerName: googleReview.reviewer?.displayName || 'Anónimo',
          reviewDate: googleReview.createTime,
          updatedAt: Date.now()
        },
        { upsert: true, new: true }
      );

      if (rating === 5) {
        const proposedResponse = await generateAIResponse(googleReview.reviewText, rating);
        review.proposedResponse = proposedResponse;
        review.proposedResponseSource = 'ai';
        review.status = 'approved';
        await review.save();

        try {
          await publishReviewResponse(clienteId, googleReview.name, proposedResponse);
          review.publishedResponse = proposedResponse;
          review.publishedAt = new Date();
          review.status = 'published';
          await review.save();
        } catch (err) {
          console.error('Auto-publish error:', err);
        }
      } else {
        review.status = 'pending_response';
        const proposedResponse = await generateAIResponse(googleReview.reviewText, rating);
        review.proposedResponse = proposedResponse;
        review.proposedResponseSource = 'ai';
        await review.save();
      }

      return review;
    } catch (error) {
      console.error('Error routing review:', error);
      throw error;
    }
  }

  // API Endpoints
  app.get('/api/reviews', (req, res, next) => {
    if (!req.clienteId) return res.status(401).json({ error: 'Unauthorized' });
    (async () => {
      try {
        const clienteId = req.clienteId;
        const cliente = await Cliente.findById(clienteId);
        if (!cliente.googleAuth || !cliente.googleAuth.accessToken) {
          return res.status(400).json({ error: 'No Google auth' });
        }

        const googleReviews = await fetchGoogleReviews(clienteId);
        const processedReviews = await Promise.all(
          googleReviews.map(review => routeReview(clienteId, review))
        );

        res.json({ success: true, count: processedReviews.length, reviews: processedReviews });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    })();
  });

  app.get('/api/reviews/pending', (req, res, next) => {
    if (!req.clienteId) return res.status(401).json({ error: 'Unauthorized' });
    (async () => {
      try {
        const clienteId = req.clienteId;
        const pendingReviews = await Review.find({
          clienteId, status: 'pending_response', rating: { $lte: 4 }
        }).sort({ createdAt: -1 });

        res.json({ success: true, count: pendingReviews.length, reviews: pendingReviews });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    })();
  });

  app.post('/api/reviews/:reviewId/approve', (req, res, next) => {
    if (!req.clienteId) return res.status(401).json({ error: 'Unauthorized' });
    (async () => {
      try {
        const { reviewId } = req.params;
        const { response } = req.body;
        const clienteId = req.clienteId;

        const review = await Review.findById(reviewId);
        if (!review || review.clienteId.toString() !== clienteId) {
          return res.status(404).json({ error: 'Review not found' });
        }

        const finalResponse = response || review.proposedResponse;

        try {
          await publishReviewResponse(clienteId, review.googleReviewId, finalResponse);
        } catch (publishError) {
          return res.status(500).json({ error: 'Publish error: ' + publishError.message });
        }

        review.status = 'published';
        review.publishedResponse = finalResponse;
        review.publishedAt = new Date();
        review.approvedBy = clienteId;
        review.approvedAt = new Date();
        await review.save();

        res.json({ success: true, message: 'Approved', review });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    })();
  });

  app.post('/api/reviews/:reviewId/deny', (req, res, next) => {
    if (!req.clienteId) return res.status(401).json({ error: 'Unauthorized' });
    (async () => {
      try {
        const { reviewId } = req.params;
        const { reason } = req.body;
        const clienteId = req.clienteId;

        const review = await Review.findById(reviewId);
        if (!review || review.clienteId.toString() !== clienteId) {
          return res.status(404).json({ error: 'Review not found' });
        }

        review.status = 'denied';
        review.deniedReason = reason || 'Denied';
        await review.save();

        res.json({ success: true, message: 'Denied', review });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    })();
  });

  app.get('/api/auth/google/status', (req, res, next) => {
    if (!req.clienteId) return res.status(401).json({ error: 'Unauthorized' });
    (async () => {
      try {
        const cliente = await Cliente.findById(req.clienteId);
        const connected = !!(cliente.googleAuth && cliente.googleAuth.accessToken);
        res.json({ connected, businessName: cliente.googleAuth?.businessName || null });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    })();
  });

  return { Review, fetchGoogleReviews, publishReviewResponse, generateAIResponse, routeReview };
};
