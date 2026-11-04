// Base de datos simple en un archivo JSON. Suficiente para un negocio o un
// puñado de ellos; si crece mucho, esto se cambia por Postgres/SQLite sin
// tocar el resto del backend (todas las lecturas/escrituras pasan por aquí).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data.json');

function emptyDb() {
  return { empresas: [], clientes: [], visitas: [], canjes: [] };
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    save(emptyDb());
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---- empresas ----
// El password nunca se guarda en texto plano: se parte en hash + salt con
// scrypt (viene incluido en Node, sin librerías externas).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificarPassword(password, almacenado) {
  const [salt, hash] = almacenado.split(':');
  const hashIntento = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashIntento, 'hex'));
}

function crearEmpresa(data) {
  const db = load();
  if (data.email && db.empresas.some((e) => e.email === data.email)) {
    throw new Error('Ya existe una empresa registrada con ese email');
  }
  const empresa = {
    id: crypto.randomUUID(),
    nombre: data.nombre,
    email: data.email || null,
    passwordHash: data.password ? hashPassword(data.password) : null,
    logoUrl: data.logoUrl || null,
    color: data.color || '#b8872b',
    recompensa: data.recompensa || '',
    umbral: Number(data.umbral) || 10,
    // Suscripción: la activa/desactiva el super-admin (ARGAYES) a mano,
    // por eso nace activa — así un negocio puede usarla apenas se registra,
    // y solo se bloquea si deja de pagar.
    activa: true,
    creado: new Date().toISOString()
  };
  db.empresas.push(empresa);
  save(db);
  return empresa;
}

function obtenerEmpresa(id) {
  return load().empresas.find((e) => e.id === id) || null;
}

function obtenerEmpresaPorEmail(email) {
  return load().empresas.find((e) => e.email === email) || null;
}

// ---- super-admin: lista de todos los negocios de la plataforma ----
function listarEmpresas() {
  return load().empresas.slice().sort((a, b) => b.creado.localeCompare(a.creado));
}

function setActivaEmpresa(id, activa) {
  const db = load();
  const i = db.empresas.findIndex((e) => e.id === id);
  if (i === -1) return null;
  db.empresas[i].activa = !!activa;
  save(db);
  return db.empresas[i];
}

function validarLogin(email, password) {
  const empresa = obtenerEmpresaPorEmail(email);
  if (!empresa || !empresa.passwordHash) return null;
  if (!verificarPassword(password, empresa.passwordHash)) return null;
  return empresa;
}

function actualizarEmpresa(id, cambios) {
  const db = load();
  const i = db.empresas.findIndex((e) => e.id === id);
  if (i === -1) return null;
  // Solo se copian los campos que de verdad vinieron en la petición — si
  // un campo llega como undefined (porque el cliente no lo mandó) no debe
  // borrar el valor que ya estaba guardado.
  const permitido = {};
  for (const campo of ['nombre', 'color', 'recompensa', 'umbral', 'logoUrl']) {
    if (cambios[campo] !== undefined) permitido[campo] = cambios[campo];
  }
  db.empresas[i] = { ...db.empresas[i], ...permitido };
  save(db);
  return db.empresas[i];
}

// ---- consultas filtradas por empresa, para el panel ----
function clientesDeEmpresa(empresaId) {
  return load()
    .clientes.filter((c) => c.empresaId === empresaId)
    .sort((a, b) => b.creado.localeCompare(a.creado));
}

function estadisticasDeEmpresa(empresaId) {
  const db = load();
  const clientes = db.clientes.filter((c) => c.empresaId === empresaId);
  const clienteIds = new Set(clientes.map((c) => c.id));
  const hoy = new Date().toISOString().slice(0, 10);
  const visitasHoy = db.visitas.filter((v) => clienteIds.has(v.clienteId) && v.fecha === hoy).length;
  const canjesPendientes = db.canjes.filter((c) => clienteIds.has(c.clienteId) && !c.usado).length;
  return {
    totalClientes: clientes.length,
    visitasHoy,
    canjesPendientes,
    puntosRepartidos: clientes.reduce((sum, c) => sum + c.puntos, 0)
  };
}

// ---- clientes ----
function crearCliente(data) {
  const db = load();
  const cliente = {
    id: crypto.randomUUID(),
    empresaId: data.empresaId,
    nombre: data.nombre,
    contacto: data.contacto || '',
    puntos: 0,
    googleObjectId: null,
    creado: new Date().toISOString()
  };
  db.clientes.push(cliente);
  save(db);
  return cliente;
}

function obtenerCliente(id) {
  return load().clientes.find((c) => c.id === id) || null;
}

function actualizarCliente(id, cambios) {
  const db = load();
  const i = db.clientes.findIndex((c) => c.id === id);
  if (i === -1) return null;
  db.clientes[i] = { ...db.clientes[i], ...cambios };
  save(db);
  return db.clientes[i];
}

// ---- visitas (antifraude: una por día por cliente) ----
function yaVisitoHoy(clienteId) {
  const hoy = new Date().toISOString().slice(0, 10);
  return load().visitas.some((v) => v.clienteId === clienteId && v.fecha === hoy);
}

function registrarVisita(clienteId) {
  const db = load();
  const visita = {
    id: crypto.randomUUID(),
    clienteId,
    fecha: new Date().toISOString().slice(0, 10),
    hora: new Date().toISOString()
  };
  db.visitas.push(visita);
  const i = db.clientes.findIndex((c) => c.id === clienteId);
  if (i !== -1) db.clientes[i].puntos += 1;
  save(db);
  return db.clientes[i];
}

// ---- canjes (código de un solo uso, distinto al QR del cliente) ----
function crearCanje(clienteId) {
  const db = load();
  const canje = {
    codigo: crypto.randomUUID(),
    clienteId,
    usado: false,
    creado: new Date().toISOString()
  };
  db.canjes.push(canje);
  save(db);
  return canje;
}

function confirmarCanje(codigo) {
  const db = load();
  const canje = db.canjes.find((c) => c.codigo === codigo);
  if (!canje) return { ok: false, razon: 'codigo_no_existe' };
  if (canje.usado) return { ok: false, razon: 'ya_usado' };
  canje.usado = true;
  canje.usadoEl = new Date().toISOString();
  const ci = db.clientes.findIndex((c) => c.id === canje.clienteId);
  if (ci !== -1) {
    const empresa = db.empresas.find((e) => e.id === db.clientes[ci].empresaId);
    const umbral = empresa ? empresa.umbral : 10;
    db.clientes[ci].puntos = Math.max(0, db.clientes[ci].puntos - umbral);
  }
  save(db);
  return { ok: true, cliente: db.clientes[ci] };
}

module.exports = {
  crearEmpresa,
  obtenerEmpresa,
  obtenerEmpresaPorEmail,
  validarLogin,
  actualizarEmpresa,
  listarEmpresas,
  setActivaEmpresa,
  clientesDeEmpresa,
  estadisticasDeEmpresa,
  crearCliente,
  obtenerCliente,
  actualizarCliente,
  yaVisitoHoy,
  registrarVisita,
  crearCanje,
  confirmarCanje
};
