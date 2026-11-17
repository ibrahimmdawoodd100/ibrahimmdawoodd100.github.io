'use strict';
// Emulator-only Functions parameters (WebAuthn relying party = the local test server). Production deploys read only
// .env and .env.signature-7706e, and .env* files are never committed to the Pages repository.
require('node:fs').writeFileSync(require('node:path').join(__dirname, '../functions/.env.demo-basma'), 'WEBAUTHN_RP_ID=localhost\nWEBAUTHN_ORIGINS=http://localhost:4173\nBACKUP_BUCKET=\n');
