const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
  telefonoGoogle: String, // Para conectar con Google My Business
  planSuscripcion: {
    tipo: String, // 'basico', 'profesional', 'empresarial'
    estado: String, // 'activo', 'cancelado'
    fechaInicio: Date,
    fechaFin: Date,
    stripeSubscriptionId: String
  },
  createdAt: { type: Date, default: Date.now }
});

// Esquema de Reseña Detectada
const resenaSchema = new mongoose.Schema({
  clienteId: mongoose.Schema.Types.ObjectId,
  textoResena: String,
  calificacion: Number, // 1-5 estrellas
  autor: String,
  fecha: Date,
  fuente: String, // 'google_maps', 'tripadvisor', 'yelp', etc
  resenaIdExterno: String, // ID de la reseña en Google, Tripadvisor, etc
  detectadoEn: { type: Date, default: Date.now }
});

// Esquema de Respuesta (generada por IA)
const respuestaSchema = new mongoose.Schema({
  resenaId: mongoose.Schema.Types.ObjectId,
  clienteId: mongoose.Schema.Types.ObjectId,
  respuestaIA: String, // Respuesta generada automáticamente
  respuestaEditada: String, // Respuesta editada por el cliente (opcional)
  estado: { type: String, enum: ['pendiente_aprobacion', 'aprobada', 'publicada', 'rechazada'], default: 'pendiente_aprobacion' },
  motivoRechazo: String, // Si fue rechazada
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
// 🔐 MIDDLEWARE DE AUTENTICACIÓN
// ═══════════════════════════════════════════════════════════════

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
    res.status(401).json({ error: 'Token inválido' });
  }
};

// ═══════════════════════════════════════════════════════════════
// 🎨 SERVIR DASHBOARD
// ═══════════════════════════════════════════════════════════════

const dashboardHTML = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>LynxReview - Dashboard</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f5f7fa;color:#333}.auth-container{display:flex;justify-content:center;align-items:center;min-height:100vh;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:20px}.auth-box{background:white;padding:40px;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.2);width:100%;max-width:400px}.auth-box h1{color:#667eea;margin-bottom:30px;text-align:center;font-size:28px}.form-group{margin-bottom:20px}.form-group label{display:block;margin-bottom:8px;font-weight:600;color:#555}.form-group input{width:100%;padding:12px;border:2px solid #ddd;border-radius:5px;font-size:14px}.form-group input:focus{outline:0;border-color:#667eea}.btn{width:100%;padding:12px;border:none;border-radius:5px;font-weight:600;cursor:pointer;font-size:16px;background:#667eea;color:#fff;transition:all .3s}.btn:hover{background:#5568d3}.success-message{background:#d4edda;border:1px solid #c3e6cb;color:#155724;padding:15px;border-radius:5px;margin-bottom:20px}.error-message{background:#f8d7da;border:1px solid #f5c6cb;color:#721c24;padding:15px;border-radius:5px;margin-bottom:20px}.text-center{text-align:center;margin-top:20px;font-size:14px}.link{color:#667eea;cursor:pointer;text-decoration:underline}</style></head><body><div class="auth-container"><div class="auth-box"><h1>🔍 LynxReview</h1><div id="message"></div><div id="loginForm"><h2 style="color:#667eea;font-size:20px;margin-bottom:20px">Login</h2><div class="form-group"><label>Email</label><input type="email" id="loginEmail" placeholder="tu@email.com"></div><div class="form-group"><label>Contraseña</label><input type="password" id="loginPassword" placeholder="•••••••"></div><button class="btn" onclick="handleLogin()">Inicia Sesión</button><div class="text-center">¿No tienes cuenta? <span class="link" onclick="showSignup()">Regístrate</span></div></div><div id="signupForm" style="display:none"><h2 style="color:#667eea;font-size:20px;margin-bottom:20px">Crear Cuenta</h2><div class="form-group"><label>Nombre</label><input type="text" id="signupName" placeholder="Tu nombre"></div><div class="form-group"><label>Email</label><input type="email" id="signupEmail" placeholder="tu@email.com"></div><div class="form-group"><label>Nombre del Negocio</label><input type="text" id="signupBusiness" placeholder="Mi Negocio"></div><div class="form-group"><label>Contraseña</label><input type="password" id="signupPassword" placeholder="•••••••"></div><button class="btn" onclick="handleSignup()">Registrarse</button><div class="text-center">¿Ya tienes cuenta? <span class="link" onclick="showLogin()">Inicia sesión</span></div></div></div></div><script>const API_URL='https://lynxreview-webhook.onrender.com';function showMessage(e,t='success'){const a=document.getElementById('message');a.innerHTML=\`<div class="\${t}-message">\${e}</div>\`,setTimeout(()=>{a.innerHTML=''},5e3)}function showLogin(){document.getElementById('loginForm').style.display='block',document.getElementById('signupForm').style.display='none',document.getElementById('message').innerHTML=''}function showSignup(){document.getElementById('loginForm').style.display='none',document.getElementById('signupForm').style.display='block',document.getElementById('message').innerHTML=''}async function handleLogin(){const e=document.getElementById('loginEmail').value,t=document.getElementById('loginPassword').value;e&&t?(showMessage('Conectando con el servidor...','success'),fetch(\`\${API_URL}/auth/login\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,contrasena:t})}).then(e=>e.json()).then(e=>{e.token?(showMessage('✅ Login exitoso. Abriendo dashboard...','success'),setTimeout(()=>{showDashboard(e)},1500)):showMessage('❌ Error: '+(e.error||'No se pudo iniciar sesión'),'error')}).catch(e=>{showMessage('❌ Error de conexión: '+e.message,'error')})):showMessage('Por favor completa todos los campos','error')}async function handleSignup(){const e=document.getElementById('signupName').value,t=document.getElementById('signupEmail').value,a=document.getElementById('signupBusiness').value,n=document.getElementById('signupPassword').value;e&&t&&a&&n?(showMessage('Creando cuenta...','success'),fetch(\`\${API_URL}/auth/signup\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nombre:e,email:t,nombreLocal:a,contrasena:n})}).then(e=>e.json()).then(e=>{e.token?(showMessage('✅ Cuenta creada. Abriendo dashboard...','success'),setTimeout(()=>{showDashboard(e)},1500)):showMessage('❌ Error: '+(e.error||'No se pudo crear la cuenta'),'error')}).catch(e=>{showMessage('❌ Error de conexión: '+e.message,'error')})):showMessage('Por favor completa todos los campos','error')}function showDashboard(e){document.body.innerHTML=\`<div style="padding:20px;font-family:Arial;background:#f5f7fa;min-height:100vh"><div style="max-width:800px;margin:0 auto;background:#fff;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.1)"><h1 style="color:#667eea;margin-bottom:30px">✅ ¡Dashboard Conectado!</h1><div style="background:#d4edda;border:1px solid #c3e6cb;color:#155724;padding:15px;border-radius:5px;margin-bottom:20px"><strong>✅ Servidor Conectado Exitosamente</strong><br>Tu backend en Render está funcionando correctamente.</div><h2 style="color:#333;margin-top:30px">Información de tu Cuenta:</h2><div style="background:#f9f9f9;padding:15px;border-radius:5px;margin:15px 0"><p><strong>Nombre:</strong> \${e.cliente.nombre}</p><p><strong>Email:</strong> \${e.cliente.email}</p></div><button onclick="location.reload()" style="background:#667eea;color:#fff;border:none;padding:12px 20px;border-radius:5px;cursor:pointer;font-size:16px;margin-top:30px">Volver a Login</button></div></div>\`}</script></body></html>\`;

