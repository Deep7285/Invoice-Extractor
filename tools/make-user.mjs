// tools/make-user.mjs
// Usage: node tools/make-user.mjs <username> <password> [--role=user] [--max_pages=10] [--max_files=100] [--expires=2026-12-31]

import { createHash, randomBytes, pbkdf2Sync } from "crypto";

function arg(name, def) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split("=")[1] : def;
}

const username = process.argv[2];
const password = process.argv[3];
if(!username || !password){
  console.error("Usage: node tools/make-user.mjs <username> <password> [--role=user] [--max_pages=10] [--max_files=100] [--expires=YYYY-MM-DD]");
  process.exit(1);
}

const role = arg("role", "user");
const max_pages = Number(arg("max_pages", "10"));
const max_files = Number(arg("max_files", "100"));
const expires = arg("expires", "2099-12-31");

// PBKDF2 params (browser-compatible & light for Workers)
const salt = randomBytes(16);
const iterations = 120000;
const keyLen = 32;
const digest = "sha256";

const derived = pbkdf2Sync(password, salt, iterations, keyLen, digest);

// store as one string: pbkdf2$sha256$iter$base64salt$base64key
const rec = {
  username,
  role,
  quota: { max_pages, max_files },
  expires,
  status: "active",
  hash: `pbkdf2$${digest}$${iterations}$${salt.toString("base64")}$${derived.toString("base64")}`
};

const json = JSON.stringify(rec);
console.log("KV JSON:\n", json);
console.log(`\nTo store:\nwrangler kv:key put --binding=USERS user:${username} '${json.replace(/'/g,"'\\''")}'`);
