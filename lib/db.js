// Base de datos en Postgres (antes era un archivo JSON que Render borraba en
// cada redeploy — ver README). Todas las lecturas/escrituras del backend
// pasan por aquí, igual que antes; lo único que cambió es que ahora viven
// en una base de datos real que no se pierde.
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
});

// Crea las tablas si no existen todavía (se llama una vez al arrancar el
// servidor, ver server.js). No borra ni toca nada si ya existen.
async function init() {
      await pool.query(`
          CREATE TABLE IF NOT EXISTS empresas (
                id uuid PRIMARY KEY,
                      nombre text NOT NULL,
                            email text UNIQUE,
                                  password_hash text,
                                        logo_url text,
                                              color text DEFAULT '#b8872b',
                                                    recompensa text DEFAULT '',
                                                          umbral integer DEFAULT 10,
                                                                activa boolean DEFAULT true,
                                                                      creado timestamptz DEFAULT now()
                                                                          );

                                                                              CREATE TABLE IF NOT EXISTS clientes (
                                                                                    id uuid PRIMARY KEY,
                                                                                          empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
                                                                                                nombre text NOT NULL,
                                                                                                      contacto text DEFAULT '',
                                                                                                            puntos integer DEFAULT 0,
                                                                                                                  google_object_id text,
                                                                                                                        creado timestamptz DEFAULT now()
                                                                                                                            );
                                                                                                                            
                                                                                                                                -- Evita duplicados a nivel de base de datos (no solo en el código): dos
                                                                                                                                    -- clientes de la misma empresa no pueden tener el mismo contacto.
                                                                                                                                        CREATE UNIQUE INDEX IF NOT EXISTS clientes_empresa_contacto_unico
                                                                                                                                              ON clientes (empresa_id, lower(btrim(contacto)))
                                                                                                                                                    WHERE contacto <> '';
                                                                                                                                                    
                                                                                                                                                        CREATE TABLE IF NOT EXISTS visitas (
                                                                                                                                                              id uuid PRIMARY KEY,
                                                                                                                                                                    cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                                                                                                                                                                          fecha date NOT NULL,
                                                                                                                                                                                hora timestamptz DEFAULT now()
                                                                                                                                                                                    );
                                                                                                                                                                                    
                                                                                                                                                                                        CREATE TABLE IF NOT EXISTS canjes (
                                                                                                                                                                                              codigo uuid PRIMARY KEY,
                                                                                                                                                                                                    cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
                                                                                                                                                                                                          usado boolean DEFAULT false,
                                                                                                                                                                                                                creado timestamptz DEFAULT now(),
                                                                                                                                                                                                                      usado_el timestamptz
                                                                                                                                                                                                                          );
                                                                                                                                                                                                                            `);
}

function filaAEmpresa(fila) {
      if (!fila) return null;
      return {
              id: fila.id,
              nombre: fila.nombre,
              email: fila.email,
              passwordHash: fila.password_hash,
              logoUrl: fila.logo_url,
              color: fila.color,
              recompensa: fila.recompensa,
              umbral: fila.umbral,
              activa: fila.activa,
              creado: fila.creado.toISOString()
      };
}

function filaACliente(fila) {
      if (!fila) return null;
      return {
              id: fila.id,
              empresaId: fila.empresa_id,
              nombre: fila.nombre,
              contacto: fila.contacto,
              puntos: fila.puntos,
              googleObjectId: fila.google_object_id,
              creado: fila.creado.toISOString()
      };
}

// ---- empresas ----
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

async function crearEmpresa(data) {
      const id = crypto.randomUUID();
      try {
              const { rows } = await pool.query(
                        `INSERT INTO empresas (id, nombre, email, password_hash, logo_url, color, recompensa, umbral, activa)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING *`,
                        [
                                    id,
                                    data.nombre,
                                    data.email || null,
                                    data.password ? hashPassword(data.password) : null,
                                    data.logoUrl || null,
                                    data.color || '#b8872b',
                                    data.recompensa || '',
                                    Number(data.umbral) || 10
                                  ]
                      );
              return filaAEmpresa(rows[0]);
      } catch (e) {
              if (e.code === '23505') {
                        throw new Error('Ya existe una empresa registrada con ese email');
              }
              throw e;
      }
}

