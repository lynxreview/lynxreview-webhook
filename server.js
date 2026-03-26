const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

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

// ═══════════════════════════════════════════════════════════════
// 📊 ESQUEMAS DE MONGODB
// ═══════════════════════════════════════════════════════════════

// Esquema de Cliente
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

// Esquema de Reseña
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

// Esquema de Respuesta
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

// Crear modelos
const Cliente = mongoose.model('Cliente', clienteSchema);
const Resena = mongoose.model('Resena', resenaSchema);
const Respuesta = mongoose.model('Respuesta', respuestaSchema);

// Conectar a MongoDB
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ Conectado a MongoDB');
}).catch(err => {
  console.error('❌ Error conectando a MongoDB:', err);
});

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE DE AUTENTICACION
// ═══════════════════════════════════════════════════════════════

const verificarToken = (req, res, next) => {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
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

// ═══════════════════════════════════════════════════════════════
// SERVIR DASHBOARD
// ═══════════════════════════════════════════════════════════════

// Ruta raiz - servir dashboard HTML desde archivo
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-standalone.html'));
});

// ═══════════════════════════════════════════════════════════════
// AUTENTICACION
// ═══════════════════════════════════════════════════════════════

// SIGNUP
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

// LOGIN
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

// PERFIL
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

// RESENAS
app.get('/cliente/resenas', verificarToken, async (req, res) => {
  try {
    const resenas = await Resena.find({ clienteId: req.clienteId }).sort({ detectadoEn: -1 });
    res.json(resenas);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener resenas' });
  }
});

// WEBHOOK STRIPE
app.post('/webhook', (req, res) => {
  const event = req.body;
  console.log('Webhook recibido:', event.type);
  switch(event.type) {
    case 'customer.subscription.created':
      console.log('Nueva suscripcion:', event.data.object.id);
      break;
    case 'customer.subscription.updated':
      console.log('Suscripcion actualizada:', event.data.object.id);
      break;
    case 'customer.subscription.deleted':
      console.log('Suscripcion cancelada:', event.data.object.id);
      break;
  }
  res.json({received: true});
});

// INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log('Servidor corriendo en puerto ' + PORT);
  console.log('URL: https://lynxreview-webhook.onrender.com');
});

module.exports = app;
