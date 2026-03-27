const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const OpenAI = require('openai');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();

// Habilitar CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-admin-secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || 'tu-clave-secreta-jwt-cambiar';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://lynxreview-webhook.onrender.com';

const STRIPE_PRICES = {
  basico:  process.env.STRIPE_PRICE_BASICO,
  plus:    process.env.STRIPE_PRICE_PLUS,
  premium: process.env.STRIPE_PRICE_PREMIUM
};

const PLAN_INFO = {
  basico:  { nombre: 'Plan Básico',   precio: '19 €/mes', color: '#4A90E2' },
  plus:    { nombre: 'Plan Plus',     precio: '39 €/mes', color: '#7B61FF' },
  premium: { nombre: 'Plan Premium',  precio: '59 €/mes', color: '#F5A623' }
};

// ═══════════════════════════════════════════════════════════════
// 📊 ESQUEMAS DE MONGODB
// ═══════════════════════════════════════════════════════════════

const clienteSchema = new mongoose.Schema({
  nombre: String,
  email: { type: String, unique: true },
  contrasena: String,
  nombreLocal: String,
  direccion: String,
  googlePlaceId: String,
  planSuscripcion: {
    tipo: String,
    estado: String,
    fechaInicio: Date,
    fechaFin: Date,
    stripeSubscriptionId: String
  },
  createdAt: { type: Date, default: Date.now }
});

const resenaSchema = new mongoose.Schema({
  clienteId: mongoose.Schema.Types.ObjectId,
  textoResena: String,
  calificacion: Number,
  autor: String,
  fecha: Date,
  fuente: { type: String, default: 'google_maps' },
  resenaIdExterno: { type: String, unique: true },
  detectadoEn: { type: Date, default: Date.now }
});

const respuestaSchema = new mongoose.Schema({
  resenaId: mongoose.Schema.Types.ObjectId,
  clienteId: mongoose.Schema.Types.ObjectId,
  respuestaIA: String,
  respuestaEditada: String,
  estado: {
    type: String,
    enum: ['pendiente_aprobacion', 'aprobada', 'publicada', 'rechazada'],
    default: 'pendiente_aprobacion'
  },
  motivoRechazo: String,
  publicadoEn: { fuente: String, fecha: Date },
  createdAt: { type: Date, default: Date.now }
});

const Cliente  = mongoose.model('Cliente',   clienteSchema);
const Resena   = mongoose.model('Resena',    resenaSchema);
const Respuesta = mongoose.model('Respuesta', respuestaSchema);

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ Conectado a MongoDB');
}).catch(err => {
  console.error('❌ Error conectando a MongoDB:', err);
});

// ═══════════════════════════════════════════════════════════════
// 🔐 MIDDLEWARES
// ═══════════════════════════════════════════════════════════════

const verificarToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token no proporcionado' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.clienteId = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

const verificarAdmin = (req, res, next) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════
// 🤖 LÓGICA IA + GOOGLE PLACES
// ═══════════════════════════════════════════════════════════════

