require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const db = require('./lib/db');
const googleWallet = require('./lib/google-wallet');
const appleWallet = require('./lib/apple-wallet');

const JWT_SECRET = process.env.APP_JWT_SECRET || 'cambia-esto-en-produccion';

const app = express();
app.use(cors());
   // Límite más alto que el default (100kb) porque el logo del negocio llega
   // como imagen codificada en base64 dentro del JSON (puede pesar varios MB).
   app.use(express.json({ limit: '8mb' }));
function sinDatosSensibles(empresa) {
  const { passwordHash, ...resto } = empresa;
  return resto;
}

// Protege las rutas del panel: solo responde si el token es válido, y
// mete req.empresaId para que cada ruta filtre SOLO lo de esa empresa —
// así una empresa nunca puede ver ni tocar los datos de otra.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta el token de sesión' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.empresaId = payload.empresaId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sesión inválida o vencida' });
  }
}

// ---------- Cuenta del negocio: alta y login (Paso 6-A) ----------
app.post('/api/auth/registro', (req, res) => {
  const { nombre, email, password, recompensa, umbral, color } = req.body;
  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Falta nombre, email o password' });
  }
  try {
    const empresa = db.crearEmpresa({ nombre, email, password, recompensa, umbral, color });
    const token = jwt.sign({ empresaId: empresa.id }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, empresa: sinDatosSensibles(empresa) });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const empresa = db.validarLogin(email, password);
  if (!empresa) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  const token = jwt.sign({ empresaId: empresa.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, empresa: sinDatosSensibles(empresa) });
});

// ---------- Panel: solo ve y toca lo de SU PROPIA empresa ----------
app.get('/api/mi-empresa', requireAuth, (req, res) => {
  const empresa = db.obtenerEmpresa(req.empresaId);
  res.json(sinDatosSensibles(empresa));
});

app.patch('/api/mi-empresa', requireAuth, (req, res) => {
  const { nombre, color, recompensa, umbral, logoUrl } = req.body;
  const empresa = db.actualizarEmpresa(req.empresaId, { nombre, color, recompensa, umbral, logoUrl });
  res.json(sinDatosSensibles(empresa));
});

app.get('/api/mis-clientes', requireAuth, (req, res) => {
  res.json(db.clientesDeEmpresa(req.empresaId));
});

app.get('/api/mis-estadisticas', requireAuth, (req, res) => {
  res.json(db.estadisticasDeEmpresa(req.empresaId));
});

// Alta directa de empresa sin password (uso interno/pruebas con curl).
app.get('/api/empresas/:id', (req, res) => {
  const empresa = db.obtenerEmpresa(req.params.id);
  if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json(sinDatosSensibles(empresa));
});

// ---------- Paso 6-B: alta de cliente ----------
app.post('/api/clientes', (req, res) => {
  const { empresaId, nombre, contacto } = req.body;
  if (!empresaId || !nombre) return res.status(400).json({ error: 'Falta empresaId o nombre' });
  if (!db.obtenerEmpresa(empresaId)) return res.status(404).json({ error: 'Empresa no encontrada' });
  const cliente = db.crearCliente({ empresaId, nombre, contacto });
  res.status(201).json(cliente);
});

app.get('/api/clientes/:id', (req, res) => {
  const cliente = db.obtenerCliente(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(cliente);
});

// ---------- Paso 5: generar el pase ----------
app.get('/api/wallet/google/:clienteId', (req, res) => {
  const cliente = db.obtenerCliente(req.params.clienteId);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const empresa = db.obtenerEmpresa(cliente.empresaId);
  try {
    const saveUrl = googleWallet.generarSaveUrl(empresa, cliente);
    res.json({ saveUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wallet/apple/:clienteId.pkpass', async (req, res) => {
  const cliente = db.obtenerCliente(req.params.clienteId);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const empresa = db.obtenerEmpresa(cliente.empresaId);
  try {
    const buffer = await appleWallet.generarPkpass(empresa, cliente);
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', `attachment; filename=${cliente.id}.pkpass`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Paso 7: escaneo en tienda, suma de puntos ----------
app.post('/api/visita', async (req, res) => {
  const { clienteId } = req.body;
  const cliente = db.obtenerCliente(clienteId);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  if (db.yaVisitoHoy(clienteId)) {
    return res.status(409).json({ error: 'Ya se registró una visita hoy para este cliente' });
  }

  const actualizado = db.registrarVisita(clienteId);
  const empresa = db.obtenerEmpresa(actualizado.empresaId);

  // Mejor esfuerzo: si hay credenciales de Google, empuja el saldo nuevo al
  // pase que el cliente ya tiene guardado (Paso 8). Si falla, la visita ya
  // quedó registrada en la base de datos de todas formas.
  googleWallet.patchPuntos(empresa, actualizado).catch(() => {});

  const listoParaCanje = actualizado.puntos >= empresa.umbral;
  res.json({ cliente: actualizado, listoParaCanje });
});

// ---------- Paso 9: recompensa y canje de un solo uso ----------
app.post('/api/canje', (req, res) => {
  const { clienteId } = req.body;
  const cliente = db.obtenerCliente(clienteId);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const empresa = db.obtenerEmpresa(cliente.empresaId);
  if (cliente.puntos < empresa.umbral) {
    return res.status(400).json({ error: 'El cliente todavía no llega al umbral de puntos' });
  }
  const canje = db.crearCanje(clienteId);
  res.status(201).json(canje);
});

app.post('/api/canje/confirmar', (req, res) => {
  const { codigo } = req.body;
  const resultado = db.confirmarCanje(codigo);
  if (!resultado.ok) return res.status(409).json({ error: resultado.razon });
  res.json(resultado);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ARGAYES backend corriendo en http://localhost:${PORT}`);
});
