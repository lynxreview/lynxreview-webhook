const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Habilitar CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
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
  basico:  { nombre: 'Plan Basico',   precio: '19 euros/mes', color: '#4A90E2' },
  plus:    { nombre: 'Plan Plus',     precio: '39 euros/mes', color: '#7B61FF' },
  premium: { nombre: 'Plan Premium',  precio: '59 euros/mes', color: '#F5A623' }
};

// ESQUEMAS DE MONGODB

const clienteSchema = new mongoose.Schema({
  nombre: String,
  email: { type: String, unique: true },
  contrasena: String,
  nombreLocal: String,
  direccion: String,
  telefonoGoogle: String,
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
  fuente: String,
  resenaIdExterno: String,
  detectadoEn: { type: Date, default: Date.now }
});

const respuestaSchema = new mongoose.Schema({
  resenaId: mongoose.Schema.Types.ObjectId,
  clienteId: mongoose.Schema.Types.ObjectId,
  respuestaIA: String,
  respuestaEditada: String,
  estado: { type: String, enum: ['pendiente_aprobacion', 'aprobada', 'publicada', 'rechazada'], default: 'pendiente_aprobacion' },
  motivoRechazo: String,
  publicadoEn: {
    fuente: String,
    resuestaIdEnFuente: String,
    fecha: Date
  },
  createdAt: { type: Date, default: Date.now }
});

const Cliente = mongoose.model('Cliente', clienteSchema);
const Resena = mongoose.model('Resena', resenaSchema);
const Respuesta = mongoose.model('Respuesta', respuestaSchema);

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Conectado a MongoDB');
}).catch(err => {
  console.error('Error conectando a MongoDB:', err);
});

// MIDDLEWARE DE AUTENTICACION

const verificarToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.clienteId = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token invalido' });
  }
};

// SERVIR DASHBOARD

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-standalone.html'));
});

// AUTENTICACION

