/**
 * The phone and the PC talk end to end encrypted, whatever the network: everything between them
 * (workouts, health, the plan, the coach's key) is sealed with a key only the two of them hold.
 *
 * Pairing: the PC shows a code (10 letters and digits, about 50 bits, for 10 minutes and 5
 * tries). The two make an ECDH (P-256) key exchange, and the link key is HKDF-SHA256 of the
 * shared secret salted with the code; the phone proves it holds it first, then the PC. Someone
 * listening learns nothing; someone in the middle would have to guess the code, offline in the
 * pairing window (2^50 tries in 10 minutes) or online (5 tries). The PC then keeps the phone's
 * key (link/devices.json, owner-only), the phone the PC's.
 *
 * After that every request goes as one sealed message to /api/link/tunnel: AES-256-GCM with a
 * fresh 96-bit nonce, the device id as associated data, a timestamp inside (10 minutes either
 * way, and nothing sealed before the PC last started) and each nonce taken once, so a message
 * can't be replayed, moved to another device or changed. The answer comes back sealed the same
 * way, bound to the request's nonce, so an old answer can't be passed off for a new request. No
 * token or plain data crosses the network, and the phone pairs only with an address on its own
 * network (isHomeAddress), so a pairing link someone sends can't point it at their server.
 */

const subtle = () => globalThis.crypto.subtle;
/** WebCrypto wants plain ArrayBuffer views. */
const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The pairing code's letters: no 0/O, 1/I/L. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(r, (b) => ALPHABET[b % ALPHABET.length]).join("");
}
/** "k7qm3 xpa9r" or "K7QM3-XPA9R" → "K7QM3XPA9R" (case, spaces and dashes don't matter). */
export const normCode = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");
export const showCode = (c: string) => `${c.slice(0, 5)}-${c.slice(5)}`;

export async function keyPair(): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const k = (await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
  return { priv: k.privateKey, pub: new Uint8Array(await subtle().exportKey("raw", k.publicKey)) };
}

/** The link key from our private key, their public key and the code. */
export async function linkKey(priv: CryptoKey, theirPub: Uint8Array, code: string): Promise<Uint8Array> {
  const pub = await subtle().importKey("raw", buf(theirPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle().deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode(`tartan-pair:${normCode(code)}`), info: enc.encode("tartan-link-v1") }, ikm, 256));
}

const aes = (raw: Uint8Array) => subtle().importKey("raw", buf(raw), "AES-GCM", false, ["encrypt", "decrypt"]);

/** nonce ‖ ciphertext (with its tag). */
export async function seal(key: Uint8Array, data: Uint8Array, aad = ""): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aes(key), buf(data)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

/** Throws when the key, the associated data or a single bit is wrong. */
export async function unseal(key: Uint8Array, sealed: Uint8Array, aad = ""): Promise<Uint8Array> {
  if (sealed.length < 28) throw new Error("too short");
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buf(sealed.subarray(0, 12)), additionalData: enc.encode(aad) }, await aes(key), buf(sealed.subarray(12))));
}

