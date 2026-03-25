
const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

app.post('/webhook', (req, res) => {
    const event = req.body;
    console.log('📩 Webhook recibido:', event.type);
    switch(event.type) {
      case 'customer.subscription.created':
              console.log('✅ Nueva suscripción:', event.data.object.id);
              break;
      case 'customer.subscription.updated':
              console.log('🔄 Suscripción actualizada:', event.data.object.id);
              break;
      case 'customer.subscription.deleted':
              console.log('❌ Suscripción cancelada:', event.data.object.id);
              break;
    }
    res.json({received: true});
});

app.get('/', (req, res) => {
    res.json({ status: 'Servidor activo ✅', timestamp: new Date() });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📍 URL: https://lynxreview-webhook.onrender.com`);
});
