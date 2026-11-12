// Firma y arma el archivo .pkpass del cliente usando passkit-generator.
// Necesita los certificados del Paso 3 (Apple Developer) dentro de /certs
// y una plantilla base en /pass-model (ver ese folder y el README).
const path = require('path');
const fs = require('fs');
const { PKPass } = require('passkit-generator');

function certificadosListos() {
    return (
          process.env.APPLE_WWDR_PATH &&
          process.env.APPLE_SIGNER_CERT_PATH &&
          process.env.APPLE_SIGNER_KEY_PATH &&
          fs.existsSync(process.env.APPLE_WWDR_PATH) &&
          fs.existsSync(process.env.APPLE_SIGNER_CERT_PATH) &&
          fs.existsSync(process.env.APPLE_SIGNER_KEY_PATH)
        );
}

async function generarPkpass(empresa, cliente) {
    if (!certificadosListos()) {
          throw new Error(
                  'Faltan los certificados de Apple en /certs (wwdr.pem, signerCert.pem, signerKey.pem). Ver README, Paso 3.'
                );
    }

  const pass = await PKPass.from(
    {
            model: path.join(__dirname, '..', 'pass-model'),
            certificates: {
                      wwdr: fs.readFileSync(process.env.APPLE_WWDR_PATH),
                      signerCert: fs.readFileSync(process.env.APPLE_SIGNER_CERT_PATH),
                      signerKey: fs.readFileSync(process.env.APPLE_SIGNER_KEY_PATH),
                      signerKeyPassphrase: process.env.APPLE_SIGNER_KEY_PASSPHRASE || undefined
            }
    },
    {
            serialNumber: cliente.id,
            description: `${empresa.nombre} — Lealtad`,
            organizationName: empresa.nombre,
            teamIdentifier: process.env.APPLE_TEAM_ID,
            passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID,
            backgroundColor: hexToRgb(empresa.color || '#b8872b'),
            webServiceURL: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/api/apple` : undefined,
            authenticationToken: cliente.id
    }
      );

  pass.type = 'storeCard';
    // Nombre de la empresa dueña de este pase (NO "ARGAYES" — cada negocio
  // que usa la plataforma ve su propio nombre aquí, junto al ícono genérico).
  pass.logoText = empresa.nombre;
    pass.primaryFields.push({ key: 'puntos', label: 'PUNTOS', value: cliente.puntos });
    pass.secondaryFields.push({ key: 'cliente', label: 'CLIENTE', value: cliente.nombre });
    pass.setBarcodes({ message: cliente.id, format: 'PKBarcodeFormatQR' });

  return pass.getAsBuffer();
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
}

module.exports = { generarPkpass, certificadosListos };
