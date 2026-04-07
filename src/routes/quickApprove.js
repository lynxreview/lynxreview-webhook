/**
 * Quick Approve Routes
 * PUBLIC routes (no JWT) — authentication is via temporary token
 */

const express = require('express');
const QuickApproveService = require('../services/quickApproveService');

const router = express.Router();

// GET /api/quick-approve/:id - Show review details for approval (landing page)
router.get('/:id', async (req, res) => {
  try {
    const { token, action } = req.query;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token requerido' });
    }

    // If action is approve or deny, execute directly (one-click from email)
    if (action === 'approve' || action === 'deny') {
      try {
        const review = await QuickApproveService.execute(req.params.id, token, action);
        const message = action === 'approve'
          ? '✅ Respuesta aprobada y publicada en Google.'
          : '❌ Respuesta rechazada.';

        // Return a simple HTML page with the result
        return res.send(`
          <!DOCTYPE html>
          <html lang="es">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LynxReview - Quick Approve</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
              .card { background: white; border-radius: 12px; padding: 40px; max-width: 480px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
              .icon { font-size: 48px; margin-bottom: 16px; }
              h2 { color: #111827; margin-bottom: 8px; }
              p { color: #6b7280; line-height: 1.6; }
              .review-text { background: #f3f4f6; padding: 12px 16px; border-radius: 8px; font-style: italic; margin: 16px 0; }
              a { color: #2563eb; text-decoration: none; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">${action === 'approve' ? '✅' : '❌'}</div>
              <h2>${message}</h2>
              <p>Reseña de <strong>${review.reviewerName || 'Cliente'}</strong> (${'⭐'.repeat(review.rating)})</p>
              ${action === 'approve' ? `<div class="review-text">"${(review.publishedResponse || '').substring(0, 200)}"</div>` : ''}
              <p><a href="${process.env.FRONTEND_URL || ''}/dashboard.html">Ir al dashboard</a></p>
            </div>
          </body>
          </html>
        `);
      } catch (err) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html lang="es">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LynxReview - Error</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
              .card { background: white; border-radius: 12px; padding: 40px; max-width: 480px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
              h2 { color: #dc2626; }
              p { color: #6b7280; }
              a { color: #2563eb; text-decoration: none; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>⚠️ ${err.message}</h2>
              <p>El enlace puede haber expirado o ya fue utilizado.</p>
              <p><a href="${process.env.FRONTEND_URL || ''}/dashboard.html">Ir al dashboard</a></p>
            </div>
          </body>
          </html>
        `);
      }
    }

    // Action = 'edit' — show the review with an edit form
    if (action === 'edit') {
      const result = await QuickApproveService.validateToken(req.params.id, token);
      if (!result) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html lang="es">
          <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LynxReview - Error</title>
            <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;}.card{background:white;border-radius:12px;padding:40px;max-width:480px;text-align:center;box-shadow:0 4px 6px rgba(0,0,0,.07);}h2{color:#dc2626;}p{color:#6b7280;}a{color:#2563eb;}</style>
          </head>
          <body><div class="card"><h2>⚠️ Enlace inválido o expirado</h2><p><a href="${process.env.FRONTEND_URL || ''}/dashboard.html">Ir al dashboard</a></p></div></body>
          </html>
        `);
      }

      const { review } = result;
      return res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>LynxReview - Editar respuesta</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
            .card { background: white; border-radius: 12px; padding: 32px; max-width: 560px; width: 90%; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
            h2 { color: #111827; margin-bottom: 4px; }
            .review-box { background: #f3f4f6; padding: 12px 16px; border-radius: 8px; margin: 12px 0; }
            .review-box p { margin: 4px 0; color: #374151; }
            textarea { width: 100%; min-height: 120px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: inherit; font-size: 14px; resize: vertical; box-sizing: border-box; }
            .actions { display: flex; gap: 8px; margin-top: 16px; }
            .btn { padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 500; }
            .btn-approve { background: #22c55e; color: white; flex: 1; }
            .btn-deny { background: #9ca3af; color: white; }
            .btn:hover { opacity: 0.9; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Editar respuesta</h2>
            <div class="review-box">
              <p><strong>${review.reviewerName || 'Cliente'}</strong> — ${'⭐'.repeat(review.rating)}</p>
              <p style="font-style:italic;">"${(review.reviewText || '').substring(0, 200)}"</p>
            </div>
            <form method="POST" action="/api/quick-approve/${review._id}">
              <input type="hidden" name="token" value="${token}">
              <label style="display:block;margin-bottom:6px;font-weight:500;color:#374151;">Respuesta:</label>
              <textarea name="response">${review.proposedResponse || ''}</textarea>
              <div class="actions">
                <button type="submit" name="action" value="approve" class="btn btn-approve">✅ Aprobar y publicar</button>
                <button type="submit" name="action" value="deny" class="btn btn-deny">❌ Rechazar</button>
              </div>
            </form>
          </div>
        </body>
        </html>
      `);
    }

    // No valid action
    return res.status(400).json({ success: false, error: 'Acción requerida (approve, edit, deny)' });

  } catch (error) {
    console.error('Quick approve GET error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/quick-approve/:id - Execute approval from edit form
router.post('/:id', async (req, res) => {
  try {
    const { token, action, response } = req.body;

    if (!token || !action) {
      return res.status(400).json({ success: false, error: 'Token y acción requeridos' });
    }

    const review = await QuickApproveService.execute(req.params.id, token, action, response || null);

    const message = action === 'approve'
      ? '✅ Respuesta aprobada y publicada en Google.'
      : '❌ Respuesta rechazada.';

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>LynxReview</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
          .card { background: white; border-radius: 12px; padding: 40px; max-width: 480px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
          .icon { font-size: 48px; margin-bottom: 16px; }
          h2 { color: #111827; }
          p { color: #6b7280; }
          a { color: #2563eb; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">${action === 'approve' ? '✅' : '❌'}</div>
          <h2>${message}</h2>
          <p><a href="${process.env.FRONTEND_URL || ''}/dashboard.html">Ir al dashboard</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Quick approve POST error:', error);
    res.status(400).send(`
      <!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>LynxReview - Error</title>
        <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;}.card{background:white;border-radius:12px;padding:40px;max-width:480px;text-align:center;box-shadow:0 4px 6px rgba(0,0,0,.07);}h2{color:#dc2626;}p{color:#6b7280;}a{color:#2563eb;}</style>
      </head>
      <body><div class="card"><h2>⚠️ ${error.message}</h2><p><a href="${process.env.FRONTEND_URL || ''}/dashboard.html">Ir al dashboard</a></p></div></body>
      </html>
    `);
  }
});

module.exports = router;