async function obtenerResenasGoogle(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,reviews&key=${apiKey}&language=es&reviews_sort=newest`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.status !== 'OK') throw new Error('Places API: ' + data.status);
  return data.result?.reviews || [];
}

async function generarRespuestaIA(textoResena, calificacion, nombreLocal) {
  let instruccion;
  if (calificacion === 5) {
    instruccion = `Eres el gerente de "${nombreLocal}". Responde de forma cálida y agradecida esta reseña de 5 estrellas. Breve (2-3 frases), genuina y profesional. Reseña: "${textoResena}"`;
  } else if (calificacion >= 3) {
    instruccion = `Eres el gerente de "${nombreLocal}". Responde esta reseña de ${calificacion} estrellas con profesionalismo: agradece el feedback, reconoce los puntos de mejora y muestra compromiso. Máximo 4 frases. Reseña: "${textoResena}"`;
  } else {
    instruccion = `Eres el gerente de "${nombreLocal}". Responde esta reseña negativa de ${calificacion} estrellas con máxima empatía: disculpas sinceras, toma en serio el problema, ofrece solución, pide segunda oportunidad. Máximo 4 frases. Reseña: "${textoResena}"`;
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Eres un experto en gestión de reseñas de Google. Respondes SIEMPRE en el mismo idioma de la reseña. Tus respuestas son naturales, nunca genéricas.' },
      { role: 'user', content: instruccion }
    ],
    max_tokens: 300,
    temperature: 0.75
  });

  return completion.choices[0].message.content.trim();
}

async function procesarResenasCliente(cliente) {
  if (!cliente.googlePlaceId) return { nuevas: 0, error: 'Sin Google Place ID' };

  let resenasGoogle;
  try {
    resenasGoogle = await obtenerResenasGoogle(cliente.googlePlaceId);
  } catch (err) {
    return { nuevas: 0, error: err.message };
  }

  let nuevas = 0;
  for (const r of resenasGoogle) {
    const externalId = `${cliente._id}_${r.time}`;

    const existe = await Resena.findOne({ resenaIdExterno: externalId });
    if (existe) continue;

    // Guardar reseña
    const resena = new Resena({
      clienteId: cliente._id,
      textoResena: r.text || '(Sin texto)',
      calificacion: r.rating,
      autor: r.author_name,
      fecha: new Date(r.time * 1000),
      fuente: 'google_maps',
      resenaIdExterno: externalId
    });
    await resena.save();

    // Generar respuesta IA
    let textoIA = '';
    try {
      textoIA = await generarRespuestaIA(r.text || 'Reseña sin texto', r.rating, cliente.nombreLocal);
    } catch (err) {
      console.error('OpenAI error:', err.message);
      textoIA = `Gracias por tu reseña de ${r.rating} estrellas. Valoramos mucho tu opinión en ${cliente.nombreLocal}.`;
    }

    // 5 estrellas → aprobada automáticamente | <5 → pendiente de aprobación por Xavier
    const respuesta = new Respuesta({
      resenaId: resena._id,
      clienteId: cliente._id,
      respuestaIA: textoIA,
      estado: r.rating === 5 ? 'aprobada' : 'pendiente_aprobacion'
    });
    await respuesta.save();
    nuevas++;
  }

  return { nuevas };
}

// ═══════════════════════════════════════════════════════════════
// 📄 SERVIR ARCHIVOS HTML
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-standalone.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ═══════════════════════════════════════════════════════════════
// 👤 AUTENTICACIÓN
// ═══════════════════════════════════════════════════════════════

app.post('/auth/signup', async (req, res) => {
  try {
    const { nombre, email, contrasena, nombreLocal } = req.body;
    const clienteExistente = await Cliente.findOne({ email });
    if (clienteExistente) return res.status(400).json({ error: 'El email ya está registrado' });

    const salt = await bcrypt.genSalt(10);
    const contrasenaHash = await bcrypt.hash(contrasena, salt);

    const nuevoCliente = new Cliente({ nombre, email, contrasena: contrasenaHash, nombreLocal });
    await nuevoCliente.save();

    const token = jwt.sign({ id: nuevoCliente._id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      mensaje: '✅ Cliente registrado exitosamente',
      token,
      cliente: { id: nuevoCliente._id, nombre: nuevoCliente.nombre, email: nuevoCliente.email, nombreLocal: nuevoCliente.nombreLocal }
    });
  } catch (error) {
    console.error('❌ Error en signup:', error);
    res.status(500).json({ error: 'Error en el registro' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, contrasena } = req.body;
    const cliente = await Cliente.findOne({ email });
    if (!cliente) return res.status(401).json({ error: 'Credenciales inválidas' });

    const valid = await bcrypt.compare(contrasena, cliente.contrasena);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({ id: cliente._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      mensaje: '✅ Login exitoso',
      token,
      cliente: { id: cliente._id, nombre: cliente.nombre, email: cliente.email, nombreLocal: cliente.nombreLocal, googlePlaceId: cliente.googlePlaceId }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error en el login' });
  }
});

// ═══════════════════════════════════════════════════════════════
// 📊 RUTAS CLIENTE (PROTEGIDAS)
// ═══════════════════════════════════════════════════════════════

app.get('/cliente/perfil', verificarToken, async (req, res) => {
  const cliente = await Cliente.findById(req.clienteId).select('-contrasena');
  res.json(cliente);
});

app.put('/cliente/perfil', verificarToken, async (req, res) => {
  const { nombreLocal, direccion, googlePlaceId } = req.body;
  const cliente = await Cliente.findByIdAndUpdate(req.clienteId, { nombreLocal, direccion, googlePlaceId }, { new: true });
  res.json({ mensaje: '✅ Perfil actualizado', cliente });
});

// Reseñas del cliente con sus respuestas
app.get('/cliente/resenas', verificarToken, async (req, res) => {
  const resenas = await Resena.find({ clienteId: req.clienteId }).sort({ fecha: -1 });
  const result = await Promise.all(resenas.map(async (r) => {
    const respuesta = await Respuesta.findOne({ resenaId: r._id });
    return { resena: r, respuesta };
  }));
  res.json(result);
});

// Configurar Google Place ID
app.put('/cliente/google-place-id', verificarToken, async (req, res) => {
  const { googlePlaceId } = req.body;
  await Cliente.findByIdAndUpdate(req.clienteId, { googlePlaceId });
  res.json({ mensaje: '✅ Google Place ID guardado' });
});

// Disparar búsqueda de reseñas (manual)
app.post('/cliente/procesar-resenas', verificarToken, async (req, res) => {
  const cliente = await Cliente.findById(req.clienteId);
  const resultado = await procesarResenasCliente(cliente);
  res.json({ mensaje: '✅ Proceso completado', ...resultado });
});

// Respuestas pendientes del cliente
app.get('/cliente/respuestas/pendientes', verificarToken, async (req, res) => {
  const respuestas = await Respuesta.find({ clienteId: req.clienteId, estado: 'pendiente_aprobacion' }).sort({ createdAt: -1 });
  res.json(respuestas);
});

// ═══════════════════════════════════════════════════════════════
// 🛡️ PANEL ADMIN (XAVIER)
// ═══════════════════════════════════════════════════════════════

// Stats generales
app.get('/admin/stats', verificarAdmin, async (req, res) => {
  const totalClientes  = await Cliente.countDocuments({ 'planSuscripcion.estado': 'activo' });
  const totalResenas   = await Resena.countDocuments();
  const pendientes     = await Respuesta.countDocuments({ estado: 'pendiente_aprobacion' });
  const autoAprobadas  = await Respuesta.countDocuments({ estado: 'aprobada' });
  const publicadas     = await Respuesta.countDocuments({ estado: 'publicada' });
  res.json({ totalClientes, totalResenas, pendientes, autoAprobadas, publicadas });
});

// Todas las respuestas pendientes con datos de reseña y cliente
app.get('/admin/pendientes', verificarAdmin, async (req, res) => {
  const respuestas = await Respuesta.find({ estado: 'pendiente_aprobacion' }).sort({ createdAt: -1 });
  const result = await Promise.all(respuestas.map(async (r) => {
    const resena  = await Resena.findById(r.resenaId);
    const cliente = await Cliente.findById(r.clienteId).select('nombre nombreLocal email googlePlaceId planSuscripcion');
    return { respuesta: r, resena, cliente };
  }));
  res.json(result);
});

// Todas las reseñas (admin)
app.get('/admin/resenas', verificarAdmin, async (req, res) => {
  const { clienteId } = req.query;
  const filtro = clienteId ? { clienteId } : {};
  const resenas = await Resena.find(filtro).sort({ fecha: -1 }).limit(200);
  const result = await Promise.all(resenas.map(async (r) => {
    const respuesta = await Respuesta.findOne({ resenaId: r._id });
    const cliente   = await Cliente.findById(r.clienteId).select('nombreLocal');
    return { resena: r, respuesta, cliente };
  }));
  res.json(result);
});

// Listar todos los clientes
app.get('/admin/clientes', verificarAdmin, async (req, res) => {
  const clientes = await Cliente.find({}).select('-contrasena').sort({ createdAt: -1 });
  res.json(clientes);
});

// Aprobar respuesta (con posible edición del texto)
app.put('/admin/respuesta/:id/aprobar', verificarAdmin, async (req, res) => {
  const { textoFinal } = req.body;
  const update = { estado: 'aprobada' };
  if (textoFinal) update.respuestaEditada = textoFinal;
  const respuesta = await Respuesta.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json({ mensaje: '✅ Respuesta aprobada', respuesta });
});

// Rechazar respuesta
app.put('/admin/respuesta/:id/rechazar', verificarAdmin, async (req, res) => {
  const { motivo } = req.body;
  const respuesta = await Respuesta.findByIdAndUpdate(
    req.params.id,
    { estado: 'rechazada', motivoRechazo: motivo || '' },
    { new: true }
  );
  res.json({ mensaje: '✅ Respuesta rechazada', respuesta });
});

// Marcar como publicada en Google (después de copiar/pegar)
app.put('/admin/respuesta/:id/publicar', verificarAdmin, async (req, res) => {
  const respuesta = await Respuesta.findByIdAndUpdate(
    req.params.id,
    { estado: 'publicada', 'publicadoEn.fecha': new Date(), 'publicadoEn.fuente': 'google_maps' },
    { new: true }
  );
  res.json({ mensaje: '✅ Marcada como publicada', respuesta });
});

// Establecer Google Place ID a un cliente (admin)
app.put('/admin/cliente/:clienteId/place-id', verificarAdmin, async (req, res) => {
  const { googlePlaceId } = req.body;
  await Cliente.findByIdAndUpdate(req.params.clienteId, { googlePlaceId });
  res.json({ mensaje: '✅ Place ID actualizado' });
});

// Procesar reseñas de TODOS los clientes activos
app.post('/admin/procesar-todo', verificarAdmin, async (req, res) => {
  const clientes = await Cliente.find({ googlePlaceId: { $exists: true, $ne: '' } });
  const resultados = [];
  for (const c of clientes) {
    const r = await procesarResenasCliente(c);
    resultados.push({ local: c.nombreLocal, ...r });
    console.log(`Procesado ${c.nombreLocal}:`, r);
  }
  res.json({ mensaje: '✅ Procesamiento completado', clientes: clientes.length, resultados });
});

// Procesar reseñas de un cliente específico (desde admin panel)
app.post('/admin/procesar-cliente/:clienteId', verificarAdmin, async (req, res) => {
  try {
    const cliente = await Cliente.findById(req.params.clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (!cliente.googlePlaceId) return res.status(400).json({ error: 'El cliente no tiene Google Place ID configurado' });
    const resultado = await procesarResenasCliente(cliente);
    res.json({ mensaje: '✅ Procesamiento completado', ...resultado });
  } catch (err) {
    console.error('Error procesando cliente:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// 💳 CHECKOUT CON STRIPE
// ═══════════════════════════════════════════════════════════════

app.get('/checkout', (req, res) => {
  const plan = req.query.plan || 'plus';
  const info = PLAN_INFO[plan] || PLAN_INFO.plus;

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registro - LynxReview</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 40px; max-width: 440px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo span { font-size: 22px; font-weight: 700; color: #333; }
    .plan-badge { background: ${info.color}15; border: 2px solid ${info.color}; color: ${info.color}; padding: 10px 20px; border-radius: 50px; text-align: center; font-weight: 600; margin-bottom: 28px; }
    h2 { color: #333; font-size: 22px; margin-bottom: 6px; }
    p.sub { color: #888; font-size: 14px; margin-bottom: 24px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 6px; margin-top: 16px; }
    input { width: 100%; padding: 12px 16px; border: 2px solid #e8e8e8; border-radius: 8px; font-size: 15px; transition: border-color 0.2s; outline: none; }
    input:focus { border-color: ${info.color}; }
    button { width: 100%; padding: 14px; background: ${info.color}; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 24px; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .error { background: #fee; color: #c33; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-top: 16px; display: none; }
    .seguro { text-align: center; font-size: 12px; color: #aaa; margin-top: 14px; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo"><span>🔍 LynxReview</span></div>
  <div class="plan-badge">${info.nombre} — ${info.precio}</div>
  <h2>Crea tu cuenta</h2>
  <p class="sub">Completa tus datos para continuar al pago</p>
  <form id="form">
    <label>Tu nombre</label>
    <input type="text" id="nombre" placeholder="Ej: Juan García" required>
    <label>Email</label>
    <input type="email" id="email" placeholder="tu@email.com" required>
    <label>Nombre de tu negocio</label>
    <input type="text" id="negocio" placeholder="Ej: Restaurante La Plaza" required>
    <label>Contraseña</label>
    <input type="password" id="pass" placeholder="Mínimo 6 caracteres" required minlength="6">
    <div class="error" id="error"></div>
    <button type="submit" id="btn">Continuar al pago →</button>
  </form>
  <p class="seguro">🔒 Pago seguro · Cancela cuando quieras</p>
</div>
<script>
  document.getElementById('form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('btn');
    const err = document.getElementById('error');
    btn.disabled = true; btn.textContent = 'Procesando...'; err.style.display = 'none';
    try {
      const res = await fetch('/checkout/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: document.getElementById('nombre').value,
          email: document.getElementById('email').value,
          nombreLocal: document.getElementById('negocio').value,
          contrasena: document.getElementById('pass').value,
          plan: '${plan}'
        })
      });
      const data = await res.json();
      if (data.url) { window.location.href = data.url; }
      else { throw new Error(data.error || 'Error al procesar'); }
    } catch(e) {
      err.textContent = e.message; err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Continuar al pago →';
    }
  });
</script>
</body>
</html>`);
});

