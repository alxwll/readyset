// Ready. Set. – kleiner Server (Cloudflare Worker)
// Aufgaben:
//  1. Text-Workouts: nimmt den Wunsch oder ein eingefügtes Workout entgegen und fragt die KI
//     (Gemini, bei Problemen Groq). Die Keys liegen nur hier, nie in der App.
//  2. Geräte koppeln: speichert verschlüsselte Datenpakete. Der Server kann sie nicht lesen.
//
// Secrets (Settings → Variables and Secrets, Typ "Secret"):
//   GEMINI_API_KEY   Pflicht für die Textfunktion
//   GROQ_API_KEY     optional, Rückfall wenn Gemini nicht antwortet
// KV-Bindung (Settings → Bindings): RS
// Variablen (optional, Typ "Text"):
//   ALLOWED_ORIGIN   Standard https://alxwll.github.io
//   PER_DEVICE_DAY   Text-Workouts pro Gerät und Tag, Standard 10
//   PER_IP_DAY       Text-Workouts pro Internetanschluss und Tag, Standard 20
//   TOTAL_DAY        Text-Workouts für alle zusammen pro Tag, Standard 100
//   GEMINI_MODEL     Standard gemini-flash-latest
//   GROQ_MODEL       Standard meta-llama/llama-4-scout-17b-16e-instruct

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || 'https://alxwll.github.io';
    const reqOrigin = req.headers.get('Origin') || '';
    const okOrigin = reqOrigin === origin || /^http:\/\/localhost(:\d+)?$/.test(reqOrigin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? reqOrigin : origin,
      'Access-Control-Allow-Headers': 'Content-Type, X-RS-Device',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (url.pathname === '/' ) return json({ app: 'Ready. Set.', ok: true, ai: !!env.GEMINI_API_KEY, groq: !!env.GROQ_API_KEY, kv: !!env.RS }, 200, cors);
    if (!okOrigin) return json({ error: 'Nur die App Ready. Set. darf diesen Server nutzen.' }, 403, cors);
    if (!env.RS) return json({ error: 'KV-Bindung "RS" fehlt im Worker. Siehe Anleitung.' }, 500, cors);

    try {
      if (url.pathname === '/api/ai/status' && req.method === 'GET') return await aiStatus(req, env, cors);
      if (url.pathname === '/api/ai/workout' && req.method === 'POST') return await aiWorkout(req, env, cors);
      const sm = url.pathname.match(/^\/api\/sync\/([A-Za-z0-9_-]{32,64})$/);
      if (sm) return await sync(req, env, cors, sm[1]);
      return json({ error: 'Unbekannter Pfad' }, 404, cors);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, cors);
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
const num = (v, d) => { const n = parseInt(v, 10); return isFinite(n) && n > 0 ? n : d; };
const ipOf = req => req.headers.get('CF-Connecting-IP') || 'unbekannt';
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- Grenzen: pro Gerät, pro Anschluss, für alle ---------- */
async function limits(req, env) {
  const d = today();
  const dev = (req.headers.get('X-RS-Device') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'ohne';
  const ip = await sha(ipOf(req)); // IP nur gehasht speichern
  const keys = { dev: `n:dev:${d}:${dev}`, ip: `n:ip:${d}:${ip}`, all: `n:all:${d}` };
  const max = { dev: num(env.PER_DEVICE_DAY, 10), ip: num(env.PER_IP_DAY, 20), all: num(env.TOTAL_DAY, 100) };
  const cur = {};
  for (const k of Object.keys(keys)) cur[k] = num(await env.RS.get(keys[k]), 0);
  const left = Math.max(0, Math.min(max.dev - cur.dev, max.ip - cur.ip, max.all - cur.all));
  const why = cur.all >= max.all ? 'all' : (cur.dev >= max.dev || cur.ip >= max.ip) ? 'device' : null;
  const count = async () => { for (const k of Object.keys(keys)) await env.RS.put(keys[k], String(cur[k] + 1), { expirationTtl: 60 * 60 * 48 }); };
  return { left, why, count, perDevice: max.dev };
}

async function aiStatus(req, env, cors) {
  const l = await limits(req, env);
  return json({ ai: !!env.GEMINI_API_KEY || !!env.GROQ_API_KEY, left: l.left, perDevice: l.perDevice }, 200, cors);
}

/* ---------- Text-Workout ---------- */
// Die Anweisungen stehen bewusst hier und nicht in der App: Der Server beantwortet nur Workout-Anfragen.
function instructions(eq) {
  return `Du bekommst einen Text von einer Person, die ein Workout in ihrer Fitness-App haben möchte. Es gibt zwei Fälle:
1. "import": Der Text ist ein fertiges Workout, meist von einer anderen KI erstellt, mit Übungen, Sätzen und Wiederholungen. Übernimm es genau so und ordne jede Übung dem Katalog zu.
2. "create": Der Text ist ein Wunsch oder eine Situation, z. B. "Erstelle mir eine Plank-Challenge" oder "Ich war gestern laufen, meine Beine sind müde". Stelle dann selbst ein passendes, sinnvolles Workout zusammen, ausschließlich mit Übungen aus dem Katalog (match immer "exact"). Berücksichtige Erschöpfung, Ziel und gewünschte Dauer aus dem Text. Erschöpfte Körperteile dürfen auch nicht nebenbei belastet werden: Bei müden Beinen (z. B. nach Laufen, Radfahren, Beintag) nur Übungen mit „Beine: keine“ wählen, höchstens eine mit „Beine: leicht“, niemals „Beine: stark“. Keine Sprünge, Mountain Climber, Burpees oder Übungen im Stand mit Beinarbeit. Bei anderen müden Körperteilen genauso: Prüfe die Muskeln jeder Übung, auch Stütz- und Haltearbeit (z. B. Planks belasten die Schultern). Ohne Angabe: etwa 20 Minuten, 4 bis 6 Übungen. Nutze bevorzugt dieses Equipment, außer der Text nennt anderes: ${eq}. Wähle keine Aufwärm- oder Dehnübungen, die ergänzt die App selbst, außer der Wunsch ist ausdrücklich eine Mobility- oder Dehn-Einheit. Schreibe in "note" einen kurzen, motivierenden Satz auf Deutsch, warum das Workout passt.
Ist der Text weder ein Workout noch ein Trainingswunsch, antworte mit {"mode":"none","items":[]}.

Regeln:
- match "exact": dieselbe Übung, Sprache egal (z. B. "Wadenheben" = calfraise, "Ausfallschritte im Gehen" = lunge).
- match "similar": gleiche Bewegung, aber andere Variante oder anderes Gerät (z. B. "Bulgarian Split Squat" ähnelt lunge). ex = der ähnlichste key.
- match "none": nichts Vergleichbares im Katalog. ex = null.
- name: Übungsname wie im Text, ohne Nummerierung.
- sets: Anzahl Sätze (Standard 1). reps: Wiederholungen als Zahl oder null. sec: Sekunden, falls zeitbasiert, sonst null.
- perSide: true bei "pro Bein", "pro Seite", "pro Arm" und Ähnlichem. reps gilt dann pro Seite.
- rest: Pause in Sekunden nach jedem Satz (Standard 60).
- tip: kurzer Ausführungshinweis aus dem Text auf Deutsch, sonst "".
- title: kurzer deutscher Name für das Workout, höchstens 4 Wörter.
- focus: upper, lower, core oder full.
- mode: "import" oder "create".
- note: nur bei "create", sonst "".

Antworte nur mit JSON in genau dieser Form:
{"mode":"import","note":"","title":"Beine mit Gewicht","focus":"lower","items":[{"name":"Goblet Squat","ex":"gobletsquat","match":"exact","sets":3,"reps":12,"sec":null,"perSide":false,"rest":60,"tip":"Gewicht an der Brust, in die Fersen setzen"}]}`;
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n|<>]/g, ' ').slice(0, n);

async function aiWorkout(req, env, cors) {
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) return json({ error: 'Die Textfunktion ist noch nicht eingerichtet.', code: 'no_key' }, 503, cors);
  const b = await req.json().catch(() => ({}));
  const text = String(b.text || '').slice(0, 6000).trim();
  if (!text) return json({ error: 'Kein Text', code: 'empty' }, 400, cors);
  // Katalog: [key, Name, Bereich, Equipment, Muskeln, Beinbelastung]
  const rows = (Array.isArray(b.catalog) ? b.catalog : []).slice(0, 500)
    .filter(r => Array.isArray(r) && /^[a-z0-9]{2,40}$/.test(String(r[0])));
  if (rows.length < 10) return json({ error: 'Katalog fehlt', code: 'catalog' }, 400, cors);
  const eq = clean(b.eq, 300) || 'ohne Geräte';

  const l = await limits(req, env);
  if (l.left <= 0) return json({ error: 'Limit erreicht', code: l.why === 'all' ? 'limit_all' : 'limit_device' }, 429, cors);

  const full = rows.map(r => [0, 1, 2, 3, 4, 5].map(i => clean(r[i], i === 4 ? 80 : 40)).join(' | ')).join('\n');
  const slim = rows.map(r => [0, 1, 2, 3, 5].map(i => clean(r[i], 40)).join(' | ')).join('\n');
  const tail = `\n\nDer Text steht zwischen <<< und >>>:\n<<<\n${text}\n>>>`;
  const promptFull = `${instructions(eq)}\n\nKatalog (key | Name | Bereich | Equipment | Muskeln | Beinbelastung):\n${full}${tail}`;
  const promptSlim = `${instructions(eq)}\n\nKatalog (key | Name | Bereich | Equipment | Beinbelastung):\n${slim}${tail}`;

  const tries = [];
  if (env.GEMINI_API_KEY) tries.push(['Gemini', () => gemini(env.GEMINI_API_KEY, env.GEMINI_MODEL || 'gemini-flash-latest', promptFull)]);
  if (env.GROQ_API_KEY) tries.push(['Groq', () => groq(env.GROQ_API_KEY, env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct', promptSlim)]);
  const errors = [];
  for (const [name, run] of tries) {
    try {
      const raw = await withTimeout(run(), 60000);
      const data = parseJson(raw);
      if (!data || !Array.isArray(data.items)) throw new Error('keine lesbare Antwort');
      await l.count();
      return json({ data, provider: name, left: l.left - 1 }, 200, cors);
    } catch (e) { errors.push(`${name}: ${String(e.message || e).slice(0, 160)}`); }
  }
  return json({ error: errors.join(' | '), code: 'ai_failed' }, 502, cors);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`keine Antwort nach ${ms / 1000} s`)), ms))]);
}
function parseJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
async function gemini(key, model, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json', maxOutputTokens: 4000 },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return (d.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('').trim();
}
async function groq(key, model, prompt) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0.4, max_tokens: 3000, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  return (d.choices?.[0]?.message?.content || '').trim();
}

