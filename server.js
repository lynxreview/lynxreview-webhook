const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const fs         = require('fs');
const OpenAI     = require('openai');
const QRCode     = require('qrcode');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const { google } = require('googleapis');
const cron       = require('node-cron');
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

const PORT                 = process.env.PORT || 3000;
const MONGODB_URI          = process.env.MONGODB_URI;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const JWT_SECRET           = process.env.JWT_SECRET || 'tu-clave-secreta-jwt-cambiar';
const FRONTEND_URL         = process.env.FRONTEND_URL || 'https://lynxreview-webhook.onrender.com';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = `${FRONTEND_URL}/auth/google/callback`;

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
  nombre:        String,
  email:         { type: String, unique: true },
  contrasena:    String,
  nombreLocal:   String,
  direccion:     String,
  googlePlaceId: String,

  // 🔑 Tokens de Google Business Profile (OAuth)
  googleAuth: {
    conectado:    { type: Boolean, default: false },
    refreshToken: String,
    accessToken:  String,
    tokenExpiry:  Date,
    accountName:  String,   // ej: accounts/123456789
    locationName: String,   // ej: accounts/123456789/locations/987654321
    googleEmail:  String
  },

  planSuscripcion: {
    tipo:                String,
    estado:              String,
    fechaInicio:         Date,
    fechaFin:            Date,
    stripeSubscriptionId: String
  },
  createdAt: { type: Date, default: Date.now }
});

const resenaSchema = new mongoose.Schema({
  clienteId:       mongoose.Schema.Types.ObjectId,
  textoResena:     String,
  calificacion:    Number,
  autor:           String,
  fecha:           Date,
  fuente:          { type: String, default: 'google_maps' },
  resenaIdExterno: { type: String, unique: true },
  detectadoEn:     { type: Date, default: Date.now },
  // Nombre de recurso de la reseña en Google Business Profile API (para poder responder)
  googleReviewName: String
});

const respuestaSchema = new mongoose.Schema({
  resenaId:        mongoose.Schema.Types.ObjectId,
  clienteId:       mongoose.Schema.Types.ObjectId,
  respuestaIA:     String,
  respuestaEditada: String,
  estado: {
    type: String,
    enum: ['pendiente_aprobacion', 'aprobada', 'publicada', 'rechazada'],
    default: 'pendiente_aprobacion'
  },
  motivoRechazo: String,
  publicadoEn:   { fuente: String, fecha: Date },
  createdAt:     { type: Date, default: Date.now }
});

const qrSchema = new mongoose.Schema({
  codigo:     { type: String, unique: true, required: true },
  clienteId:  mongoose.Schema.Types.ObjectId,
  urlDestino: String,
  datosQR:    String,
  scans:      { type: Number, default: 0 },
  ultimoScan: Date,
  estado:     { type: String, enum: ['activo', 'inactivo'], default: 'activo' },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now }
});

const Cliente   = mongoose.model('Cliente',   clienteSchema);
const Resena    = mongoose.model('Resena',    resenaSchema);
const Respuesta = mongoose.model('Respuesta', respuestaSchema);
const QR        = mongoose.model('QR',        qrSchema);

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
// 🔗 GOOGLE BUSINESS PROFILE — OAUTH Y API
// ═══════════════════════════════════════════════════════════════

function crearOAuth2Client(tokens = null) {
  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  if (tokens) oauth2.setCredentials(tokens);
  return oauth2;
}

async function obtenerAccessTokenFresco(cliente) {
  const oauth2 = crearOAuth2Client({ refresh_token: cliente.googleRefreshToken });
  try {
    const { credentials } = await oauth2.refreshAccessToken();
    // Persistir el nuevo access token
    await Cliente.findByIdAndUpdate(cliente._id, {
      'googleAuth.accessToken': credentials.access_token,
      'googleAuth.tokenExpiry': new Date(credentials.expiry_date)
    });
    return credentials.access_token;
  } catch (err) {
    console.error(`[GOOGLE AUTH] Error refrescando token para ${cliente.nombreLocal}:`, err.message);
    // Marcar como desconectado si el token es inválido
    if (err.message?.includes('invalid_grant')) {
      await Cliente.findByIdAndUpdate(cliente._id, { 'googleRefreshToken': null });
    }
    throw err;
  }
}

