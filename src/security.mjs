import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sameSecret } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = process.env.GMAIL_CONTROL_DATA_DIR
  ? path.resolve(process.env.GMAIL_CONTROL_DATA_DIR)
  : path.join(root, "data");
const keyPath = path.join(dataDir, "agent-key.txt");

fs.mkdirSync(dataDir, { recursive: true });

function privateWrite(file, value) {
  const temp = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function getOrCreateAgentKey() {
  try {
    const existing = fs.readFileSync(keyPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const key = crypto.randomBytes(32).toString("hex");
  privateWrite(keyPath, key + "\n");
  return key;
}

export function agentKeyPath() {
  return keyPath;
}

export function verifyAgentKey(candidate) {
  return sameSecret(getOrCreateAgentKey(), candidate);
}

export function requireAgentKey(req, res, next) {
  const candidate = req.get("x-gmail-control-key") || "";
  if (!verifyAgentKey(candidate)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