/* ---------- Geräte koppeln: verschlüsselte Pakete ---------- */
// Die App verschlüsselt alles selbst. Hier liegt nur ein unlesbarer Block unter einer Nummer.
async function sync(req, env, cors, id) {
  const key = `s:${id}`;
  if (req.method === 'GET') {
    const v = await env.RS.get(key);
    return v ? json(JSON.parse(v), 200, cors) : json({ error: 'Nicht gefunden' }, 404, cors);
  }
  if (req.method === 'PUT') {
    const b = await req.json().catch(() => ({}));
    const blob = String(b.blob || '');
    if (!blob || blob.length > 900000 || !/^[A-Za-z0-9+/=._-]+$/.test(blob)) return json({ error: 'Ungültiges Paket' }, 400, cors);
    const ipKey = `n:sync:${today()}:${await sha(ipOf(req))}`;
    const n = num(await env.RS.get(ipKey), 0);
    if (n >= 200) return json({ error: 'Zu viele Speichervorgänge heute', code: 'limit_sync' }, 429, cors);
    const old = await env.RS.get(key);
    const cur = old ? JSON.parse(old) : null;
    if (cur && b.base !== cur.rev) return json({ error: 'Neuerer Stand vorhanden', code: 'conflict', ...cur }, 409, cors);
    const next = { blob, rev: crypto.randomUUID(), t: Date.now() };
    await env.RS.put(key, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 400 }); // ein gutes Jahr ohne Nutzung, dann weg
    await env.RS.put(ipKey, String(n + 1), { expirationTtl: 60 * 60 * 48 });
    return json({ rev: next.rev, t: next.t }, 200, cors);
  }
  if (req.method === 'DELETE') { await env.RS.delete(key); return json({ ok: true }, 200, cors); }
  return json({ error: 'Methode nicht erlaubt' }, 405, cors);
}