async function obtenerResenasBusinessAPI(cliente) {
  const accessToken = await obtenerAccessTokenFresco(cliente);
  const locationName = cliente.googleAuth.locationName;
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=50`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Business API: ' + JSON.stringify(data.error));
  return data.reviews || [];
}

// Convertir estrellas de texto (API Business) a número
function starRatingToNumber(starRating) {
  const map = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 };
  return map[starRating] || 3;
}

async function publicarRespuestaGoogle(cliente, googleReviewName, textoRespuesta) {
  if (!!!cliente.googleRefreshToken || !cliente.googleRefreshToken) {
    return { ok: false, error: 'Cliente no conectado a Google Business' };
  }
  try {
    const accessToken = await obtenerAccessTokenFresco(cliente);
    const url = `https://mybusiness.googleapis.com/v4/${googleReviewName}/reply`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: textoRespuesta })
    });
    if (!response.ok) {
      const err = await response.json();
      console.error('[GOOGLE PUBLISH] Error:', JSON.stringify(err));
      return { ok: false, error: err.error?.message || 'Error publicando en Google' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[GOOGLE PUBLISH] Exception:', err.message);
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// 🤖 LÓGICA IA + GOOGLE
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
  const tieneOAuth   = !!cliente.googleRefreshToken && cliente.googleAuth?.locationName;
  const tienePlaceId = !!cliente.googlePlaceId;

  if (!tieneOAuth && !tienePlaceId) {
    return { nuevas: 0, error: 'Sin configuración de Google' };
  }

  let resenasNormalizadas = [];
  let modoAPI = false;

  // ── Intentar primero con Business Profile API (OAuth) ──
  if (tieneOAuth) {
    try {
      const rawReviews = await obtenerResenasBusinessAPI(cliente);
      resenasNormalizadas = rawReviews.map(r => ({
        text:             r.comment || '',
        rating:           starRatingToNumber(r.starRating),
        author_name:      r.reviewer?.displayName || 'Anónimo',
        time:             Math.floor(new Date(r.createTime).getTime() / 1000),
        googleReviewName: r.name
      }));
      modoAPI = true;
      console.log(`[SYNC] ${cliente.nombreLocal}: usando Business Profile API (${resenasNormalizadas.length} reseñas)`);
    } catch (err) {
      console.error(`[SYNC] ${cliente.nombreLocal}: error Business API, fallback a Places API:`, err.message);
    }
  }

  // ── Fallback a Google Places API (sólo lectura) ──
  if (!modoAPI && tienePlaceId) {
    try {
      const rawReviews = await obtenerResenasGoogle(cliente.googlePlaceId);
      resenasNormalizadas = rawReviews.map(r => ({
        text:             r.text || '',
        rating:           r.rating,
        author_name:      r.author_name,
        time:             r.time,
        googleReviewName: null
      }));
      console.log(`[SYNC] ${cliente.nombreLocal}: usando Places API (${resenasNormalizadas.length} reseñas)`);
    } catch (err) {
      return { nuevas: 0, error: err.message };
    }
  }

  let nuevas = 0;
  for (const r of resenasNormalizadas) {
    const externalId = `${cliente._id}_${r.time}`;
    const existe = await Resena.findOne({ resenaIdExterno: externalId });

    if (existe) {
      if (r.googleReviewName && !existe.googleReviewName) {
        await Resena.findByIdAndUpdate(existe._id, { googleReviewName: r.googleReviewName });
      }
      continue;
    }

    const resena = new Resena({
      clienteId:        cliente._id,
      textoResena:      r.text || '(Sin texto)',
      calificacion:     r.rating,
      autor:            r.author_name,
      fecha:            new Date(r.time * 1000),
      fuente:           'google_maps',
      resenaIdExterno:  externalId,
      googleReviewName: r.googleReviewName || null
    });
    await resena.save();

    let textoIA = '';
    try {
      textoIA = await generarRespuestaIA(r.text || 'Reseña sin texto', r.rating, cliente.nombreLocal);
    } catch (err) {
      console.error('[IA] Error generando respuesta:', err.message);
      textoIA = `Gracias por tu reseña. Valoramos mucho tu opinión en ${cliente.nombreLocal}.`;
    }

    let estadoInicial = r.rating === 5 ? 'aprobada' : 'pendiente_aprobacion';
    let publicadoAuto = false;

    if (modoAPI && r.rating === 5 && r.googleReviewName) {
      const resultado = await publicarRespuestaGoogle(cliente, r.googleReviewName, textoIA);
      if (resultado.ok) {
        estadoInicial = 'publicada';
        publicadoAuto = true;
      }
    }

    const respuesta = new Respuesta({
      resenaId:    resena._id,
      clienteId:   cliente._id,
      respuestaIA: textoIA,
      estado:      estadoInicial,
      ...(publicadoAuto ? { publicadoEn: { fuente: 'google_api_auto', fecha: new Date() } } : {})
    });
    await respuesta.save();
    nuevas++;
  }

  return { nuevas };
}

// ═══════════════════════════════════════════════════════════════
// 🏥 HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// 📄 SERVIR ARCHIVOS HTML
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-standalone.html'));
});

app.get('/dashboard-standalone.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-standalone.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Página de setup de Google para el cliente
app.get('/setup', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'setup.html'), 'utf8');
    const mapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
    res.send(html.replace('PLACEHOLDER_MAPS_KEY', mapsKey));
  } catch (e) {
    res.status(500).send('Error loading setup page');
  }
});

// ═══════════════════════════════════════════════════════════════
// 🔗 GOOGLE BUSINESS PROFILE — RUTAS OAUTH
// ═══════════════════════════════════════════════════════════════

// Iniciar flujo OAuth
app.get('/auth/google', (req, res) => {
  const { token, placeId, businessName } = req.query;
  if (!token) return res.status(400).send('Token de setup requerido');

  try {
    jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(400).send('Token inválido o expirado. Solicita un nuevo link.');
  }

  const stateData = JSON.stringify({ token, placeId: placeId || '', businessName: businessName || '' });

  const oauth2 = crearOAuth2Client();
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/business.manage',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    state: stateData,
    prompt: 'consent'
  });

  res.redirect(authUrl);
});

