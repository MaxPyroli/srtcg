/**
 * Sessions par cookie signé. Le cookie contient l'identifiant du joueur et une date
 * d'expiration, signés en HMAC-SHA256 avec SESSION_SECRET.
 * La connexion Twitch, quand elle sera ajoutée, produira exactement le même cookie.
 */

const enc = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(userId: number, secret: string, ttlSeconds: number, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const payload = toBase64Url(enc.encode(`${userId}.${expires}`));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Renvoie l'identifiant du joueur si le cookie est valide et non expiré, sinon null. */
export async function verifySession(token: string | undefined, secret: string, now = Date.now()): Promise<number | null> {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const sigBytes = fromBase64Url(sig);
  if (!sigBytes) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, enc.encode(payload));
  if (!ok) return null;
  const raw = fromBase64Url(payload);
  if (!raw) return null;
  const [id, expires] = new TextDecoder().decode(raw).split('.').map(Number);
  if (!Number.isInteger(id) || !Number.isInteger(expires)) return null;
  if (expires * 1000 < now) return null;
  return id;
}