// Ruta raíz - servir dashboard HTML directamente
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHTML);
});

// ═══════════════════════════════════════════════════════════════
// 👤 AUTENTICACIÓN
// ═══════════════════════════════════════════════════════════════

// SIGNUP - Registro de nuevo cliente
app.post('/auth/signup', async (req, res) => {
  try {
    const { nombre, email, contrasena, nombreLocal } = req.body;

    // Verificar si el cliente ya existe
    const clienteExistente = await Cliente.findOne({ email });
    if (clienteExistente) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }

    // Hash de la contraseña
    const salt = await bcrypt.genSalt(10);
    const contrasenaHash = await bcrypt.hash(contrasena, salt);

    // Crear nuevo cliente
    const nuevoCliente = new Cliente({
      nombre,
      email,
      contrasena: contrasenaHash,
      nombreLocal
    });

    await nuevoCliente.save();

    // Generar JWT
    const token = jwt.sign({ id: nuevoCliente._id }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      mensaje: '✅ Cliente registrado exitosamente',
      token,
      cliente: {
        id: nuevoCliente._id,
        nombre: nuevoCliente.nombre,
        email: nuevoCliente.email
      }
    });
  } catch (error) {
    console.error('❌ Error en signup:', error);
    res.status(500).json({ error: 'Error en el registro' });
  }
});

// LOGIN - Inicio de sesión
app.post('/auth/login', async (req, res) => {
  try {
    const { email, contrasena } = req.body;

    // Buscar cliente
    const cliente = await Cliente.findOne({ email });
    if (!cliente) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Verificar contraseña
    const contrasenaValida = await bcrypt.compare(contrasena, cliente.contrasena);
    if (!contrasenaValida) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Generar JWT
    const token = jwt.sign({ id: cliente._id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      mensaje: '✅ Login exitoso',
      token,
      cliente: {
        id: cliente._id,
        nombre: cliente.nombre,
        email: cliente.email,
        nombreLocal: cliente.nombreLocal
      }
    });
  } catch (error) {
    console.error('❌ Error en login:', error);
    res.status(500).json({ error: 'Error en el login' });
  }
});

