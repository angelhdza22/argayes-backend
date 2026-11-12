require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('./lib/db');
const googleWallet = require('./lib/google-wallet');
const appleWallet = require('./lib/apple-wallet');

// No hay valor "por default" para estas dos claves a propósito: si faltan,
// el servidor se niega a arrancar en vez de arrancar inseguro sin avisar
// (antes tenían un valor de respaldo tipo "cambia-esto-en-produccion", que
// es justo lo que un atacante probaría primero). Se configuran en Render →
// Environment → Environment Variables.
const JWT_SECRET = process.env.APP_JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
if (!JWT_SECRET || !ADMIN_SECRET) {
    console.error(
          'Faltan APP_JWT_SECRET y/o ADMIN_SECRET en las variables de entorno. ' +
          'El servidor no arranca sin ellas (ver Render → Environment).'
        );
    process.exit(1);
}

const app = express();
app.use(cors());
// Límite más alto que el default (100kb) porque el logo del negocio llega
// como imagen codificada en base64 dentro del JSON (puede pesar varios MB).
app.use(express.json({ limit: '8mb' }));

// Freno a intentos de adivinar contraseña a fuerza bruta: máximo 20 intentos
// de login por IP cada 15 minutos. No afecta el uso normal (una empresa no
// falla su contraseña 20 veces en 15 minutos).
const limitadorLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' }
});

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

// Además de un token válido, confirma que la suscripción de esa empresa
// siga activa (ARGAYES puede desactivarla si no paga). Se separa de
// requireAuth porque necesita consultar la base de datos (async).
async function requireEmpresaActiva(req, res, next) {
    const empresa = await db.obtenerEmpresa(req.empresaId);
    if (!empresa) return res.status(401).json({ error: 'Sesión inválida o vencida' });
    if (empresa.activa === false) {
          return res.status(403).json({ error: 'Tu suscripción no está activa. Contacta a ARGAYES para reactivarla.' });
    }
    req.empresa = empresa;
    next();
}

// Protege las rutas de super-admin (solo tú, dueño de ARGAYES) con una
// clave fija por header — no hace falta login de usuario para esto.
function requireAdmin(req, res, next) {
    const clave = req.headers['x-admin-secret'];
    if (!clave || clave !== ADMIN_SECRET) {
          return res.status(401).json({ error: 'Clave de administrador incorrecta' });
    }
    next();
}

// ---------- Cuenta del negocio: alta y login (Paso 6-A) ----------
app.post('/api/auth/registro', async (req, res) => {
    const { nombre, email, password, recompensa, umbral, color } = req.body;
    if (!nombre || !email || !password) {
          return res.status(400).json({ error: 'Falta nombre, email o password' });
    }
    try {
          const empresa = await db.crearEmpresa({ nombre, email, password, recompensa, umbral, color });
          const token = jwt.sign({ empresaId: empresa.id }, JWT_SECRET, { expiresIn: '30d' });
          res.status(201).json({ token, empresa: sinDatosSensibles(empresa) });
    } catch (e) {
          res.status(409).json({ error: e.message });
    }
});

app.post('/api/auth/login', limitadorLogin, async (req, res) => {
    const { email, password } = req.body;
    const empresa = await db.validarLogin(email, password);
    if (!empresa) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    if (empresa.activa === false) {
          return res.status(403).json({ error: 'Tu suscripción no está activa. Contacta a ARGAYES para reactivarla.' });
    }
    const token = jwt.sign({ empresaId: empresa.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, empresa: sinDatosSensibles(empresa) });
});

// ---------- Super-admin (ARGAYES): ver y activar/desactivar negocios ----------
app.get('/api/admin/empresas', requireAdmin, async (req, res) => {
    const empresas = await db.listarEmpresas();
    res.json(empresas.map(sinDatosSensibles));
});

app.patch('/api/admin/empresas/:id/activa', requireAdmin, async (req, res) => {
    const empresa = await db.setActivaEmpresa(req.params.id, !!req.body.activa);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json(sinDatosSensibles(empresa));
});

// ---------- Panel: solo ve y toca lo de SU PROPIA empresa ----------
app.get('/api/mi-empresa', requireAuth, async (req, res) => {
    const empresa = await db.obtenerEmpresa(req.empresaId);
    res.json(sinDatosSensibles(empresa));
});

app.patch('/api/mi-empresa', requireAuth, async (req, res) => {
    const { nombre, color, recompensa, umbral, logoUrl } = req.body;
    const empresa = await db.actualizarEmpresa(req.empresaId, { nombre, color, recompensa, umbral, logoUrl });
    res.json(sinDatosSensibles(empresa));
});

