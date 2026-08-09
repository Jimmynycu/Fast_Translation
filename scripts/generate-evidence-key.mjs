import { randomBytes } from "node:crypto";

const key = randomBytes(32).toString("base64");

console.log("Add this value to EVIDENCE_ROOT_KEY_BASE64 in your local .env file:");
console.log(key);
console.log("Keep it secret. Losing it makes encrypted evidence unrecoverable.");