// Callback de Google OAuth
app.get('/auth/google/callback', async (req, res) => {
  const { code, state: stateRaw, error } = req.query;

  if (error) {
    return res.send(htmlSetupResult(false, 'Autenticación cancelada. Vuelve al link de setup y prueba de nuevo.'));
  }

  if (!code || !stateRaw) {
    return res.send(htmlSetupResult(false, 'Parámetros inválidos en el callback.'));
  }

  let setupToken, placeId, businessName;
  try {
    const stateData = JSON.parse(stateRaw);
    setupToken = stateData.token;
    placeId = stateData.placeId || '';
    businessName = stateData.businessName || '';
  } catch (e) {
    setupToken = stateRaw;
    placeId = '';
    businessName = '';
  }

  let clienteId;
  try {
    const decoded = jwt.verify(setupToken, JWT_SECRET);
    clienteId = decoded.clienteId;
    if (!clienteId || decoded.purpose !== 'google_setup') throw new Error('Token de propósito incorrecto');
  } catch (e) {
    return res.send(htmlSetupResult(false, 'Token de setup inválido o expirado.'));
  }

  try {
    const oauth2 = crearOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    let accountName = '';
    let locationName = '';
    let googleEmail = '';

    try {
      const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
      const userInfo = await oauth2Api.userinfo.get();
      googleEmail = userInfo.data.email || '';

      const accountsRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` }
      });
      const accountsData = await accountsRes.json();
      const firstAccount = accountsData.accounts?.[0];

      if (firstAccount) {
        accountName = firstAccount.name;
        const locationsRes = await fetch(`https://mybusiness.googleapis.com/v4/${accountName}/locations?pageSize=10`, {
          headers: { 'Authorization': `Bearer ${tokens.access_token}` }
        });
        const locationsData = await locationsRes.json();
        const firstLocation = locationsData.locations?.[0];
        if (firstLocation) locationName = firstLocation.name;
      }
    } catch (apiErr) {
      console.error('[OAUTH CALLBACK] Error obteniendo cuenta/location:', apiErr.message);
    }

    // Guardar tokens y datos en MongoDB
    await Cliente.findByIdAndUpdate(clienteId, {
      'googleAuth.conectado':    true,
      'googleAuth.refreshToken': tokens.refresh_token,
      'googleAuth.accessToken':  tokens.access_token,
      'googleAuth.tokenExpiry':  tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      'googleAuth.accountName':  accountName,
      'googleAuth.locationName': locationName,
      'googleAuth.googleEmail':  googleEmail,
      googlePlaceId:             placeId
    });

    const cliente = await Cliente.findById(clienteId).select('nombreLocal');
    console.log(`[OAUTH] ✅ Google conectado para: ${cliente?.nombreLocal} (${googleEmail})`);

    return res.send(htmlSetupResult(true, null, cliente?.nombreLocal, googleEmail));

  } catch (err) {
    console.error('[OAUTH CALLBACK] Error:', err.message);
    return res.send(htmlSetupResult(false, 'Error al procesar la autenticación: ' + err.message));
  }
});

function htmlSetupResult(success, errorMsg, nombreLocal = '', email = '') {
  if (success) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LynxReview - Conexión exitosa</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Segoe UI',sans-serif; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
    .card { background:white; border-radius:16px; padding:48px 40px; max-width:460px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.2); text-align:center; }
    .icon { font-size:64px; margin-bottom:20px; }
    h1 { color:#1a1a2e; font-size:24px; margin-bottom:12px; }
    p { color:#666; line-height:1.6; margin-bottom:8px; }
    .badge { display:inline-block; background:#d1fae5; color:#065f46; border-radius:50px; padding:6px 18px; font-size:13px; font-weight:600; margin:16px 0; }
    .note { font-size:13px; color:#999; margin-top:20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎉</div>
    <h1>¡Google Business conectado!</h1>
    <div class="badge">✅ ${nombreLocal || 'Tu negocio'}</div>
    <p>Tu perfil de Google Business ha sido vinculado correctamente con LynxReview.</p>
    <p>A partir de ahora gestionaremos y responderemos tus reseñas <strong>automáticamente</strong>.</p>
    ${email ? `<p class="note">Cuenta Google: ${email}</p>` : ''}
    <p class="note">Puedes cerrar esta ventana.</p>
  </div>
</body>
</html>`;
  } else {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LynxReview - Error</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Segoe UI',sans-serif; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
    .card { background:white; border-radius:16px; padding:48px 40px; max-width:460px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.2); text-align:center; }
    .icon { font-size:64px; margin-bottom:20px; }
    h1 { color:#1a1a2e; font-size:22px; margin-bottom:12px; }
    p { color:#666; line-height:1.6; }
    .error { background:#fee2e2; color:#991b1b; border-radius:8px; padding:12px 16px; margin:16px 0; font-size:14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Error al conectar Google</h1>
    <div class="error">${errorMsg}</div>
    <p>Por favor contacta a LynxReview para recibir un nuevo link de configuración.</p>
  </div>
</body>
</html>`;
  }
}

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
      cliente: {
        id: cliente._id,
        nombre: cliente.nombre,
        email: cliente.email,
        nombreLocal: cliente.nombreLocal,
        googlePlaceId: cliente.googlePlaceId,
        googleConectado: !!cliente.googleRefreshToken || false
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error en el login' });
  }
});

// ═══════════════════════════════════════════════════════════════
// 📊 RUTAS CLIENTE (PROTEGIDAS)
// ═══════════════════════════════════════════════════════════════

app.get('/cliente/perfil', verificarToken, async (req, res) => {
  const cliente = await Cliente.findById(req.clienteId).select('-contrasena -googleAuth.refreshToken -googleAuth.accessToken');
  res.json(cliente);
});

app.put('/cliente/perfil', verificarToken, async (req, res) => {
  const { nombreLocal, direccion, googlePlaceId } = req.body;
  const cliente = await Cliente.findByIdAndUpdate(req.clienteId, { nombreLocal, direccion, googlePlaceId }, { new: true });
  res.json({ mensaje: '✅ Perfil actualizado', cliente });
});

app.get('/cliente/resenas', verificarToken, async (req, res) => {
  const resenas = await Resena.find({ clienteId: req.clienteId }).sort({ fecha: -1 });
  const result = await Promise.all(resenas.map(async (r) => {
    const respuesta = await Respuesta.findOne({ resenaId: r._id });
    return { resena: r, respuesta };
  }));
  res.json(result);
});