/** A header (JSON) and a body in one message: length ‖ header ‖ body. */
export function frame(head: object, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const h = enc.encode(JSON.stringify(head));
  const out = new Uint8Array(4 + h.length + body.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(body, 4 + h.length);
  return out;
}
export function unframe<T>(u: Uint8Array): { head: T; body: Uint8Array } {
  const n = new DataView(u.buffer, u.byteOffset, u.byteLength).getUint32(0);
  return { head: JSON.parse(dec.decode(u.subarray(4, 4 + n))) as T, body: u.subarray(4 + n) };
}

export interface Link {
  /** The PC's address on the home network. */
  url: string;
  /** This phone's id on the PC. */
  device: string;
  /** The link key, base64. */
  key: string;
  /** The PC's name, to show. */
  name?: string;
}

const SKEW = 10 * 60_000;

/** fetch through the tunnel: the same Request in, the same Response out, sealed on the way. */
export function tunnel(link: Link, f: typeof fetch = fetch): (path: string, init?: RequestInit) => Promise<Response> {
  const key = unb64(link.key);
  return async (path, init = {}) => {
    const body = init.body == null ? new Uint8Array(0) : typeof init.body === "string" ? enc.encode(init.body) : init.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const sealed = await seal(key, frame({ m: init.method ?? "GET", p: path, h: headers, ts: Date.now() }, body), link.device);
    const nonce = b64(sealed.subarray(0, 12));
    const res = await fetchWithin(f, `${link.url.replace(/\/$/, "")}/api/link/tunnel`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-tartan-device": link.device }, body: sealed as BodyInit }, 60_000);
    if (res.status === 401) throw new Error("The PC doesn't know this phone any more: pair it again in Settings.");
    if (res.status === 409) throw new Error("The PC and this phone disagree on the time, or the PC just restarted: try again in a minute (check both clocks are set automatically).");
    if (!res.ok) throw new Error(`The PC answered ${res.status}`);
    const { head, body: out } = unframe<{ s: number; h: Record<string, string> }>(await unseal(key, new Uint8Array(await res.arrayBuffer()), `${link.device}:reply:${nonce}`));
    return new Response([204, 304].includes(head.s) ? null : (out.slice() as BodyInit), { status: head.s, headers: head.h });
  };
}

/**
 * The PC's side of the tunnel: open the message, answer it with `handle`, seal the answer (bound
 * to that message, so an old answer can't stand in for it). `since`: when this PC started; the
 * nonces seen before then are gone, so nothing older is taken (no replay across a restart).
 */
export async function serveTunnel(req: Request, keyOf: (device: string) => Promise<Uint8Array | null>, handle: (r: Request) => Promise<Response>, seen: Map<string, number>, since = 0): Promise<Response> {
  const device = req.headers.get("x-tartan-device") ?? "";
  const key = device ? await keyOf(device) : null;
  if (!key) return new Response("unknown device", { status: 401 });
  const sealed = new Uint8Array(await req.arrayBuffer());
  let msg: { head: { m: string; p: string; h: Record<string, string>; ts: number }; body: Uint8Array };
  try {
    msg = unframe(await unseal(key, sealed, device));
  } catch {
    return new Response("bad message", { status: 401 });
  }
  // Fresh, and once only.
  const now = Date.now();
  const nonce = b64(sealed.subarray(0, 12));
  for (const [k, t] of seen) if (now - t > 2 * SKEW) seen.delete(k);
  if (Math.abs(now - msg.head.ts) > SKEW || msg.head.ts < since || seen.has(nonce)) return new Response("stale message", { status: 409 });
  seen.set(nonce, now);
  if (!msg.head.p.startsWith("/api/") || msg.head.p.startsWith("/api/link/tunnel") || msg.head.p.startsWith("/api/pair")) return new Response("not here", { status: 400 });
  const inner = new Request(new URL(msg.head.p, "http://tartan.link"), { method: msg.head.m, headers: msg.head.h, body: ["GET", "HEAD"].includes(msg.head.m) ? undefined : (msg.body.slice() as BodyInit) });
  const res = await handle(inner);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  const reply = await seal(key, frame({ s: res.status, h: headers }, new Uint8Array(await res.arrayBuffer())), `${device}:reply:${nonce}`);
  return new Response(reply as BodyInit, { headers: { "content-type": "application/octet-stream" } });
}

/** The phone's side of pairing: hello, prove the key, check the PC's proof. */
/** fetch that gives up after `ms` (a phone that can't reach an address waits a long time otherwise). */
export async function fetchWithin(f: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new Error(ctl.signal.aborted ? `no answer from ${url.replace(/^https?:\/\//, "").replace(/\/.*$/, "")} within ${Math.round(ms / 1000)} s` : (e as Error).message);
  } finally {
    clearTimeout(t);
  }
}

/** Which of the PC's addresses this phone reaches: all tried at once, the first that answers. */
/**
 * A PC on this phone's own network: a private or link-local address (192.168.x, 10.x, 172.16–31.x,
 * 169.254.x, fd00::/fe80::, Tailscale's 100.64/10), a .local name or a bare host name. Anything on
 * the open internet is refused, so a link someone sends can't pair this phone with their server.
 */
export function isHomeAddress(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(":")) return /^(fc|fd|fe[89ab])/.test(host) || host === "::1";
  return host === "localhost" || host.endsWith(".local") || !host.includes(".");
}

