// Genera el link "Guardar en Google Wallet" sin necesidad de llamar antes a
// la API para crear la clase/objeto: se firma un JWT que trae la definición
// de la tarjeta adentro, y Google la crea en automático cuando el cliente
// toca "Guardar". Para actualizar el saldo después (Paso 8 de la guía), eso
// sí usa la API con el access token del service account (ver patchPuntos).
const jwt = require('jsonwebtoken');

function credenciales() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  // Puede ser la ruta a un archivo .json o el JSON pegado directo en la env var.
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw);
    return JSON.parse(require('fs').readFileSync(raw, 'utf8'));
  } catch (e) {
    return null;
  }
}

function claseId(issuerId) {
  return `${issuerId}.argayes_lealtad`;
}

function objetoId(issuerId, clienteId) {
  return `${issuerId}.cliente_${clienteId}`;
}

function construirLoyaltyClass(issuerId, empresa) {
  return {
    id: claseId(issuerId),
    issuerName: empresa.nombre,
    programName: `${empresa.nombre} — Lealtad`,
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: empresa.color || '#b8872b'
  };
}

function construirLoyaltyObject(issuerId, empresa, cliente) {
  return {
    id: objetoId(issuerId, cliente.id),
    classId: claseId(issuerId),
    state: 'ACTIVE',
    accountName: cliente.nombre,
    accountId: cliente.id,
    loyaltyPoints: {
      label: 'Puntos',
      balance: { int: cliente.puntos }
    },
    barcode: {
      type: 'QR_CODE',
      value: cliente.id
    }
  };
}

// Devuelve el link https://pay.google.com/gp/v/save/<jwt> listo para abrir
// o meter dentro de un QR.
function generarSaveUrl(empresa, cliente) {
  const creds = credenciales();
  const issuerId = process.env.GOOGLE_ISSUER_ID;
  if (!creds || !issuerId) {
    throw new Error(
      'Faltan GOOGLE_SERVICE_ACCOUNT_JSON y/o GOOGLE_ISSUER_ID en las variables de entorno (ver README, Paso 3).'
    );
  }

  const payload = {
    iss: creds.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [],
    payload: {
      loyaltyClasses: [construirLoyaltyClass(issuerId, empresa)],
      loyaltyObjects: [construirLoyaltyObject(issuerId, empresa, cliente)]
    }
  };

  const token = jwt.sign(payload, creds.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

// Para empujar un saldo nuevo a un pase que el cliente YA guardó (Paso 8),
// se necesita un access token OAuth2 del service account y llamar al
// endpoint PATCH de la API REST de Google Wallet. Se deja como función
// aparte porque requiere una llamada HTTP real (fetch) con ese token.
async function patchPuntos(empresa, cliente) {
  const creds = credenciales();
  const issuerId = process.env.GOOGLE_ISSUER_ID;
  if (!creds || !issuerId) return { ok: false, razon: 'sin_credenciales' };

  const accessToken = jwt.sign(
    {
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
      aud: 'https://oauth2.googleapis.com/token',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    },
    creds.private_key,
    { algorithm: 'RS256' }
  );

  // Intercambiar el JWT firmado por un access token real de Google (OAuth2).
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: accessToken
    })
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) return { ok: false, razon: 'oauth_fallo', detalle: tokenJson };

  const patchRes = await fetch(
    `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objetoId(issuerId, cliente.id)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ loyaltyPoints: { label: 'Puntos', balance: { int: cliente.puntos } } })
    }
  );

  return { ok: patchRes.ok, status: patchRes.status };
}

module.exports = { generarSaveUrl, patchPuntos };