app.post('/checkout/session', async (req, res) => {
  try {
    const { nombre, email, contrasena, nombreLocal, plan } = req.body;
    if (!STRIPE_PRICES[plan]) return res.status(400).json({ error: 'Plan no válido' });

    let cliente = await Cliente.findOne({ email });
    if (!cliente) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(contrasena, salt);
      cliente = new Cliente({ nombre, email, contrasena: hash, nombreLocal, planSuscripcion: { tipo: plan, estado: 'pendiente' } });
      await cliente.save();
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: STRIPE_PRICES[plan], quantity: 1 }],
      success_url: `${FRONTEND_URL}/pago-exitoso?session_id={CHECKOUT_SESSION_ID}&cid=${cliente._id}`,
      cancel_url: 'https://lynxreview.com/store',
      metadata: { clienteId: cliente._id.toString(), plan }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creando sesión de Stripe:', error);
    res.status(500).json({ error: 'Error al iniciar el pago: ' + error.message });
  }
});

app.get('/pago-exitoso', async (req, res) => {
  const { session_id, cid } = req.query;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.status === 'complete' || session.payment_status === 'paid') {
      await Cliente.findByIdAndUpdate(cid, {
        'planSuscripcion.estado': 'activo',
        'planSuscripcion.stripeSubscriptionId': session.subscription,
        'planSuscripcion.fechaInicio': new Date()
      });
      const token = jwt.sign({ id: cid }, JWT_SECRET, { expiresIn: '7d' });
      return res.redirect(`${FRONTEND_URL}/?token=${token}&bienvenido=1`);
    }
    res.redirect('https://lynxreview.com/store?error=pago_incompleto');
  } catch (error) {
    res.redirect('https://lynxreview.com/store?error=error_sistema');
  }
});

// ═══════════════════════════════════════════════════════════════
// 🔔 WEBHOOK DE STRIPE
// ═══════════════════════════════════════════════════════════════

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event = req.body;
  if (STRIPE_WEBHOOK_SECRET) {
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send('Webhook Error: ' + err.message);
    }
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const clienteId = session.metadata?.clienteId;
      if (clienteId) {
        await Cliente.findByIdAndUpdate(clienteId, {
          'planSuscripcion.estado': 'activo',
          'planSuscripcion.stripeSubscriptionId': session.subscription,
          'planSuscripcion.fechaInicio': new Date()
        });
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await Cliente.findOneAndUpdate(
        { 'planSuscripcion.stripeSubscriptionId': sub.id },
        { 'planSuscripcion.estado': 'cancelado' }
      );
      break;
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════
// 🚀 INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('\n🚀 Servidor corriendo en puerto ' + PORT);
  console.log('🌐 URL: https://lynxreview-webhook.onrender.com\n');
});

module.exports = app;