// ═══════════════════════════════════════════════════════════════
// 📊 RUTAS DEL CLIENTE (PROTEGIDAS)
// ═══════════════════════════════════════════════════════════════

// Obtener perfil del cliente
app.get('/cliente/perfil', verificarToken, async (req, res) => {
  try {
    const cliente = await Cliente.findById(req.clienteId).select('-contrasena');
    res.json(cliente);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// Actualizar perfil del cliente
app.put('/cliente/perfil', verificarToken, async (req, res) => {
  try {
    const { nombreLocal, direccion, telefonoGoogle } = req.body;
    const cliente = await Cliente.findByIdAndUpdate(
      req.clienteId,
      { nombreLocal, direccion, telefonoGoogle },
      { new: true }
    );
    res.json({ mensaje: '✅ Perfil actualizado', cliente });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ⭐ RUTAS DE RESEÑAS
// ═══════════════════════════════════════════════════════════════

// Obtener todas las reseñas del cliente
app.get('/cliente/resenas', verificarToken, async (req, res) => {
  try {
    const resenas = await Resena.find({ clienteId: req.clienteId })
      .sort({ detectadoEn: -1 });
    res.json(resenas);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener reseñas' });
  }
});

// Obtener reseña específica con su respuesta
app.get('/cliente/resena/:resenaId', verificarToken, async (req, res) => {
  try {
    const resena = await Resena.findById(req.params.resenaId);
    const respuesta = await Respuesta.findOne({ resenaId: req.params.resenaId });

    res.json({
      resena,
      respuesta
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener reseña' });
  }
});

// ═══════════════════════════════════════════════════════════════
// 💬 RUTAS DE RESPUESTAS
// ═══════════════════════════════════════════════════════════════

// Obtener respuestas pendientes de aprobación
app.get('/cliente/respuestas/pendientes', verificarToken, async (req, res) => {
  try {
    const respuestas = await Respuesta.find({
      clienteId: req.clienteId,
      estado: 'pendiente_aprobacion'
    }).sort({ createdAt: -1 });

    res.json(respuestas);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener respuestas pendientes' });
  }
});

// Aprobar respuesta
app.put('/cliente/respuesta/:respuestaId/aprobar', verificarToken, async (req, res) => {
  try {
    const respuesta = await Respuesta.findByIdAndUpdate(
      req.params.respuestaId,
      { estado: 'aprobada' },
      { new: true }
    );
    res.json({ mensaje: '✅ Respuesta aprobada', respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al aprobar respuesta' });
  }
});

// Rechazar respuesta
app.put('/cliente/respuesta/:respuestaId/rechazar', verificarToken, async (req, res) => {
  try {
    const { motivo } = req.body;
    const respuesta = await Respuesta.findByIdAndUpdate(
      req.params.respuestaId,
      { estado: 'rechazada', motivoRechazo: motivo },
      { new: true }
    );
    res.json({ mensaje: '✅ Respuesta rechazada', respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al rechazar respuesta' });
  }
});

// Editar respuesta
app.put('/cliente/respuesta/:respuestaId/editar', verificarToken, async (req, res) => {
  try {
    const { respuestaEditada } = req.body;
    const respuesta = await Respuesta.findByIdAndUpdate(
      req.params.respuestaId,
      { respuestaEditada },
      { new: true }
    );
    res.json({ mensaje: '✅ Respuesta editada', respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al editar respuesta' });
  }
});

// Publicar respuesta
app.post('/cliente/respuesta/:respuestaId/publicar', verificarToken, async (req, res) => {
  try {
    const respuesta = await Respuesta.findByIdAndUpdate(
      req.params.respuestaId,
      {
        estado: 'publicada',
        'publicadoEn.fecha': new Date()
      },
      { new: true }
    );
    res.json({ mensaje: '✅ Respuesta publicada', respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al publicar respuesta' });
  }
});

// ═══════════════════════════════════════════════════════════════
// 🔔 WEBHOOK DE STRIPE
// ═══════════════════════════════════════════════════════════════

app.post('/webhook', (req, res) => {
  const event = req.body;
  console.log('📩 Webhook recibido:', event.type);

  switch(event.type) {
    case 'customer.subscription.created':
      console.log('✅ Nueva suscripción:', event.data.object.id);
      // Aquí guardar en MongoDB cuando alguien se suscribe
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

// ═══════════════════════════════════════════════════════════════
// 🚀 INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📍 URL: https://lynxreview-webhook.onrender.com`);
  console.log(`✅ Servidor listo para recibir webhooks y gestionar clientes\n`);
});

module.exports = app;