app.get('/api/mis-clientes', requireAuth, async (req, res) => {
    res.json(await db.clientesDeEmpresa(req.empresaId));
});

app.get('/api/mis-estadisticas', requireAuth, async (req, res) => {
    res.json(await db.estadisticasDeEmpresa(req.empresaId));
});

// Alta directa de empresa sin password (uso interno/pruebas con curl).
app.get('/api/empresas/:id', async (req, res) => {
    const empresa = await db.obtenerEmpresa(req.params.id);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json(sinDatosSensibles(empresa));
});

// ---------- Paso 6-B: alta de cliente (pública: la usa el cliente final
// desde el link/QR que le da el negocio, sin necesitar cuenta ni login) ----------
app.post('/api/clientes', async (req, res) => {
    const { empresaId, nombre, contacto } = req.body;
    if (!empresaId || !nombre) return res.status(400).json({ error: 'Falta empresaId o nombre' });
    if (!(await db.obtenerEmpresa(empresaId))) return res.status(404).json({ error: 'Empresa no encontrada' });
    const cliente = await db.crearCliente({ empresaId, nombre, contacto });
    res.status(201).json(cliente);
});

app.get('/api/clientes/:id', async (req, res) => {
    const cliente = await db.obtenerCliente(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(cliente);
});

// ---------- Paso 5: generar el pase ----------
app.get('/api/wallet/google/:clienteId', async (req, res) => {
    const cliente = await db.obtenerCliente(req.params.clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const empresa = await db.obtenerEmpresa(cliente.empresaId);
    try {
          const saveUrl = googleWallet.generarSaveUrl(empresa, cliente);
          res.json({ saveUrl });
    } catch (e) {
          res.status(500).json({ error: e.message });
    }
});

app.get('/api/wallet/apple/:clienteId.pkpass', async (req, res) => {
    const cliente = await db.obtenerCliente(req.params.clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    const empresa = await db.obtenerEmpresa(cliente.empresaId);
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
// Requiere sesión de la empresa (el empleado entra con la cuenta del
// negocio y escanea desde ahí) — así un cliente no puede llamar esto él
// mismo desde su celular para auto-otorgarse visitas.
app.post('/api/visita', requireAuth, requireEmpresaActiva, async (req, res) => {
    const { clienteId } = req.body;
    const cliente = await db.obtenerCliente(clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (cliente.empresaId !== req.empresaId) {
          return res.status(403).json({ error: 'Ese cliente no pertenece a tu negocio' });
    }

           if (await db.yaVisitoHoy(clienteId)) {
                 return res.status(409).json({ error: 'Ya se registró una visita hoy para este cliente' });
           }

           const actualizado = await db.registrarVisita(clienteId);
    const empresa = req.empresa;

           // Mejor esfuerzo: si hay credenciales de Google, empuja el saldo nuevo al
           // pase que el cliente ya tiene guardado (Paso 8). Si falla, la visita ya
           // quedó registrada en la base de datos de todas formas.
           googleWallet.patchPuntos(empresa, actualizado).catch(() => {});

           const listoParaCanje = actualizado.puntos >= empresa.umbral;
    res.json({ cliente: actualizado, listoParaCanje });
});

// ---------- Paso 9: recompensa y canje de un solo uso ----------
// También requiere sesión de la empresa, por la misma razón que /api/visita:
// el canje lo debe generar y confirmar el negocio, no el cliente desde su casa.
app.post('/api/canje', requireAuth, requireEmpresaActiva, async (req, res) => {
    const { clienteId } = req.body;
    const cliente = await db.obtenerCliente(clienteId);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (cliente.empresaId !== req.empresaId) {
          return res.status(403).json({ error: 'Ese cliente no pertenece a tu negocio' });
    }
    const empresa = req.empresa;
    if (cliente.puntos < empresa.umbral) {
          return res.status(400).json({ error: 'El cliente todavía no llega al umbral de puntos' });
    }
    const canje = await db.crearCanje(clienteId);
    res.status(201).json(canje);
});

app.post('/api/canje/confirmar', requireAuth, requireEmpresaActiva, async (req, res) => {
    const { codigo } = req.body;
    const resultado = await db.confirmarCanje(codigo);
    if (!resultado.ok) return res.status(409).json({ error: resultado.razon });
    res.json(resultado);
});

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
        app.listen(PORT, () => {
                console.log(`ARGAYES backend corriendo en http://localhost:${PORT}`);
        });
  })
  .catch((e) => {
        console.error('No se pudo inicializar la base de datos:', e.message);
        process.exit(1);
  });