app.put('/cliente/google-place-id', verificarToken, async (req, res) => {
  const { googlePlaceId } = req.body;
  await Cliente.findByIdAndUpdate(req.clienteId, { googlePlaceId });
  res.json({ mensaje: '✅ Google Place ID guardado' });
});

app.post('/cliente/procesar-resenas', verificarToken, async (req, res) => {
  const cliente = await Cliente.findById(req.clienteId);
  const resultado = await procesarResenasCliente(cliente);
  res.json({ mensaje: '✅ Proceso completado', ...resultado });
});

app.get('/cliente/respuestas/pendientes', verificarToken, async (req, res) => {
  const respuestas = await Respuesta.find({ clienteId: req.clienteId, estado: 'pendiente_aprobacion' }).sort({ createdAt: -1 });
  res.json(respuestas);
});

// ═══════════════════════════════════════════════════════════════
// 🛡️ PANEL ADMIN (XAVIER)
// ═══════════════════════════════════════════════════════════════

app.get('/admin/stats', verificarAdmin, async (req, res) => {
  const totalClientes = await Cliente.countDocuments({ 'planSuscripcion.estado': 'activo' });
  const googleConectados = await Cliente.countDocuments({ 'googleAuth.conectado': true });
  const totalResenas   = await Resena.countDocuments();
  const pendientes     = await Respuesta.countDocuments({ estado: 'pendiente_aprobacion' });
  const autoAprobadas  = await Respuesta.countDocuments({ estado: 'aprobada' });
  const publicadas     = await Respuesta.countDocuments({ estado: 'publicada' });
  res.json({ totalClientes, googleConectados, totalResenas, pendientes, autoAprobadas, publicadas });
});

app.get('/admin/pendientes', verificarAdmin, async (req, res) => {
  const respuestas = await Respuesta.find({ estado: 'pendiente_aprobacion' }).sort({ createdAt: -1 });
  const result = await Promise.all(respuestas.map(async (r) => {
    const resena  = await Resena.findById(r.resenaId);
    const cliente = await Cliente.findById(r.clienteId).select('nombre nombreLocal email googlePlaceId planSuscripcion googleAuth.conectado googleAuth.locationName');
    return { respuesta: r, resena, cliente };
  }));
  res.json(result);
});

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

app.get('/admin/clientes', verificarAdmin, async (req, res) => {
  const clientes = await Cliente.find({}).select('-contrasena -googleAuth.refreshToken -googleAuth.accessToken').sort({ createdAt: -1 });
  res.json(clientes);
});

// Aprobar respuesta — si el cliente tiene Google conectado, publicar automáticamente
app.put('/admin/respuesta/:id/aprobar', verificarAdmin, async (req, res) => {
  const { textoFinal } = req.body;

  const respuesta = await Respuesta.findById(req.params.id);
  if (!respuesta) return res.status(404).json({ error: 'Respuesta no encontrada' });

  const resena  = await Resena.findById(respuesta.resenaId);
  const cliente = await Cliente.findById(respuesta.clienteId);

  const update = { estado: 'aprobada' };
  if (textoFinal) update.respuestaEditada = textoFinal;

  let publicado = false;
  let errorPublicacion = null;

  // Intentar auto-publicar si el cliente tiene Google conectado
  if (cliente?.googleAuth?.conectado && resena?.googleReviewName) {
    const texto = textoFinal || respuesta.respuestaIA;
    const resultado = await publicarRespuestaGoogle(cliente, resena.googleReviewName, texto);
    if (resultado.ok) {
      update.estado = 'publicada';
      update['publicadoEn.fecha'] = new Date();
      update['publicadoEn.fuente'] = 'google_api';
      publicado = true;
      console.log(`[ADMIN APPROVE] Publicado en Google para ${cliente.nombreLocal}`);
    } else {
      errorPublicacion = resultado.error;
      console.error(`[ADMIN APPROVE] Error publicando: ${errorPublicacion}`);
    }
  }

  const respuestaActualizada = await Respuesta.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json({
    mensaje: publicado ? '✅ Aprobada y publicada en Google' : '✅ Respuesta aprobada',
    respuesta: respuestaActualizada,
    publicado,
    errorPublicacion
  });
});

app.put('/admin/respuesta/:id/rechazar', verificarAdmin, async (req, res) => {
  const { motivo } = req.body;
  const respuesta = await Respuesta.findByIdAndUpdate(
    req.params.id,
    { estado: 'rechazada', motivoRechazo: motivo || '' },
    { new: true }
  );
  res.json({ mensaje: '✅ Respuesta rechazada', respuesta });
});

app.put('/admin/respuesta/:id/publicar', verificarAdmin, async (req, res) => {
  const respuesta = await Respuesta.findById(req.params.id);
  if (!respuesta) return res.status(404).json({ error: 'No encontrada' });

  const resena  = await Resena.findById(respuesta.resenaId);
  const cliente = await Cliente.findById(respuesta.clienteId);

  let publicadoGoogle = false;
  let errorGoogle = null;

  // Intentar publicar via API si disponible
  if (cliente?.googleAuth?.conectado && resena?.googleReviewName) {
    const texto = respuesta.respuestaEditada || respuesta.respuestaIA;
    const resultado = await publicarRespuestaGoogle(cliente, resena.googleReviewName, texto);
    if (resultado.ok) publicadoGoogle = true;
    else errorGoogle = resultado.error;
  }

  const updated = await Respuesta.findByIdAndUpdate(
    req.params.id,
    { estado: 'publicada', 'publicadoEn.fecha': new Date(), 'publicadoEn.fuente': publicadoGoogle ? 'google_api' : 'manual' },
    { new: true }
  );
  res.json({ mensaje: '✅ Marcada como publicada', respuesta: updated, publicadoGoogle, errorGoogle });
});

