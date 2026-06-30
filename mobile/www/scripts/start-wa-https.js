#!/usr/bin/env node
/** Start WhatsApp server with HTTPS required (certs must exist). */
process.env.USE_HTTPS = "1";
require("../whatsapp-server.js");