export async function findPc(urls: string[], f: typeof fetch = fetch, ms = 4000): Promise<string> {
  const all = [...new Set(urls.map((u) => u.replace(/\/$/, "")).filter(Boolean))];
  const list = all.filter(isHomeAddress);
  if (!list.length) throw new Error(all.length ? `${all.map((u) => u.replace(/^https?:\/\//, "")).join(", ")} isn't on your home network. Tartan pairs only with a PC on the same Wi-Fi.` : "No address for the PC.");
  try {
    return await Promise.any(
      list.map(async (u) => {
        const res = await fetchWithin(f, `${u}/api/pair/ping`, {}, ms);
        if (!res.ok || !((await res.json().catch(() => ({}))) as { tartan?: boolean }).tartan) throw new Error(`${u} isn't Tartan`);
        return u;
      }),
    );
  } catch {
    throw new Error(`Can't reach your PC at ${list.map((u) => u.replace(/^http:\/\//, "")).join(" or ")}. Is this phone on the same Wi-Fi, and Tartan running there with --lan? On Windows, allow Bun through the firewall for private networks.`);
  }
}

export async function pairWith(url: string, code: string, phoneName: string, f: typeof fetch = fetch): Promise<Link> {
  const base = url.replace(/\/$/, "");
  const post = async (path: string, body: object) => {
    const res = await fetchWithin(f, `${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 10_000);
    const j = (await res.json().catch(() => ({}))) as Record<string, string> & { error?: string };
    if (!res.ok) throw new Error(j.error ?? `The PC answered ${res.status}`);
    return j;
  };
  const me = await keyPair();
  const hello = await post("/api/pair/hello", { pub: b64(me.pub) });
  const key = await linkKey(me.priv, unb64(hello.pub!), code);
  const done = await post("/api/pair/confirm", { session: hello.session, proof: b64(await seal(key, enc.encode("tartan-phone"), "pair")), name: phoneName });
  // The PC proves it knew the code too.
  const pc = JSON.parse(dec.decode(await unseal(key, unb64(done.box!), "pair-reply").catch(() => {
    throw new Error("The PC's answer didn't check out: pair again.");
  }))) as { name: string };
  return { url: base, device: done.device!, key: b64(key), name: pc.name };
}

/** The PC's side of pairing, between start and the phone's proof. */
export class PairingDesk {
  private open: { code: string; until: number; tries: number; sessions: Map<string, Uint8Array> } | null = null;

  constructor(private readonly save: (device: string, key: Uint8Array, name: string) => Promise<void>, private readonly pcName: string) {}

  start(minutes = 10): { code: string; until: number } {
    this.open = { code: newCode(), until: Date.now() + minutes * 60_000, tries: 0, sessions: new Map() };
    return { code: this.open.code, until: this.open.until };
  }

  private live() {
    if (this.open && Date.now() > this.open.until) this.open = null;
    return this.open;
  }

  async hello(body: { pub?: string }): Promise<{ session: string; pub: string } | { error: string }> {
    const o = this.live();
    if (!o) return { error: "No pairing is open on the PC: press Pair a phone there." };
    if (o.sessions.size >= 20 || !body.pub) return { error: "Too many tries: start pairing again on the PC." };
    const me = await keyPair();
    const session = b64(crypto.getRandomValues(new Uint8Array(12)));
    o.sessions.set(session, await linkKey(me.priv, unb64(body.pub), o.code));
    return { session, pub: b64(me.pub) };
  }

  async confirm(body: { session?: string; proof?: string; name?: string }): Promise<{ device: string; box: string } | { error: string }> {
    const o = this.live();
    const key = o?.sessions.get(body.session ?? "");
    if (!o || !key) return { error: "No pairing is open on the PC: press Pair a phone there." };
    // One proof per session, counted before any waiting: guesses in parallel count too.
    o.sessions.delete(body.session!);
    if (++o.tries > 5) return (this.open = null), { error: "Wrong code too often: start pairing again on the PC." };
    try {
      const said = new TextDecoder().decode(await unseal(key, unb64(body.proof ?? ""), "pair"));
      if (said !== "tartan-phone") throw new Error();
    } catch {
      if (o.tries >= 5) this.open = null;
      return { error: o.tries >= 5 ? "Wrong code too often: start pairing again on the PC." : "That code doesn't match the one on the PC." };
    }
    if (this.open !== o) return { error: "No pairing is open on the PC: press Pair a phone there." };
    this.open = null;
    const device = b64(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, "x");
    await this.save(device, key, String(body.name ?? "Phone").slice(0, 60));
    return { device, box: b64(await seal(key, enc.encode(JSON.stringify({ name: this.pcName })), "pair-reply")) };
  }
}