app.put('/admin/cliente/:clienteId/place-id', verificarAdmin, async (req, res) => {
  const { googlePlaceId } = req.body;
  await Cliente.findByIdAndUpdate(req.params.clienteId, { googlePlaceId });
  res.json({ mensaje: '✅ Place ID actualizado' });
});

// Actualizar datos de Google Business (accountName y locationName manual)
app.put('/admin/cliente/:clienteId/google-location', verificarAdmin, async (req, res) => {
  const { accountName, locationName } = req.body;
  await Cliente.findByIdAndUpdate(req.params.clienteId, {
    'googleAuth.accountName': accountName,
    'googleAuth.locationName': locationName
  });
  res.json({ mensaje: '✅ Google Business location actualizado' });
});

// Desconectar Google de un cliente
app.delete('/admin/cliente/:clienteId/google', verificarAdmin, async (req, res) => {
  await Cliente.findByIdAndUpdate(req.params.clienteId, {
    'googleRefreshToken': null,
    'googleAuth.refreshToken': null,
    'googleAuth.accessToken': null,
    'googleAuth.accountName': null,
    'googleAuth.locationName': null
  });
  res.json({ mensaje: '✅ Google Business desconectado' });
});

// Generar link de setup para que el cliente conecte su Google Business
app.post('/admin/cliente/:clienteId/setup-link', verificarAdmin, async (req, res) => {
  const { clienteId } = req.params;
  const cliente = await Cliente.findById(clienteId).select('nombreLocal email');
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  // Token especial de setup (7 días de validez)
  const setupToken = jwt.sign(
    { clienteId, purpose: 'google_setup' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  const setupUrl = `${FRONTEND_URL}/setup?token=${setupToken}`;

  // Opcional: enviar por email si hay transporter configurado
  let emailEnviado = false;
  if (process.env.EMAIL_USER && cliente.email) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: process.env.EMAIL_PORT || 587,
        secure: false,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
      });

      await transporter.sendMail({
        from: `"LynxReview" <${process.env.EMAIL_USER}>`,
        to: cliente.email,
        subject: '🔗 Conecta tu Google Business con LynxReview',
        html: `
          <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
            <h2 style="color:#667eea">Hola ${cliente.nombreLocal} 👋</h2>
            <p>Para que podamos gestionar y responder tus reseñas de Google automáticamente, necesitamos que conectes tu cuenta de Google Business.</p>
            <p>Solo tardará 1 minuto:</p>
            <a href="${setupUrl}" style="display:inline-block;background:#667eea;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0">
              Conectar Google Business →
            </a>
            <p style="color:#999;font-size:13px">Este link es válido durante 7 días.</p>
          </div>
        `
      });
      emailEnviado = true;
    } catch (emailErr) {
      console.error('[SETUP EMAIL] Error:', emailErr.message);
    }
  }

  res.json({ mensaje: '✅ Link generado', setupUrl, emailEnviado });
});

app.post('/admin/procesar-todo', verificarAdmin, async (req, res) => {
  const clientes = await Cliente.find({
    $or: [
      { googlePlaceId: { $exists: true, $ne: '' } },
      { 'googleAuth.conectado': true }
    ]
  });
  const resultados = [];
  for (const c of clientes) {
    const r = await procesarResenasCliente(c);
    resultados.push({ local: c.nombreLocal, ...r });
    console.log(`Procesado ${c.nombreLocal}:`, r);
  }
  res.json({ mensaje: '✅ Procesamiento completado', clientes: clientes.length, resultados });
});