async function obtenerEmpresa(id) {
      const { rows } = await pool.query('SELECT * FROM empresas WHERE id = $1', [id]);
      return filaAEmpresa(rows[0]);
}

async function obtenerEmpresaPorEmail(email) {
      const { rows } = await pool.query('SELECT * FROM empresas WHERE email = $1', [email]);
      return filaAEmpresa(rows[0]);
}

async function listarEmpresas() {
      const { rows } = await pool.query('SELECT * FROM empresas ORDER BY creado DESC');
      return rows.map(filaAEmpresa);
}

async function setActivaEmpresa(id, activa) {
      const { rows } = await pool.query(
              'UPDATE empresas SET activa = $2 WHERE id = $1 RETURNING *',
              [id, !!activa]
            );
      return filaAEmpresa(rows[0]);
}

async function validarLogin(email, password) {
      const empresa = await obtenerEmpresaPorEmail(email);
      if (!empresa || !empresa.passwordHash) return null;
      if (!verificarPassword(password, empresa.passwordHash)) return null;
      return empresa;
}

async function actualizarEmpresa(id, cambios) {
      const permitido = {};
      for (const campo of ['nombre', 'color', 'recompensa', 'umbral', 'logoUrl']) {
              if (cambios[campo] !== undefined) permitido[campo] = cambios[campo];
      }
      const columnas = {
              nombre: 'nombre',
              color: 'color',
              recompensa: 'recompensa',
              umbral: 'umbral',
              logoUrl: 'logo_url'
      };
      const sets = [];
      const valores = [id];
      for (const [campo, valor] of Object.entries(permitido)) {
              valores.push(valor);
              sets.push(`${columnas[campo]} = $${valores.length}`);
      }
      if (sets.length === 0) return obtenerEmpresa(id);
      const { rows } = await pool.query(
              `UPDATE empresas SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
              valores
            );
      return filaAEmpresa(rows[0]);
}

// ---- consultas filtradas por empresa, para el panel ----
async function clientesDeEmpresa(empresaId) {
      const { rows } = await pool.query(
              'SELECT * FROM clientes WHERE empresa_id = $1 ORDER BY creado DESC',
              [empresaId]
            );
      return rows.map(filaACliente);
}

async function estadisticasDeEmpresa(empresaId) {
      const { rows: clientesRows } = await pool.query(
              'SELECT * FROM clientes WHERE empresa_id = $1',
              [empresaId]
            );
      const { rows: visitasHoyRows } = await pool.query(
              `SELECT count(*)::int AS n FROM visitas v
                   JOIN clientes c ON c.id = v.cliente_id
                        WHERE c.empresa_id = $1 AND v.fecha = CURRENT_DATE`,
              [empresaId]
            );
      const { rows: canjesRows } = await pool.query(
              `SELECT count(*)::int AS n FROM canjes k
                   JOIN clientes c ON c.id = k.cliente_id
                        WHERE c.empresa_id = $1 AND k.usado = false`,
              [empresaId]
            );
      return {
              totalClientes: clientesRows.length,
              visitasHoy: visitasHoyRows[0].n,
              canjesPendientes: canjesRows[0].n,
              puntosRepartidos: clientesRows.reduce((sum, c) => sum + c.puntos, 0)
      };
}

// ---- clientes ----
async function crearCliente(data) {
      const contacto = (data.contacto || '').trim();
      // Evita duplicados: si ya existe un cliente con el mismo contacto
  // (teléfono o email) para esta misma empresa, se reutiliza ese cliente
  // en vez de crear uno nuevo — así la misma persona no termina con dos
  // tarjetas de lealtad distintas solo por volver a llenar el formulario.
  if (contacto) {
          const { rows } = await pool.query(
                    `SELECT * FROM clientes WHERE empresa_id = $1 AND lower(btrim(contacto)) = lower($2)`,
                    [data.empresaId, contacto]
                  );
          if (rows[0]) return filaACliente(rows[0]);
  }

  const id = crypto.randomUUID();
      try {
              const { rows } = await pool.query(
                        `INSERT INTO clientes (id, empresa_id, nombre, contacto, puntos)
                               VALUES ($1,$2,$3,$4,0) RETURNING *`,
                        [id, data.empresaId, data.nombre, contacto]
                      );
              return filaACliente(rows[0]);
      } catch (e) {
              // Carrera: dos registros al mismo tiempo con el mismo contacto.
        // El índice único de la base de datos gana; devolvemos el que ya quedó.
        if (e.code === '23505' && contacto) {
                  const { rows } = await pool.query(
                              `SELECT * FROM clientes WHERE empresa_id = $1 AND lower(btrim(contacto)) = lower($2)`,
                              [data.empresaId, contacto]
                            );
                  if (rows[0]) return filaACliente(rows[0]);
        }
              throw e;
      }
}

async function obtenerCliente(id) {
      const { rows } = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
      return filaACliente(rows[0]);
}

async function actualizarCliente(id, cambios) {
      const campoPorClave = { puntos: 'puntos', googleObjectId: 'google_object_id', nombre: 'nombre', contacto: 'contacto' };
      const sets = [];
      const valores = [id];
      for (const [campo, valor] of Object.entries(cambios)) {
              const columna = campoPorClave[campo];
              if (!columna) continue;
              valores.push(valor);
              sets.push(`${columna} = $${valores.length}`);
      }
      if (sets.length === 0) return obtenerCliente(id);
      const { rows } = await pool.query(
              `UPDATE clientes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
              valores
            );
      return filaACliente(rows[0]);
}