app.post('/auth/signup', async (req, res) => {
  try {
    const { nombre, email, contrasena, nombreLocal } = req.body;
    const clienteExistente = await Cliente.findOne({ email });
    if (clienteExistente) {
      return res.status(400).json({ error: 'El email ya esta registrado' });
    }
    const salt = await bcrypt.genSalt(10);
    const contrasenaHash = await bcrypt.hash(contrasena, salt);
    const nuevoCliente = new Cliente({ nombre, email, contrasena: contrasenaHash, nombreLocal });
    await nuevoCliente.save();
    const token = jwt.sign({ id: nuevoCliente._id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      mensaje: 'Cliente registrado exitosamente',
      token,
      cliente: { id: nuevoCliente._id, nombre: nuevoCliente.nombre, email: nuevoCliente.email }
    });
  } catch (error) {
    console.error('Error en signup:', error);
    res.status(500).json({ error: 'Error en el registro' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, contrasena } = req.body;
    const cliente = await Cliente.findOne({ email });
    if (!cliente) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    const contrasenaValida = await bcrypt.compare(contrasena, cliente.contrasena);
    if (!contrasenaValida) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    const token = jwt.sign({ id: cliente._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      mensaje: 'Login exitoso',
      token,
      cliente: { id: cliente._id, nombre: cliente.nombre, email: cliente.email, nombreLocal: cliente.nombreLocal }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error en el login' });
  }
});

// RUTAS DEL CLIENTE

app.get('/cliente/perfil', verificarToken, async (req, res) => {
  try {
    const cliente = await Cliente.findById(req.clienteId).select('-contrasena');
    res.json(cliente);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

app.put('/cliente/perfil', verificarToken, async (req, res) => {
  try {
    const { nombreLocal, direccion, telefonoGoogle } = req.body;
    const cliente = await Cliente.findByIdAndUpdate(req.clienteId, { nombreLocal, direccion, telefonoGoogle }, { new: true });
    res.json({ mensaje: 'Perfil actualizado', cliente });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

app.get('/cliente/resenas', verificarToken, async (req, res) => {
  try {
    const resenas = await Resena.find({ clienteId: req.clienteId }).sort({ detectadoEn: -1 });
    res.json(resenas);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener resenas' });
  }
});

app.get('/cliente/resena/:resenaId', verificarToken, async (req, res) => {
  try {
    const resena = await Resena.findById(req.params.resenaId);
    const respuesta = await Respuesta.findOne({ resenaId: req.params.resenaId });
    res.json({ resena, respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener resena' });
  }
});

app.get('/cliente/respuestas/pendientes', verificarToken, async (req, res) => {
  try {
    const respuestas = await Respuesta.find({ clienteId: req.clienteId, estado: 'pendiente_aprobacion' }).sort({ createdAt: -1 });
    res.json(respuestas);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener respuestas pendientes' });
  }
});

app.put('/cliente/respuesta/:respuestaId/aprobar', verificarToken, async (req, res) => {
  try {
    const respuesta = await Respuesta.findByIdAndUpdate(req.params.respuestaId, { estado: 'aprobada' }, { new: true });
    res.json({ mensaje: 'Respuesta aprobada', respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al aprobar respuesta' });
  }
});

app.put('/cliente/respuesta/:respuestaId/rechazar', verificarToken, async (req, res) => {
  try {
    const { motivo } = req.body;
    const respuesta = await Respuesta.findByIdAndUpdate(req.params.respuestaId, { estado: 'rechazada', motivoRechazo: motivo }, { new: true });
    res.json({ mensaje: 'Respuesta rechazada', respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al rechazar respuesta' });
  }
});

app.put('/cliente/respuesta/:respuestaId/editar', verificarToken, async (req, res) => {
  try {
    const { respuestaEditada } = req.body;
    const respuesta = await Respuesta.findByIdAndUpdate(req.params.respuestaId, { respuestaEditada }, { new: true });
    res.json({ mensaje: 'Respuesta editada', respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al editar respuesta' });
  }
});

app.post('/cliente/respuesta/:respuestaId/publicar', verificarToken, async (req, res) => {
  try {
    const respuesta = await Respuesta.findByIdAndUpdate(req.params.respuestaId, { estado: 'publicada', 'publicadoEn.fecha': new Date() }, { new: true });
    res.json({ mensaje: 'Respuesta publicada', respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al publicar respuesta' });
  }
});

// CHECKOUT CON STRIPE

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
    .logo { text-align: center; margin-bottom: 24px; font-size: 22px; font-weight: 700; color: #333; }
    .plan-badge { background: ${info.color}15; border: 2px solid ${info.color}; color: ${info.color}; padding: 10px 20px; border-radius: 50px; text-align: center; font-weight: 600; margin-bottom: 28px; }
    h2 { color: #333; font-size: 22px; margin-bottom: 6px; }
    p.sub { color: #888; font-size: 14px; margin-bottom: 24px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 6px; margin-top: 16px; }
    input { width: 100%; padding: 12px 16px; border: 2px solid #e8e8e8; border-radius: 8px; font-size: 15px; outline: none; }
    input:focus { border-color: ${info.color}; }
    button { width: 100%; padding: 14px; background: ${info.color}; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 24px; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .error { background: #fee; color: #c33; padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-top: 16px; display: none; }
    .seguro { text-align: center; font-size: 12px; color: #aaa; margin-top: 14px; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">LynxReview</div>
  <div class="plan-badge">${info.nombre} - ${info.precio}</div>
  <h2>Crea tu cuenta</h2>
  <p class="sub">Completa tus datos para continuar al pago</p>
  <form id="form">
    <label>Tu nombre</label>
    <input type="text" id="nombre" placeholder="Ej: Juan Garcia" required>
    <label>Email</label>
    <input type="email" id="email" placeholder="tu@email.com" required>
    <label>Nombre de tu negocio</label>
    <input type="text" id="negocio" placeholder="Ej: Restaurante La Plaza" required>
    <label>Contrasena</label>
    <input type="password" id="pass" placeholder="Minimo 6 caracteres" required minlength="6">
    <div class="error" id="error"></div>
    <button type="submit" id="btn">Continuar al pago</button>
  </form>
  <p class="seguro">Pago seguro - Cancela cuando quieras</p>
</div>
<script>
  document.getElementById('form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('btn');
    const err = document.getElementById('error');
    btn.disabled = true;
    btn.textContent = 'Procesando...';
    err.style.display = 'none';
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
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error(data.error || 'Error al procesar');
      }
    } catch(e) {
      err.textContent = e.message;
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Continuar al pago';
    }
  });
</script>
</body>
</html>`);
});

app.post('/checkout/session', async (req, res) => {
  try {
    const { nombre, email, contrasena, nombreLocal, plan } = req.body;
    if (!STRIPE_PRICES[plan]) {
      return res.status(400).json({ error: 'Plan no valido' });
    }
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
      success_url: FRONTEND_URL + '/pago-exitoso?session_id={CHECKOUT_SESSION_ID}&cid=' + cliente._id,
      cancel_url: 'https://lynxreview.com/store',
      metadata: { clienteId: cliente._id.toString(), plan }
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creando sesion de Stripe:', error);
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
      return res.redirect(FRONTEND_URL + '/?token=' + token + '&bienvenido=1');
    }
    res.redirect('https://lynxreview.com/store?error=pago_incompleto');
  } catch (error) {
    console.error('Error en pago-exitoso:', error);
    res.redirect('https://lynxreview.com/store?error=error_sistema');
  }
});

// WEBHOOK DE STRIPE

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event = req.body;
  if (STRIPE_WEBHOOK_SECRET) {
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook firma invalida:', err.message);
      return res.status(400).send('Webhook Error: ' + err.message);
    }
  }
  console.log('Webhook recibido:', event.type);
  switch(event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const clienteId = session.metadata && session.metadata.clienteId;
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

// INICIAR SERVIDOR

app.listen(PORT, () => {
  console.log('Servidor corriendo en puerto ' + PORT);
  console.log('URL: https://lynxreview-webhook.onrender.com');
});

module.exports = app;