app.post('/admin/procesar-cliente/:clienteId', verificarAdmin, async (req, res) => {
  try {
    const cliente = await Cliente.findById(req.params.clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const resultado = await procesarResenasCliente(cliente);
    res.json({ mensaje: '✅ Procesamiento completado', ...resultado });
  } catch (err) {
    console.error('Error procesando cliente:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// 🎯 QR GENERATOR
// ═══════════════════════════════════════════════════════════════

app.post('/admin/qr/generar', verificarAdmin, async (req, res) => {
  try {
    const codigo = 'QR_' + Math.random().toString(36).substr(2, 9).toUpperCase();
    const urlQR = `${FRONTEND_URL}/qr/${codigo}`;
    const datosQR = await QRCode.toDataURL(urlQR);
    const nuevoQR = new QR({ codigo, datosQR, estado: 'activo' });
    await nuevoQR.save();
    res.json({ mensaje: '✅ Código QR generado', qr: nuevoQR });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/qrs', verificarAdmin, async (req, res) => {
  try {
    const qrs = await QR.find({}).sort({ createdAt: -1 }).populate('clienteId', 'nombreLocal email');
    res.json(qrs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/qr/:id', verificarAdmin, async (req, res) => {
  try {
    const qr = await QR.findById(req.params.id).populate('clienteId', 'nombreLocal email');
    if (!qr) return res.status(404).json({ error: 'QR no encontrado' });
    res.json(qr);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/admin/qr/:id', verificarAdmin, async (req, res) => {
  try {
    const { clienteId, urlDestino } = req.body;
    const qr = await QR.findByIdAndUpdate(
      req.params.id,
      { clienteId, urlDestino, updatedAt: new Date() },
      { new: true }
    );
    res.status(200).json({
      mensaje: '✅ QR actualizado',
      qr: { _id: qr._id, codigo: qr.codigo, urlDestino: qr.urlDestino, scans: qr.scans, updatedAt: qr.updatedAt }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/qr/:id', verificarAdmin, async (req, res) => {
  try {
    await QR.findByIdAndDelete(req.params.id);
    res.json({ mensaje: '✅ QR eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/qr/:codigo', async (req, res) => {
  try {
    const qr = await QR.findOne({ codigo: req.params.codigo });
    if (!qr || !qr.urlDestino) return res.status(404).send('QR no encontrado o sin URL configurada');
    await QR.findByIdAndUpdate(qr._id, { scans: qr.scans + 1, ultimoScan: new Date() });
    res.redirect(qr.urlDestino);
  } catch (err) {
    res.status(500).send('Error procesando QR: ' + err.message);
  }
});

app.get('/admin/qr/:id/stats', verificarAdmin, async (req, res) => {
  try {
    const qr = await QR.findById(req.params.id).populate('clienteId', 'nombreLocal');
    if (!qr) return res.status(404).json({ error: 'QR no encontrado' });
    res.json({ codigo: qr.codigo, cliente: qr.clienteId?.nombreLocal || 'Sin asignar', totalScans: qr.scans, ultimoScan: qr.ultimoScan, estado: qr.estado, createdAt: qr.createdAt });
  } catch (err) {
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
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Segoe UI',sans-serif; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
    .card { background:white; border-radius:16px; padding:40px; max-width:440px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.2); }
    .logo { text-align:center; margin-bottom:24px; }
    .logo span { font-size:22px; font-weight:700; color:#333; }
    .plan-badge { background:${info.color}15; border:2px solid ${info.color}; color:${info.color}; padding:10px 20px; border-radius:50px; text-align:center; font-weight:600; margin-bottom:28px; }
    h2 { color:#333; font-size:22px; margin-bottom:6px; }
    p.sub { color:#888; font-size:14px; margin-bottom:24px; }
    label { display:block; font-size:13px; font-weight:600; color:#555; margin-bottom:6px; margin-top:16px; }
    input { width:100%; padding:12px 16px; border:2px solid #e8e8e8; border-radius:8px; font-size:15px; transition:border-color 0.2s; outline:none; }
    input:focus { border-color:${info.color}; }
    button { width:100%; padding:14px; background:${info.color}; color:white; border:none; border-radius:8px; font-size:16px; font-weight:700; cursor:pointer; margin-top:24px; }
    button:disabled { opacity:0.6; cursor:not-allowed; }
    .error { background:#fee; color:#c33; padding:10px 14px; border-radius:8px; font-size:14px; margin-top:16px; display:none; }
    .seguro { text-align:center; font-size:12px; color:#aaa; margin-top:14px; }
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
// ⏰ CRON JOB — SINCRONIZACIÓN AUTOMÁTICA CADA 6 HORAS
// ═══════════════════════════════════════════════════════════════

async function sincronizarTodosLosClientes() {
  try {
    console.log('[CRON] 🔄 Iniciando sincronización automática de reseñas...');
    const clientes = await Cliente.find({
      $or: [
        { googlePlaceId: { $exists: true, $ne: '' } },
        { 'googleAuth.conectado': true }
      ]
    });

    let totalNuevas = 0;
    for (const c of clientes) {
      try {
        const r = await procesarResenasCliente(c);
        if (r.nuevas > 0) {
          console.log(`[CRON] ${c.nombreLocal}: ${r.nuevas} nuevas reseñas`);
          totalNuevas += r.nuevas;
        }
      } catch (err) {
        console.error(`[CRON] Error en ${c.nombreLocal}:`, err.message);
      }
    }

    console.log(`[CRON] ✅ Sincronización completada. ${clientes.length} clientes, ${totalNuevas} nuevas reseñas.`);
  } catch (err) {
    console.error('[CRON] Error general:', err.message);
  }
}

// Ejecutar cada 6 horas (00:00, 06:00, 12:00, 18:00)
cron.schedule('0 0,6,12,18 * * *', sincronizarTodosLosClientes);

// ═══════════════════════════════════════════════════════════════
// 🚀 INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('\n🚀 Servidor corriendo en puerto ' + PORT);
  console.log('🌐 URL: ' + FRONTEND_URL + '\n');
  console.log('⏰ Cron job de sincronización activado (cada 6h)\n');

  // Keep-alive ping cada 14 minutos (Render Free Tier)
  setInterval(() => {
    const https = require('https');
    https.get(FRONTEND_URL + '/health', () => {
      console.log(`[KEEP-ALIVE] ${new Date().toLocaleTimeString()}`);
    }).on('error', (err) => {
      console.log('[KEEP-ALIVE] Error:', err.message);
    });
  }, 14 * 60 * 1000);
});

// ===== OAUTH2 GOOGLE BUSINESS PROFILE =====
// Autorización y gestión de acceso a Google Business Profile

// Ruta: Iniciar autenticación OAuth2
app.post('/api/auth/google-auth', async (req, res) => {
    try {
          const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
          const REDIRECT_URI = `${process.env.FRONTEND_URL}/api/auth/google/callback`;
          const SCOPES = [
                  'https://www.googleapis.com/auth/business.manage',
                  'https://www.googleapis.com/auth/drive'
                ].join(' ');

          const state = Math.random().toString(36).substring(7);
          req.session = req.session || {};
          req.session.oauth_state = state;

          const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          authUrl.searchParams.append('client_id', CLIENT_ID);
          authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
          authUrl.searchParams.append('response_type', 'code');
          authUrl.searchParams.append('scope', SCOPES);
          authUrl.searchParams.append('state', state);
          authUrl.searchParams.append('access_type', 'offline');
          authUrl.searchParams.append('prompt', 'consent');

          res.json({ authUrl: authUrl.toString() });
    } catch (error) {
          console.error('Error OAuth2:', error);
          res.status(500).json({ error: 'Error iniciando autenticación' });
    }
});

// Ruta: Callback de Google OAuth2
app.get('/api/auth/google/callback', async (req, res) => {
    try {
          const { code, state } = req.query;

          if (!state || state !== req.session?.oauth_state) {
                  return res.status(400).json({ error: 'Invalid state parameter' });
          }

          // Intercambiar código por tokens
          const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                            client_id: process.env.GOOGLE_CLIENT_ID,
                            client_secret: process.env.GOOGLE_CLIENT_SECRET,
                            code,
                            grant_type: 'authorization_code',
                            redirect_uri: `${process.env.FRONTEND_URL}/api/auth/google/callback`,
                  }),
          });

          const tokens = await tokenResponse.json();
          if (!tokens.access_token) {
                  throw new Error('No access token received');
          }

          // Obtener información del usuario
          const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                  headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          const profile = await profileResponse.json();

          // Guardar cliente y tokens en BD
          let cliente = await ClienteSchema.findOne({ email: profile.email });
          if (!cliente) {
                  cliente = new ClienteSchema({
                            nombre: profile.name,
                            email: profile.email,
                            googleId: profile.id,
                  });
          }

          cliente.googleAccessToken = tokens.access_token;
          cliente.googleRefreshToken = tokens.refresh_token || cliente.googleRefreshToken;
          cliente.tokenExpiresAt = new Date(Date.now() + (tokens.expires_in * 1000));
          await cliente.save();

          // Crear JWT del cliente
          const jwtToken = jwt.sign(
            { clienteId: cliente._id, email: cliente.email },
                  process.env.JWT_SECRET,
            { expiresIn: '30d' }
                );

          res.redirect(`${process.env.FRONTEND_URL}/dashboard?token=${jwtToken}&success=true`);
    } catch (error) {
          console.error('OAuth callback error:', error);
          res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=auth_failed`);
    }
});

// Ruta: Verificar estado de conexión Google
app.get('/api/auth/google-status', verificarToken, async (req, res) => {
    try {
          const cliente = await ClienteSchema.findById(req.clienteId);

          if (!cliente || !cliente.googleAccessToken) {
                  return res.json({ connected: false });
          }

          // Verificar si token necesita refresh
          if (cliente.tokenExpiresAt < new Date()) {
                  const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                        client_id: process.env.GOOGLE_CLIENT_ID,
                                        client_secret: process.env.GOOGLE_CLIENT_SECRET,
                                        refresh_token: cliente.googleRefreshToken,
                                        grant_type: 'refresh_token',
                            }),
                  });

                  const newTokens = await refreshResponse.json();
                  cliente.googleAccessToken = newTokens.access_token;
                  cliente.tokenExpiresAt = new Date(Date.now() + (newTokens.expires_in * 1000));
                  await cliente.save();
          }

          res.json({
                  connected: true,
                  email: cliente.email,
                  lastSync: cliente.lastSyncTime,
          });
    } catch (error) {
          console.error('Status check error:', error);
          res.json({ connected: false });
    }
});

// Ruta: Desconectar Google
app.post('/api/auth/disconnect-google', verificarToken, async (req, res) => {
    try {
          const cliente = await ClienteSchema.findById(req.clienteId);

          if (cliente?.googleAccessToken) {
                  // Revocar token
                  await fetch('https://oauth2.googleapis.com/revoke', {
                            method: 'POST',
                            body: new URLSearchParams({ token: cliente.googleAccessToken }),
                  }).catch(() => {});
          }

          cliente.googleAccessToken = null;
          cliente.googleRefreshToken = null;
          cliente.tokenExpiresAt = null;
          await cliente.save();

          res.json({ success: true });
    } catch (error) {
          console.error('Disconnect error:', error);
          res.status(500).json({ error: 'Error desconectando' });
    }
});

// Ruta: Sincronizar reseñas
app.post('/api/reviews/sync', verificarToken, async (req, res) => {
    try {
          const cliente = await ClienteSchema.findById(req.clienteId);

          if (!cliente?.googleAccessToken) {
                  return res.status(401).json({ error: 'Google no conectado' });
          }

          // Obtener reseñas de Google Business Profile
          const reviews = await obtenerResenasBusinessAPI(cliente);

          cliente.lastSyncTime = new Date();
          await cliente.save();

          res.json({
                  success: true,
                  reviewsCount: reviews.length,
                  lastSync: cliente.lastSyncTime,
          });
    } catch (error) {
          console.error('Sync error:', error);
          res.status(500).json({ error: 'Error sincronizando reseñas' });
    }
});



module.exports = app;


// ================================================================
// 🕕  GESTIÓN AUTOMÁTICA DE RESEÑAS CADA 6 HORAS
// ================================================================

// Obtener reseñas de Google Business Profile via OAuth del cliente
async function obtenerResenasGBP(cliente) {
  if (!cliente.locationName || !cliente.googleAuth.conectadocliente.googleAuth.refreshToken || !cliente.googleAuth.refreshToken) {
    return [];
  }
  try {
    const auth = crearOAuth2Client({ refresh_token: cliente.googleAuth.refreshToken });
    const tokenResp = await auth.getAccessToken();
    const accessToken = tokenResp.token || tokenResp.res?.data?.access_token;
    if (!accessToken) throw new Error('No se pudo obtener access token');

    const url = `https://mybusiness.googleapis.com/v4/${cliente.locationName}/reviews?pageSize=50`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      const msg = errData.error?.message || `HTTP ${resp.status}`;
      if (resp.status === 401 || msg.includes('invalid_grant')) {
        await Cliente.findByIdAndUpdate(cliente._id, { 'googleRefreshToken': null });
        console.log(`[GBP] Token inválido para ${cliente.nombreLocal} — desconectado`);
      }
      throw new Error(msg);
    }

    const json = await resp.json();
    return json.reviews || [];
  } catch (err) {
    console.error(`[GBP] Error obteniendo reseñas de ${cliente.nombreLocal}:`, err.message);
    return [];
  }
}

// Generar respuesta personalizada con IA para una reseña
async function generarRespuestaIAReview(cliente, resena) {
  const estrellas = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[resena.starRating] || 3;
  const comentario = resena.comment || '';
  const autor = resena.reviewer?.displayName || 'cliente';

  const instruccion =
    estrellas >= 4 ? 'Agradece con entusiasmo y menciona algún detalle positivo de la reseña' :
    estrellas <= 2 ? 'Pide disculpas con empatía, reconoce el problema y ofrece resolverlo' :
                     'Agradece el feedback y muestra tu compromiso con la mejora';

  const prompt = `Eres el responsable de "${cliente.nombreLocal}".
El cliente ${autor} dejó ${estrellas} estrella${estrellas !== 1 ? 's' : ''}: "${comentario || '(sin comentario)'}"

${instruccion}. Responde en español, máximo 100 palabras, tono profesional y cercano, sin emojis excesivos.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 160,
      temperature: 0.72
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('[IA] Error generando respuesta:', err.message);
    return null;
  }
}

// Ciclo completo: procesar reseñas pendientes de un cliente
async function cicloResenasCliente(cliente) {
  console.log(`[CICLO] → ${cliente.nombreLocal}`);

  const resenasGBP = await obtenerResenasGBP(cliente);
  const sinRespuesta = resenasGBP.filter(r => !r.reviewReply && r.name);

  if (!sinRespuesta.length) {
    console.log(`[CICLO]   Sin reseñas pendientes`);
    return { procesadas: resenasGBP.length, respondidas: 0 };
  }

  let respondidas = 0;
  const estrellasMapa = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

  for (const r of sinRespuesta) {
    // ¿Ya la tenemos respondida en nuestra DB?
    const yaRespondida = await Resena.findOne({
      clienteId: cliente._id,
      googleReviewName: r.name,
      respondida: true
    });
    if (yaRespondida) continue;

    // Generar respuesta con IA
    const respuesta = await generarRespuestaIAReview(cliente, r);
    if (!respuesta) continue;

    // Publicar en Google Business Profile
    const resultado = await publicarRespuestaGoogle(cliente, r.name, respuesta);

    if (resultado.ok) {
      respondidas++;
      await Resena.findOneAndUpdate(
        { clienteId: cliente._id, googleReviewName: r.name },
        {
          clienteId: cliente._id,
          googleReviewName: r.name,
          autor: r.reviewer?.displayName || 'Anónimo',
          texto: r.comment || '',
          calificacion: estrellasMapa[r.starRating] || 3,
          respuestaIA: respuesta,
          respondida: true,
          fechaRespondida: new Date(),
          fuente: 'google_maps'
        },
        { upsert: true, new: true }
      );
      console.log(`[CICLO]   ✅ Respondida reseña de ${r.reviewer?.displayName || 'Anónimo'}`);
    } else {
      console.error(`[CICLO]   ❌ No se pudo publicar:`, resultado.error);
    }

    // Pausa anti rate-limit
    await new Promise(res => setTimeout(res, 1500));
  }

  console.log(`[CICLO]   ${respondidas}/${sinRespuesta.length} respondidas`);
  return { procesadas: resenasGBP.length, respondidas };
}

// 🕕 Cron: ejecutar cada 6 horas (timezone España)
cron.schedule('0 */6 * * *', async () => {
  const ts = new Date().toISOString();
  console.log(`\n[CRON 6H] [${ts}] Iniciando ciclo automático de reseñas...`);

  try {
    const clientes = await Cliente.find({
      'googleAuth.conectado': true,
      'googleAuth.refreshToken': { $exists: true, $ne: null }
    });

    console.log(`[CRON 6H] Clientes con Google conectado: ${clientes.length}`);
    let totalRespondidas = 0;

    for (const cliente of clientes) {
      try {
        const { respondidas } = await cicloResenasCliente(cliente);
        totalRespondidas += respondidas;
        await new Promise(r => setTimeout(r, 3000)); // pausa entre clientes
      } catch (err) {
        console.error(`[CRON 6H] Error con ${cliente.nombreLocal}:`, err.message);
      }
    }

    console.log(`[CRON 6H] ✅ Ciclo terminado — ${totalRespondidas} respuestas publicadas\n`);
  } catch (err) {
    console.error('[CRON 6H] Error crítico:', err.message);
  }
}, { timezone: 'Europe/Madrid' });

// Endpoint admin: disparar ciclo manualmente
app.post('/admin/ciclo-resenas', verificarAdmin, async (req, res) => {
  const { clienteId } = req.body;
  try {
    if (clienteId) {
      const cliente = await Cliente.findById(clienteId);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      const resultado = await cicloResenasCliente(cliente);
      return res.json({ ok: true, ...resultado });
    }

    const clientes = await Cliente.find({
      'googleAuth.conectado': true,
      'googleAuth.refreshToken': { $exists: true, $ne: null }
    });

    let totalRespondidas = 0;
    for (const c of clientes) {
      try {
        const { respondidas } = await cicloResenasCliente(c);
        totalRespondidas += respondidas;
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`Error con ${c.nombreLocal}:`, e.message);
      }
    }
    return res.json({ ok: true, clientesProcesados: clientes.length, totalRespondidas });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// Load Reviews Management Module
const reviewsModule = require('./reviews.js');
reviewsModule(app, mongoose, openai, google, Cliente);