// ---- visitas (antifraude: una por día por cliente) ----
async function yaVisitoHoy(clienteId) {
      const { rows } = await pool.query(
              `SELECT 1 FROM visitas WHERE cliente_id = $1 AND fecha = CURRENT_DATE LIMIT 1`,
              [clienteId]
            );
      return rows.length > 0;
}

async function registrarVisita(clienteId) {
      const id = crypto.randomUUID();
      await pool.query(
              `INSERT INTO visitas (id, cliente_id, fecha) VALUES ($1,$2,CURRENT_DATE)`,
              [id, clienteId]
            );
      const { rows } = await pool.query(
              `UPDATE clientes SET puntos = puntos + 1 WHERE id = $1 RETURNING *`,
              [clienteId]
            );
      return filaACliente(rows[0]);
}

// ---- canjes (código de un solo uso, distinto al QR del cliente) ----
async function crearCanje(clienteId) {
      const codigo = crypto.randomUUID();
      const { rows } = await pool.query(
              `INSERT INTO canjes (codigo, cliente_id, usado) VALUES ($1,$2,false) RETURNING *`,
              [codigo, clienteId]
            );
      return { codigo: rows[0].codigo, clienteId: rows[0].cliente_id, usado: rows[0].usado, creado: rows[0].creado.toISOString() };
}

async function confirmarCanje(codigo, empresaId) {
      const { rows } = await pool.query('SELECT * FROM canjes WHERE codigo = $1', [codigo]);
      const canje = rows[0];
      if (!canje) return { ok: false, razon: 'codigo_no_existe' };
      if (canje.usado) return { ok: false, razon: 'ya_usado' };

  const cliente = await obtenerCliente(canje.cliente_id);
      if (!cliente) return { ok: false, razon: 'cliente_no_encontrado' };
      // Un negocio solo puede confirmar canjes de SUS propios clientes —
      // sin esto, cualquier negocio con sesión podría confirmar (y restar
      // puntos de) un canje generado por otro negocio si llegara a conocer
      // el código.
      if (empresaId && cliente.empresaId !== empresaId) {
              return { ok: false, razon: 'no_pertenece' };
      }
      const empresa = await obtenerEmpresa(cliente.empresaId);
      const umbral = empresa ? empresa.umbral : 10;

  await pool.query(`UPDATE canjes SET usado = true, usado_el = now() WHERE codigo = $1`, [codigo]);
      const { rows: clienteRows } = await pool.query(
              `UPDATE clientes SET puntos = GREATEST(0, puntos - $2) WHERE id = $1 RETURNING *`,
              [canje.cliente_id, umbral]
            );
      return { ok: true, cliente: filaACliente(clienteRows[0]) };
}

module.exports = {
      init,
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
