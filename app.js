'use strict';
/* Gateway IA — roteador OpenAI-compatível com fallback entre provedores grátis, locais e pagos. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TIER_LABEL = { free: 'Grátis', paid: 'Pago', local: 'Local' };
const WORKER_CODE = "// Cloudflare Worker — proxy CORS para o Gateway IA (só repassa para hosts permitidos)\nconst SECRET = 'TROQUE-POR-UM-SEGREDO-LONGO'; // a URL do proxy no app fica https://SEU-WORKER.workers.dev/SEGREDO\nconst ALLOW = ['api.sambanova.ai', 'integrate.api.nvidia.com', 'api.cloudflare.com', 'ollama.com'];\nexport default {\n  async fetch(req) {\n    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Expose-Headers': '*' };\n    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });\n    const u = new URL(req.url);\n    if (u.pathname.replace(/\\/+$/, '') !== '/' + SECRET) return new Response('proibido', { status: 403, headers: cors });\n    const target = u.searchParams.get('url');\n    if (!target) return new Response('falta ?url=', { status: 400, headers: cors });\n    const t = new URL(target);\n    if (t.protocol !== 'https:' || !ALLOW.includes(t.hostname)) return new Response('host não permitido', { status: 403, headers: cors });\n    const h = new Headers(req.headers); h.delete('origin'); h.delete('referer'); h.delete('host');\n    const r = await fetch(t, { method: req.method, headers: h, body: req.method === 'GET' ? undefined : req.body });\n    const out = new Headers(r.headers); for (const [k, v] of Object.entries(cors)) out.set(k, v);\n    return new Response(r.body, { status: r.status, headers: out });\n  }\n};";
const MODES = [
  ['auto', 'Auto', 'todos na ordem'],
  ['free', 'Grátis', '+ local'],
  ['local', 'Local', 'só Ollama'],
  ['paid', 'Pago', 'só pagos'],
  ['manual', 'Manual', 'um modelo']
];

/* ---------------- Estado ---------------- */
// Armazenamento com fallback em memória (iframes sandbox bloqueiam localStorage).
const MEM = {};
const memStore = { getItem: k => (k in MEM ? MEM[k] : null), setItem: (k, v) => { MEM[k] = String(v); }, removeItem: k => { delete MEM[k]; } };
function probe(name) { try { const s = window[name]; const t = '__gw_probe'; s.setItem(t, '1'); s.removeItem(t); return s; } catch { return null; } }
const PERSIST = probe('localStorage');
const SESSION = probe('sessionStorage') || memStore;
const STORE = PERSIST || memStore;
const LS = {
  get(k, d) { try { const v = STORE.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { STORE.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('Armazenamento cheio — apague conversas antigas'); return false; } }
};

// Provedores personalizados vêm de importação: só aceita campos conhecidos e tipos válidos.
function sanitizeCustom(s) {
  if (!s || !s.custom || typeof s.id !== 'string' || !/^c-[a-z0-9]{4,32}$/.test(s.id)) return null;
  const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const base = str(s.baseURL, 500);
  if (!/^https?:\/\//i.test(base)) return null;
  const models = (Array.isArray(s.models) ? s.models : []).filter(m => m && typeof m.id === 'string' && m.id.length < 200).slice(0, 200)
    .map(m => ({ id: m.id, v: m.v ? 1 : 0, t: m.t ? 1 : 0, a: m.a ? 1 : 0, ...(Array.isArray(m.price) ? { price: [num(m.price[0]), num(m.price[1])] } : {}) }));
  const dm = {}; if (s.disabledModels && typeof s.disabledModels === 'object') for (const k of Object.keys(s.disabledModels)) if (typeof k === 'string') dm[k] = true;
  return { id: s.id, custom: true, name: str(s.name, 80) || 'Personalizado', tier: ['free', 'paid', 'local'].includes(s.tier) ? s.tier : 'free',
    baseURL: base, key: str(s.key, 500), noKey: !!s.noKey, enabled: s.enabled !== false, accountId: '', useProxy: !!s.useProxy,
    rpd: num(s.rpdUser), rpdUser: num(s.rpdUser), models, modelsEdited: true, disabledModels: dm, lastTest: null,
    limits: 'Personalizado', training: 'Depende do servidor', notes: '', keyUrl: '' };
}
function mergeProviders(saved) {
  const out = [];
  const byId = Object.fromEntries((saved || []).map(p => [p.id, p]));
  for (const def of window.DEFAULT_PROVIDERS) {
    const s = byId[def.id] || {};
    out.push({
      ...def,
      key: s.key || (window.__KEYS || {})[def.id] || '',
      useProxy: s.useProxy != null ? s.useProxy : def.cors === false,
      enabled: s.enabled != null ? s.enabled : !def.noKey,
      baseURL: typeof s.baseURL === 'string' && /^https?:\/\//i.test(s.baseURL) ? s.baseURL : def.baseURL,
      accountId: typeof s.accountId === 'string' ? s.accountId.slice(0, 64) : '',
      disabledModels: s.disabledModels && typeof s.disabledModels === 'object' ? Object.fromEntries(Object.keys(s.disabledModels).map(k => [k, true])) : {},
      rpd: typeof s.rpdUser === 'number' ? s.rpdUser : def.rpd,
      rpdUser: typeof s.rpdUser === 'number' ? s.rpdUser : null,
      models: s.modelsEdited && Array.isArray(s.models) ? (sanitizeCustom({ ...s, id: 'c-xxxxx', custom: true, baseURL: 'https://x' }) || { models: [] }).models : def.models.map(m => ({ ...m })),
      modelsEdited: !!s.modelsEdited,
      lastTest: s.lastTest || null
    });
    delete byId[def.id];
  }
  // provedores personalizados
  for (const s of Object.values(byId)) { const c = sanitizeCustom(s); if (c) out.push(c); }
  return out;
}

window.__KEYS = (() => { try { return JSON.parse(STORE.getItem('gw.keys') || SESSION.getItem('gw.keys') || '{}'); } catch { return {}; } })();
const state = {
  providers: mergeProviders(LS.get('gw.providers', [])),
  route: Object.assign({ mode: 'auto', order: [], manual: '', manualFallback: true, off: {} }, LS.get('gw.route', {})),
  settings: Object.assign({ system: '', temperature: null, maxTokens: null, timeout: 120, reasoning: true, proxy: '', rememberKeys: true, freeOnly: true, notify: false, autoSpeak: false, ttsEngine: 'browser', ttsVoice: '', pollVoice: 'nova', sttEngine: 'auto', imgEngine: 'pollinations', imgModel: 'zimage', imgSize: '1024x1024', includeLocation: false, wakeLock: true }, LS.get('gw.settings', {})),
  usage: LS.get('gw.usage', { date: today(), counts: {} }),
  cooldown: LS.get('gw.cooldown', {}),
  chats: LS.get('gw.chats', []),
  current: LS.get('gw.current', null),
  pendingImages: [],
  pendingFiles: [],
  busy: null
};
if (state.usage.date !== today()) state.usage = { date: today(), counts: {} };

function keyStore() { return state.settings.rememberKeys === false ? SESSION : STORE; }
function saveKeys() {
  const keys = Object.fromEntries(state.providers.filter(p => p.key).map(p => [p.id, p.key]));
  try { const ks = keyStore(); ks.setItem('gw.keys', JSON.stringify(keys)); (ks === STORE ? SESSION : STORE).removeItem('gw.keys'); } catch {}
}
function saveProviders() {
  saveKeys();
  LS.set('gw.providers', state.providers.map(p => ({
    id: p.id, useProxy: p.useProxy, enabled: p.enabled, baseURL: p.baseURL, accountId: p.accountId, rpdUser: p.rpdUser,
    models: p.models, modelsEdited: p.modelsEdited, disabledModels: p.disabledModels, lastTest: p.lastTest,
    ...(p.custom ? { custom: true, name: p.name, tier: p.tier, noKey: p.noKey, limits: p.limits || '', training: p.training || '', notes: p.notes || '', keyUrl: p.keyUrl || '' } : {})
  })));
}
const saveRoute = () => LS.set('gw.route', state.route);
const saveSettings = () => LS.set('gw.settings', state.settings);
const saveUsage = () => LS.set('gw.usage', state.usage);
const saveCooldown = () => LS.set('gw.cooldown', state.cooldown);
const saveChats = () => { LS.set('gw.chats', state.chats); LS.set('gw.current', state.current); };

/* ---------------- Rede (ponte nativa ou fetch) ---------------- */
window.__net = {
  pending: {},
  chunk(id, t) { const p = this.pending[id]; if (p && p.onChunk) p.onChunk(t); },
  done(id, status, body, headers) { const p = this.pending[id]; if (!p) return; delete this.pending[id]; let h = {}; try { h = JSON.parse(headers || '{}'); } catch {} p.resolve({ status, body, headers: h }); },
  fail(id, msg) { const p = this.pending[id]; if (!p) return; delete this.pending[id]; p.reject(new Error(msg)); }
};

function httpRequest({ method = 'GET', url, headers = {}, body = '', stream = false, timeout = 120000, onChunk }) {
  const id = uid();
  const promise = new Promise((resolve, reject) => {
    if (window.Native && window.Native.request) {
      __net.pending[id] = { resolve, reject, onChunk };
      window.Native.request(id, method, url, JSON.stringify(headers), body || '', !!stream, timeout | 0);
    } else {
      // Fallback para navegador (pré-visualização): sujeito a CORS.
      const ctrl = new AbortController();
      __net.pending[id] = { resolve, reject, onChunk, ctrl };
      const t = setTimeout(() => ctrl.abort(), timeout);
      fetch(url, { method, headers, body: method === 'GET' ? undefined : body, signal: ctrl.signal }).then(async r => {
        const h = {}; r.headers.forEach((v, k) => h[k] = v);
        if (r.status >= 400 || !stream || !r.body) { const txt = await r.text(); clearTimeout(t); __net.done(id, r.status, txt, JSON.stringify(h)); return; }
        const reader = r.body.getReader(); const dec = new TextDecoder();
        for (;;) { const { done, value } = await reader.read(); if (done) break; __net.chunk(id, dec.decode(value, { stream: true })); }
        clearTimeout(t); __net.done(id, r.status, '', JSON.stringify(h));
      }).catch(e => { clearTimeout(t); __net.fail(id, e.name === 'AbortError' ? 'Cancelado/tempo esgotado' : (e.message || 'Falha de rede')); });
    }
  });
  promise.cancel = () => {
    const p = __net.pending[id];
    if (window.Native && window.Native.cancel) window.Native.cancel(id);
    if (p && p.ctrl) p.ctrl.abort();
    __net.fail(id, 'Cancelado');
  };
  return promise;
}

/* ---------------- Provedores e rotas ---------------- */
const provById = (id) => state.providers.find(p => p.id === id);
function baseOf(p) {
  let b = (p.baseURL || '').trim().replace(/\/+$/, '');
  if (b.includes('{ACCOUNT_ID}')) b = b.replace('{ACCOUNT_ID}', (p.accountId || '').trim());
  return b;
}
function isConfigured(p) {
  if (!p.enabled) return false;
  if (!p.noKey && !p.key) return false;
  if (p.needsAccount && !p.accountId) return false;
  if (needsProxy(p) && !(state.settings.proxy || '').trim()) return false;
  return !!baseOf(p);
}
function headersFor(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.key) h['Authorization'] = 'Bearer ' + p.key.trim();
  if (p.id === 'openrouter') { h['HTTP-Referer'] = location.origin.startsWith('http') ? location.origin : 'https://gateway-ia.app'; h['X-Title'] = 'Gateway IA'; }
  if (p.id === 'anthropic') h['anthropic-dangerous-direct-browser-access'] = 'true';
  return h;
}
const tkey = (pid, mid) => pid + '|' + mid;
function needsProxy(p) { return !!p.useProxy; }
function viaProxy(p, url) {
  if (!needsProxy(p)) return url;
  const px = (state.settings.proxy || '').trim();
  if (!px) return url;
  return px.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(url);
}

function allTargets() {
  const list = [];
  for (const p of state.providers) {
    for (const m of p.models) {
      if (p.disabledModels[m.id]) continue;
      list.push({ key: tkey(p.id, m.id), p, m });
    }
  }
  return list;
}
function defaultRank(t) {
  const tierRank = { free: 0, local: 1, paid: 2 }[t.p.tier] ?? 3;
  const pIdx = state.providers.indexOf(t.p);
  const mIdx = t.p.models.indexOf(t.m);
  const price = t.m.price ? (t.m.price[0] || 0) : 0;
  return [tierRank, t.p.tier === 'paid' ? price : pIdx, pIdx, mIdx];
}
function orderedTargets() {
  const all = allTargets();
  const pos = Object.fromEntries(state.route.order.map((k, i) => [k, i]));
  const known = all.filter(t => pos[t.key] != null).sort((a, b) => pos[a.key] - pos[b.key]);
  const fresh = all.filter(t => pos[t.key] == null).sort((a, b) => {
    const ra = defaultRank(a), rb = defaultRank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  // insere novos alvos depois do último alvo do mesmo nível
  const merged = known.slice();
  for (const t of fresh) {
    let at = merged.length;
    const rank = { free: 0, local: 1, paid: 2 }[t.p.tier];
    for (let i = merged.length - 1; i >= 0; i--) { if (({ free: 0, local: 1, paid: 2 }[merged[i].p.tier]) <= rank) { at = i + 1; break; } if (i === 0) at = 0; }
    merged.splice(at, 0, t);
  }
  const newOrder = merged.map(t => t.key);
  if (newOrder.join() !== state.route.order.join()) { state.route.order = newOrder; saveRoute(); }
  return merged;
}
function targetStatus(t) {
  if (!isConfigured(t.p)) return { ok: false, why: !t.p.enabled ? 'desativado' : (!t.p.noKey && !t.p.key) ? 'sem chave' : (needsProxy(t.p) && !state.settings.proxy) ? 'precisa de proxy CORS' : 'incompleto' };
  if (state.route.off[t.key]) return { ok: false, why: 'fora da rota' };
  const cd = state.cooldown[t.key] || state.cooldown[t.p.id + '|*'];
  if (cd && cd.until > Date.now()) return { ok: false, cool: true, why: 'pausa ' + fmtLeft(cd.until - Date.now()) + (cd.reason ? ' · ' + cd.reason : '') };
  const used = state.usage.counts[t.key] || 0;
  if (t.p.rpd && used >= t.p.rpd) return { ok: false, cool: true, why: 'limite diário (' + used + '/' + t.p.rpd + ')' };
  return { ok: true, why: '' };
}
function fmtLeft(ms) { const s = Math.ceil(ms / 1000); if (s < 60) return s + 's'; const m = Math.ceil(s / 60); if (m < 60) return m + 'min'; return Math.ceil(m / 60) + 'h'; }

function candidates(needVision) {
  const mode = state.route.mode;
  let list = orderedTargets();
  if (mode === 'manual') {
    const t = list.find(x => x.key === state.route.manual);
    const rest = state.route.manualFallback ? list.filter(x => x.key !== state.route.manual) : [];
    list = t ? [t, ...rest] : rest;
  } else if (mode === 'free') list = list.filter(t => t.p.tier === 'free' || t.p.tier === 'local');
  else if (mode === 'local') list = list.filter(t => t.p.tier === 'local');
  else if (mode === 'paid') list = list.filter(t => t.p.tier === 'paid');
  if (state.settings.freeOnly) list = list.filter(t => t.p.tier !== 'paid');
  if (needVision) list = list.filter(t => t.m.v);
  return list.filter(t => targetStatus(t).ok);
}

function setCooldown(key, ms, reason) { state.cooldown[key] = { until: Date.now() + ms, reason }; saveCooldown(); }
function bumpUsage(key) { if (state.usage.date !== today()) state.usage = { date: today(), counts: {} }; state.usage.counts[key] = (state.usage.counts[key] || 0) + 1; saveUsage(); }

/* ---------------- Chamada de chat com streaming ---------------- */
function parseErr(body) {
  try { const j = JSON.parse(body); const e = Array.isArray(j) ? j[0]?.error : j.error; if (e) return (typeof e === 'string' ? e : e.message || JSON.stringify(e)).slice(0, 220); if (j.message) return String(j.message).slice(0, 220); } catch {}
  return String(body || '').slice(0, 220);
}

function callTarget(t, messages, onDelta) {
  const body = { model: t.m.id, messages, stream: true };
  const s = state.settings;
  if (s.temperature != null) body.temperature = s.temperature;
  if (s.maxTokens) body.max_tokens = s.maxTokens;
  let buf = '', sawSSE = false, content = '', reasoning = '', usage = null, streamErr = null, finish = null;
  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    sawSSE = true;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) { streamErr = parseErr(JSON.stringify(j)); return; }
    if (j.usage) usage = j.usage;
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || ch.message || {};
    const r = d.reasoning_content || d.reasoning || '';
    if (r && typeof r === 'string') { reasoning += r; onDelta(content, reasoning); }
    if (typeof d.content === 'string' && d.content) { content += d.content; onDelta(content, reasoning); }
    else if (Array.isArray(d.content)) { const tx = d.content.map(x => x.text || '').join(''); if (tx) { content += tx; onDelta(content, reasoning); } }
  };
  const req = httpRequest({
    method: 'POST', url: viaProxy(t.p, baseOf(t.p) + '/chat/completions'), headers: { ...headersFor(t.p), Accept: 'text/event-stream' },
    body: JSON.stringify(body), stream: true, timeout: (s.timeout || 120) * 1000,
    onChunk(txt) { buf += txt; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handleLine); }
  });
  const p = req.then(res => {
    if (buf) { const rest = buf; buf = ''; rest.split('\n').forEach(handleLine); if (!sawSSE && res.status < 400) buf = rest; }
    if (res.status >= 400) return { ok: false, status: res.status, error: parseErr(res.body), headers: res.headers };
    if (!sawSSE) { // provedor ignorou stream
      try { const j = JSON.parse(res.body || buf); const m = j.choices?.[0]?.message; content = m?.content || ''; reasoning = m?.reasoning_content || m?.reasoning || ''; usage = j.usage; onDelta(content, reasoning); } catch {}
    }
    if (streamErr && !content) return { ok: false, status: 0, error: streamErr };
    if (!content && !reasoning) return { ok: false, status: res.status, error: 'resposta vazia' + (finish ? ' (' + finish + ')' : '') };
    return { ok: true, content, reasoning, usage, partialError: streamErr, finish };
  }, err => ({ ok: false, status: -1, error: err.message, partial: content, partialReasoning: reasoning }));
  p.cancel = req.cancel;
  return p;
}

function penalize(t, r) {
  const st = r.status;
  if (st === 429) {
    const ra = parseFloat(r.headers?.['retry-after']);
    setCooldown(t.key, (isFinite(ra) && ra > 0 ? ra * 1000 : 60000), '429');
  } else if (st === 401 || st === 403 || (st === 400 && /api[ _-]?key|unauthori|invalid.{0,20}(key|token)|authenticat/i.test(r.error || ''))) setCooldown(t.p.id + '|*', 10 * 60000, 'chave recusada');
  else if (st === 404) setCooldown(t.key, 60 * 60000, 'modelo não encontrado');
  else if (st === 402) setCooldown(t.p.id + '|*', 60 * 60000, 'sem crédito');
  else if (st >= 500 || st === -1) setCooldown(t.key, 30000, st === -1 ? 'rede' : String(st));
}

/* ---------------- Conversas ---------------- */
function currentChat() { return state.chats.find(c => c.id === state.current) || null; }
function newChat() {
  const c = { id: uid(), title: 'Nova conversa', messages: [], updated: Date.now() };
  state.chats.unshift(c); state.current = c.id; saveChats(); renderChat(); renderChatList();
  return c;
}
function ensureChat() { return currentChat() || newChat(); }

function toApiMessages(chat) {
  const out = [];
  const sys = [state.settings.system.trim(), (state.settings.includeLocation && window.Media && Media.locationLine()) || ''].filter(Boolean).join('\n\n');
  if (sys) out.push({ role: 'system', content: sys });
  const pctx = window.Project && Project.contextFor(chat);
  if (pctx) out.push({ role: 'system', content: pctx });
  for (const m of chat.messages) {
    if (m.role === 'assistant') { if (m.content) out.push({ role: 'assistant', content: m.content }); continue; }
    const text = (m.content || '') + (m.files && m.files.length ? '\n\n' + m.files.map(f => '--- Arquivo anexado: ' + f.name + (f.truncated ? ' (truncado)' : '') + ' ---\n' + f.text).join('\n\n') : '');
    if (m.images && m.images.length) out.push({ role: 'user', content: [{ type: 'text', text: text || 'Descreva a imagem.' }, ...m.images.map(u => ({ type: 'image_url', image_url: { url: u } }))] });
    else out.push({ role: 'user', content: text });
  }
  return out;
}

async function send(textOverride) {
  if (state.busy) return;
  const input = $('#input');
  const text = (textOverride != null ? textOverride : input.value).trim();
  if (!text && !state.pendingImages.length && !state.pendingFiles.length) return;
  const chat = ensureChat();
  const cmd = text.match(/^\/(imagem|img|image)\s+([\s\S]+)/i);
  chat.messages.push({ role: 'user', content: text, images: state.pendingImages.slice(), files: state.pendingFiles.slice() });
  if (chat.title === 'Nova conversa') chat.title = (text || (state.pendingFiles[0] && state.pendingFiles[0].name) || 'Imagem').slice(0, 48);
  state.pendingImages = []; state.pendingFiles = []; renderAttach();
  input.value = ''; autoGrow();
  if (cmd && window.Media) { await Media.chatImage(chat, cmd[2].trim()); return; }
  if (window.Project && chat.project) await Project.prepare(chat, text, chat.messages[chat.messages.length - 1]);
  await runAssistant(chat);
}

async function runAssistant(chat) {
  const needVision = chat.messages.some(m => m.images && m.images.length);
  const msg = { role: 'assistant', content: '', reasoning: '', meta: { trail: [] } };
  chat.messages.push(msg); chat.updated = Date.now();
  renderChat();
  const apiMsgs = toApiMessages({ id: chat.id, project: chat.project, messages: chat.messages.slice(0, -1) });
  const cands = candidates(needVision);
  const el = $('#messages').lastElementChild;
  const ctl = { cancelled: false, current: null };
  state.busy = ctl; setBusy(true);
  if (window.Media) Media.wake(true);
  if (!cands.length) {
    msg.error = needVision ? 'Nenhum modelo com visão disponível na rota atual. Ative um provedor com visão (ex.: Groq qwen3.8, Gemini) ou mude o modo.' : 'Nenhum provedor disponível. Configure uma chave em Provedores ou verifique pausas em Rotas.';
    finishRun(chat, msg); return;
  }
  for (const t of cands) {
    if (ctl.cancelled) break;
    if (!targetStatus(t).ok) continue; // provedor pausado durante esta rodada (ex.: chave recusada)
    msg.meta.current = t.p.name + ' · ' + t.m.id;
    updateMsgEl(el, msg, true);
    const started = performance.now();
    bumpUsage(t.key);
    const call = callTarget(t, apiMsgs, (c, r) => { msg.content = c; msg.reasoning = r; updateMsgEl(el, msg, true); });
    ctl.current = call;
    const r = await call;
    if (ctl.cancelled) { if (r.partial) msg.content = r.partial; break; }
    if (r.ok) {
      msg.content = r.content; msg.reasoning = r.reasoning;
      msg.meta.via = { provider: t.p.name, tier: t.p.tier, model: t.m.id, ms: Math.round(performance.now() - started), usage: r.usage || null };
      if (r.partialError) msg.error = 'Interrompido: ' + r.partialError;
      msg.meta.trail.push({ name: t.p.name, ok: true });
      break;
    }
    if (r.partial) { // falhou no meio do streaming: mantém o texto
      msg.content = r.partial; msg.reasoning = r.partialReasoning || '';
      msg.meta.via = { provider: t.p.name, tier: t.p.tier, model: t.m.id, ms: Math.round(performance.now() - started) };
      msg.error = 'Conexão interrompida: ' + r.error;
      penalize(t, r); break;
    }
    penalize(t, r);
    msg.meta.trail.push({ name: t.p.name, model: t.m.id, status: r.status, error: r.error });
    msg.content = ''; msg.reasoning = '';
  }
  if (!msg.meta.via && !ctl.cancelled && !msg.error) msg.error = 'Todos os provedores da rota falharam. Toque nos itens em vermelho para ver o motivo.';
  if (ctl.cancelled && !msg.content) msg.error = 'Cancelado.';
  finishRun(chat, msg);
}
function finishRun(chat, msg) {
  delete msg.meta.current;
  state.busy = null; setBusy(false);
  if (window.Media) Media.wake(false);
  chat.updated = Date.now(); saveChats();
  renderChat(); renderChatList(); updateRouteChip();
  if (window.Media) Media.afterReply(chat, msg);
}
function stop() { const b = state.busy; if (!b) return; b.cancelled = true; if (b.current && b.current.cancel) b.current.cancel(); }

/* ---------------- Markdown leve ---------------- */
function md(src) {
  if (!src) return '';
  const blocks = [];
  src = src.replace(/```([^\n`]*)\n?([\s\S]*?)(```|$)/g, (_, info, code) => { const pm = /path=["']?([^\s"'`]+)/.exec(info || ''); blocks.push('<pre>' + (pm ? '<div class="code-path">' + esc(pm[1]) + '</div>' : '') + '<code>' + esc(code.replace(/\n$/, '')) + '</code></pre>'); return '\u0000' + (blocks.length - 1) + '\u0000'; });
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const lines = src.split('\n'); let html = '', list = null, para = [], table = null;
  const flushPara = () => { if (para.length) { html += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; } };
  const flushList = () => { if (list) { html += '</' + list + '>'; list = null; } };
  const flushTable = () => { if (table) { html += '<table>' + table.map((r, i) => '<tr>' + r.map(c => (i === 0 ? '<th>' : '<td>') + inline(c.trim()) + (i === 0 ? '</th>' : '</td>')).join('') + '</tr>').join('') + '</table>'; table = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const bm = line.match(/^\u0000(\d+)\u0000$/);
    if (bm) { flushPara(); flushList(); flushTable(); html += blocks[+bm[1]]; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; (table = table || []).push(line.trim().slice(1, -1).split('|')); continue; } else flushTable();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushPara(); flushList(); html += '<h3>' + inline(m[2]) + '</h3>'; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flushPara(); if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += '<li>' + inline(m[1]) + '</li>'; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += '<li>' + inline(m[1]) + '</li>'; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { flushPara(); flushList(); html += '<blockquote>' + inline(m[1]) + '</blockquote>'; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList(); flushTable();
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

/* ---------------- Render: chat ---------------- */
const LOGO_BIG = '<svg class="logo-big" viewBox="0 0 32 32" width="56" height="56" fill="none" aria-hidden="true"><path d="M4 9c5 0 6 7 11 7M4 16h11M4 23c5 0 6-7 11-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15 16h9" stroke="#3DDC97" stroke-width="2.4" stroke-linecap="round"/><circle cx="15" cy="16" r="3" fill="#3DDC97"/><path d="M23.5 12l5 4-5 4z" fill="#3DDC97"/></svg>';

function renderChat() {
  const box = $('#messages');
  const chat = currentChat();
  if (!chat || !chat.messages.length) {
    const configured = state.providers.filter(isConfigured).length;
    box.innerHTML = '<div class="empty">' + LOGO_BIG +
      '<h2>' + (configured ? 'Pronto para rotear' : 'Configure um provedor') + '</h2>' +
      '<p>' + (configured ? configured + ' provedor(es) ativo(s). Se um falhar ou bater limite, o próximo da rota assume.' : 'Adicione uma chave grátis (Groq, Gemini, OpenRouter, Hugging Face…) em Provedores. As chaves ficam só neste navegador.') + '</p>' +
      (configured ? '<div class="suggest">' + ['Explique em 3 linhas o que é o protocolo MCP.', 'Escreva uma função TypeScript que faça retry com backoff exponencial.', '/imagem um farol no cerrado ao entardecer, estilo aquarela'].map(s => '<button data-s="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div>' : '<button class="btn primary" id="goProv">Abrir Provedores</button>') +
      '</div>';
    $$('.suggest button', box).forEach(b => b.onclick = () => send(b.dataset.s));
    const g = $('#goProv', box); if (g) g.onclick = () => showView('providers');
    $('#topTitle').textContent = 'Gateway IA';
    return;
  }
  $('#topTitle').textContent = chat.title;
  box.innerHTML = '';
  chat.messages.forEach((m, i) => {
    const el = document.createElement('div');
    el.className = 'msg ' + m.role;
    el.dataset.i = i;
    box.appendChild(el);
    if (m.role === 'user') {
      el.innerHTML = (m.images || []).map(u => '<img src="' + u + '" alt="">').join('') + (m.files || []).map(f => '<span class="file-chip">' + esc(f.name) + ' · ' + Math.round(f.text.length / 1000) + 'k car.</span>').join('') + esc(m.content) + (m.ctxFiles && m.ctxFiles.length ? '<div class="ctx-used">Contexto do projeto: ' + m.ctxFiles.slice(0, 8).map(esc).join(', ') + (m.ctxFiles.length > 8 ? ' +' + (m.ctxFiles.length - 8) : '') + '</div>' : '');
    } else updateMsgEl(el, m, false, i === chat.messages.length - 1);
  });
  box.scrollTop = box.scrollHeight;
}

function updateMsgEl(el, m, streaming, isLast) {
  if (!el) return;
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let meta = '';
  const trail = (m.meta && m.meta.trail || []).filter(x => !x.ok).map((x, i) => '<span class="trail" data-t="' + i + '">' + esc(x.name) + ' ' + (x.status > 0 ? x.status : '✕') + '</span>').join('');
  if (m.meta && m.meta.via) {
    const v = m.meta.via;
    const tok = v.usage && (v.usage.total_tokens || (v.usage.prompt_tokens || 0) + (v.usage.completion_tokens || 0));
    meta = trail + '<span class="badge ' + v.tier + '">' + TIER_LABEL[v.tier] + '</span><span class="via">' + esc(v.provider) + '</span><span>' + esc(v.model) + '</span><span>· ' + (v.ms / 1000).toFixed(1).replace('.', ',') + 's' + (tok ? ' · ' + tok + ' tok' : '') + '</span>';
  } else if (m.meta && m.meta.current) meta = trail + '<span>→ ' + esc(m.meta.current) + '</span>';
  else if (trail) meta = trail;
  let html = meta ? '<div class="meta">' + meta + '</div>' : '';
  if (m.reasoning && state.settings.reasoning) html += '<details class="reasoning"' + (streaming && !m.content ? ' open' : '') + '><summary>Raciocínio · ' + m.reasoning.length + ' caracteres</summary><div>' + esc(m.reasoning) + '</div></details>';
  html += '<div class="bubble' + (streaming ? ' cursor' : '') + '">' + md(m.content) + (m.media && window.Media ? Media.mediaHtml(m.media) : '') + (m.error ? '<p class="err">' + esc(m.error) + '</p>' : '') + '</div>';
  if (!streaming && (m.content || m.error || m.media)) html += '<div class="msg-actions">' + (m.content ? '<button data-a="copy">Copiar</button><button data-a="speak">Ouvir</button><button data-a="share">Compartilhar</button>' : '') + (isLast && !m.media ? '<button data-a="retry">Tentar de novo</button>' : '') + (window.Project && m.content ? Project.editButton(m.content) : '') + '</div>';
  el.innerHTML = html;
  $$('.trail[data-t]', el).forEach(b => b.onclick = () => {
    const x = m.meta.trail.filter(y => !y.ok)[+b.dataset.t];
    openSheet('<h3>' + esc(x.name) + '</h3><p class="lead">' + esc(x.model || '') + '</p><div class="warnbox">Status ' + esc(x.status > 0 ? x.status : 'sem resposta') + ': ' + esc(x.error || '') + '</div><p class="hint">429 = limite atingido (o modelo fica em pausa e a rota pula para o próximo). 401/403 = chave inválida. 404 = ID do modelo não existe mais — use “Buscar modelos” no provedor.</p>');
  });
  $$('.msg-actions button', el).forEach(b => b.onclick = () => {
    if (b.dataset.a === 'copy') copyText(m.content);
    if (b.dataset.a === 'speak' && window.Media) Media.speak(m.content, b);
    if (b.dataset.a === 'share') { if (navigator.share) navigator.share({ text: m.content }).catch(() => {}); else copyText(m.content); }
    if (b.dataset.a === 'apply' && window.Project) Project.applyEdits(m.content);
    if (b.dataset.a === 'retry') { const c = currentChat(); if (!c || state.busy) return; c.messages.pop(); runAssistant(c); }
  });
  $$('a', el).forEach(a => a.onclick = (e) => { e.preventDefault(); openUrl(a.href); });
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function setBusy(b) {
  const btn = $('#btnSend');
  btn.classList.toggle('stop', b);
  $('#icoSend').style.display = b ? 'none' : 'block'; $('#icoStop').style.display = b ? 'block' : 'none';
  btn.setAttribute('aria-label', b ? 'Parar' : 'Enviar');
}

function renderChatList() {
  const box = $('#chatList');
  if (!state.chats.length) { box.innerHTML = '<p class="hint" style="padding:12px">Nenhuma conversa ainda.</p>'; return; }
  const q = (state.chatQuery || '').toLowerCase().trim();
  const list = q ? state.chats.filter(c => c.title.toLowerCase().includes(q) || c.messages.some(m => (m.content || '').toLowerCase().includes(q))) : state.chats;
  if (!list.length) { box.innerHTML = '<p class="hint" style="padding:12px">Nada encontrado.</p>'; return; }
  box.innerHTML = list.map(c => '<div class="chat-item' + (c.id === state.current ? ' on' : '') + '" data-id="' + c.id + '"><div class="t">' + esc(c.title) + '<small>' + new Date(c.updated).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' · ' + c.messages.length + ' msgs</small></div><button class="icon-btn del" aria-label="Apagar">✕</button></div>').join('');
  $$('.chat-item', box).forEach(it => {
    $('.t', it).onclick = () => { state.current = it.dataset.id; saveChats(); renderChat(); renderChatList(); closeDrawer(); showView('chat'); };
    $('.del', it).onclick = () => { state.chats = state.chats.filter(c => c.id !== it.dataset.id); if (state.current === it.dataset.id) state.current = state.chats[0]?.id || null; saveChats(); renderChatList(); renderChat(); };
  });
}

/* ---------------- Imagens ---------------- */
function addImage(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 1024; let { width: w, height: h } = img;
      if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      state.pendingImages.push(cv.toDataURL('image/jpeg', 0.82)); renderAttach();
    };
    img.onerror = () => toast('Não foi possível ler a imagem');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
function renderAttach() {
  const row = $('#attachRow');
  row.innerHTML = state.pendingImages.map((u, i) => '<div class="thumb"><img src="' + u + '" alt=""><button data-i="' + i + '" aria-label="Remover">✕</button></div>').join('') +
    state.pendingFiles.map((f, i) => '<div class="file-pend"><span>' + esc(f.name) + '<small>' + (f.text.length < 1000 ? f.text.length + ' caracteres' : Math.round(f.text.length / 1000) + 'k caracteres') + (f.truncated ? ' · truncado' : '') + '</small></span><button data-f="' + i + '" aria-label="Remover">✕</button></div>').join('');
  $$('button[data-i]', row).forEach(b => b.onclick = () => { state.pendingImages.splice(+b.dataset.i, 1); renderAttach(); });
  $$('button[data-f]', row).forEach(b => b.onclick = () => { state.pendingFiles.splice(+b.dataset.f, 1); renderAttach(); });
  updateRouteChip();
}

/* ---------------- Chip de rota ---------------- */
function updateRouteChip() {
  const chip = $('#routeChip');
  const needV = state.pendingImages.length > 0 || (currentChat()?.messages || []).some(m => m.images && m.images.length);
  const c = candidates(needV);
  const mode = MODES.find(m => m[0] === state.route.mode);
  chip.classList.toggle('warn', !c.length);
  $('#routeChipText').textContent = (state.settings.freeOnly ? 'Grátis · ' : '') + mode[1] + (needV ? ' · visão' : '') + ' · ' + (c.length ? c[0].p.name + ' ' + c[0].m.id + (c.length > 1 ? ' +' + (c.length - 1) : '') : 'nenhum disponível');
}
function openRouteQuick() {
  const list = orderedTargets().filter(t => isConfigured(t.p));
  openSheet('<h3>Roteamento</h3><p class="lead">Escolha o modo. Em Manual, o modelo escolhido vai primeiro.</p>' + modeSeg() +
    '<div class="section-title">Modelo manual</div><div class="pick">' + (list.length ? list.map(t => '<button data-k="' + esc(t.key) + '" class="' + (state.route.manual === t.key ? 'on' : '') + '"><span class="badge ' + t.p.tier + '">' + TIER_LABEL[t.p.tier] + '</span><span><strong>' + esc(t.p.name) + '</strong><span class="id">' + esc(t.m.id) + (t.m.v ? ' · visão' : '') + '</span></span></button>').join('') : '<p class="hint">Configure um provedor primeiro.</p>') + '</div>');
  bindModeSeg($('#sheetBody'), () => openRouteQuick());
  $$('.pick button', $('#sheetBody')).forEach(b => b.onclick = () => { state.route.manual = b.dataset.k; state.route.mode = 'manual'; saveRoute(); updateRouteChip(); renderRoute(); closeSheet(); });
}
function modeSeg() { return '<div class="seg">' + MODES.filter(m => !(state.settings.freeOnly && m[0] === 'paid')).map(m => '<button data-mode="' + m[0] + '" class="' + (state.route.mode === m[0] ? 'on' : '') + '">' + m[1] + '<small>' + m[2] + '</small></button>').join('') + '</div>'; }
function bindModeSeg(root, after) { $$('[data-mode]', root).forEach(b => b.onclick = () => { state.route.mode = b.dataset.mode; saveRoute(); updateRouteChip(); renderRoute(); after && after(); }); }

/* ---------------- Render: provedores ---------------- */
function provStatus(p) {
  if (!p.enabled) return ['', 'Desativado'];
  if (!p.noKey && !p.key) return ['', 'Sem chave'];
  if (p.needsAccount && !p.accountId) return ['', 'Falta Account ID'];
  if (needsProxy(p) && !state.settings.proxy) return ['cool', 'Precisa de proxy CORS'];
  const cd = state.cooldown[p.id + '|*'];
  if (cd && cd.until > Date.now()) return ['err', cd.reason + ' · ' + fmtLeft(cd.until - Date.now())];
  if (p.lastTest && !p.lastTest.ok) return ['err', 'Último teste falhou'];
  return ['ok', p.lastTest ? 'Testado · ' + p.lastTest.ms + 'ms' : 'Configurado'];
}
function renderProviders() {
  const box = $('#providersList');
  const groups = [['free', 'Grátis'], ['local', 'Local'], ['paid', state.settings.freeOnly ? 'Pagos — desligados por “Só IA grátis” (Rotas)' : 'Pagos']];
  box.innerHTML = groups.map(([tier, label]) => {
    const ps = state.providers.filter(p => p.tier === tier);
    if (!ps.length) return '';
    return '<div class="section-title">' + label + '</div><div class="card list">' + ps.map(p => {
      const [cls, txt] = provStatus(p);
      return '<button class="row" data-p="' + p.id + '"><span class="status ' + cls + '"></span><div class="grow"><div class="title">' + esc(p.name) + '</div><div class="sub">' + esc(txt) + ' · ' + p.models.length + ' modelos</div></div><svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></button>';
    }).join('') + '</div>';
  }).join('') +
    '<div class="section-title">Outro provedor</div><div class="card list"><button class="row" id="addCustom"><span class="status"></span><div class="grow"><div class="title">Adicionar compatível com OpenAI</div><div class="sub">Qualquer endpoint /v1/chat/completions</div></div></button></div>' +
    '<p class="hint">Catálogo de ' + window.CATALOG_DATE + '. IDs de modelos mudam rápido: use “Buscar modelos” para listar o que o provedor oferece hoje.</p>';
  $$('[data-p]', box).forEach(b => b.onclick = () => openProvider(b.dataset.p));
  $('#addCustom').onclick = addCustomProvider;
}

function openProvider(id) {
  const p = provById(id);
  const body = '<h3><span class="badge ' + p.tier + '">' + TIER_LABEL[p.tier] + '</span>' + esc(p.name) + '</h3>' +
    '<p class="lead">' + esc(p.limits || '') + '</p>' +
    '<div class="row" style="padding:4px 0 14px;border:0;min-height:0"><div class="grow"><div class="title">Ativo na rota</div></div><label class="switch"><input type="checkbox" id="pEnabled" ' + (p.enabled ? 'checked' : '') + '><span></span></label></div>' +
    (p.noKey ? '' : '<div class="field"><label>Chave de API</label><div class="input-group"><input class="input mono" id="pKey" type="password" autocomplete="off" spellcheck="false" placeholder="cole a chave" value="' + esc(p.key) + '"><button class="btn" id="pShow">Ver</button><button class="btn" id="pPaste">Colar</button></div>' + (p.keyUrl ? '<p class="hint"><a href="' + esc(p.keyUrl) + '" data-ext>Obter chave em ' + esc(p.keyUrl.replace(/^https?:\/\//, '').split('/')[0]) + '</a></p>' : '') + '</div>') +
    (p.needsAccount ? '<div class="field"><label>Account ID</label><input class="input mono" id="pAcc" value="' + esc(p.accountId) + '" placeholder="ex.: 0123abcd…"></div>' : '') +
    '<div class="row" style="padding:0 0 14px;border:0;min-height:0"><div class="grow"><div class="title" style="font-size:14px">Usar proxy CORS</div><div class="sub" style="white-space:normal">' + (p.cors === false ? 'Este provedor bloqueia chamadas do navegador' : 'Normalmente não precisa') + (state.settings.proxy ? '' : ' · configure em Rotas') + '</div></div><label class="switch"><input type="checkbox" id="pProxy" ' + (p.useProxy ? 'checked' : '') + '><span></span></label></div>' +
    '<div class="field"><label>Base URL</label><input class="input mono" id="pBase" value="' + esc(p.baseURL) + '" spellcheck="false"></div>' +
    '<div class="field"><label>Limite diário local por modelo (RPD) — vazio = sem controle</label><input class="input" id="pRpd" type="number" inputmode="numeric" value="' + (p.rpd ?? '') + '"></div>' +
    '<div class="btn-row" style="margin-bottom:16px"><button class="btn primary" id="pSave">Salvar</button><button class="btn" id="pTest">Testar</button><button class="btn" id="pFetch">Buscar modelos</button></div>' +
    '<div id="pResult"></div>' +
    '<div class="section-title">Modelos</div><div class="card" style="padding:0 12px" id="pModels"></div>' +
    '<div class="field" style="margin-top:10px"><div class="input-group"><input class="input mono" id="pNewModel" placeholder="adicionar ID do modelo" spellcheck="false"><button class="btn" id="pAdd">Adicionar</button></div></div>' +
    '<div class="section-title">Privacidade e termos</div><div class="card" style="padding:12px 14px;font-size:13.5px"><strong>Treino:</strong> ' + esc(p.training || 'não informado') + (p.notes ? '<br><span style="color:var(--muted)">' + esc(p.notes) + '</span>' : '') + '</div>' +
    (p.custom ? '<div class="btn-row" style="margin-top:14px"><button class="btn danger" id="pDel">Remover provedor</button></div>' : (p.modelsEdited ? '<div class="btn-row" style="margin-top:14px"><button class="btn ghost" id="pReset">Restaurar modelos do catálogo</button></div>' : ''));
  openSheet(body);
  const root = $('#sheetBody');
  renderModelRows(p);
  const collect = () => {
    p.enabled = $('#pEnabled', root).checked;
    if (!p.noKey) p.key = $('#pKey', root).value.trim();
    if (p.needsAccount) p.accountId = $('#pAcc', root).value.trim();
    p.baseURL = $('#pBase', root).value.trim();
    p.useProxy = $('#pProxy', root).checked;
    const r = $('#pRpd', root).value.trim();
    p.rpdUser = r === '' ? null : Math.max(1, parseInt(r, 10) || 1); p.rpd = p.rpdUser;
  };
  $('#pEnabled', root).onchange = () => { collect(); saveProviders(); refreshAll(); };
  if (!p.noKey) {
    $('#pShow', root).onclick = (e) => { const k = $('#pKey', root); k.type = k.type === 'password' ? 'text' : 'password'; e.target.textContent = k.type === 'password' ? 'Ver' : 'Ocultar'; };
    $('#pPaste', root).onclick = () => { readClip().then(t => { if (t) $('#pKey', root).value = t.trim(); else toast('Permita acesso à área de transferência ou cole manualmente'); }); };
  }
  $('#pSave', root).onclick = () => { collect(); delete state.cooldown[p.id + '|*']; saveCooldown(); saveProviders(); refreshAll(); toast('Salvo'); closeSheet(); };
  $('#pTest', root).onclick = () => { collect(); saveProviders(); testProvider(p); };
  $('#pFetch', root).onclick = () => { collect(); saveProviders(); fetchModels(p); };
  $('#pAdd', root).onclick = () => { const v = $('#pNewModel', root).value.trim(); if (!v) return; addModel(p, v); $('#pNewModel', root).value = ''; };
  const del = $('#pDel', root); if (del) del.onclick = () => { state.providers = state.providers.filter(x => x !== p); saveProviders(); refreshAll(); closeSheet(); };
  const rs = $('#pReset', root); if (rs) rs.onclick = () => { const def = window.DEFAULT_PROVIDERS.find(d => d.id === p.id); p.models = def.models.map(m => ({ ...m })); p.modelsEdited = false; saveProviders(); refreshAll(); openProvider(p.id); };
  $$('a[data-ext]', root).forEach(a => a.onclick = e => { e.preventDefault(); openUrl(a.href); });
}
function renderModelRows(p) {
  const box = $('#pModels'); if (!box) return;
  box.innerHTML = p.models.length ? p.models.map((m, i) => '<div class="model-row"><label class="switch"><input type="checkbox" data-i="' + i + '" ' + (p.disabledModels[m.id] ? '' : 'checked') + '><span></span></label><div class="id">' + esc(m.id) + (m.v ? '<span class="cap">visão</span>' : '') + (m.t ? '<span class="cap">tools</span>' : '') + (m.a ? '<span class="cap">áudio</span>' : '') + (m.price ? '<span class="cap">$' + m.price[0] + '/' + (m.price[1] ?? '?') + '</span>' : '') + '</div><button class="x" data-del="' + i + '" aria-label="Remover">✕</button></div>').join('') : '<p class="hint" style="padding:10px 0">Nenhum modelo. Adicione um ID ou use “Buscar modelos”.</p>';
  $$('input[data-i]', box).forEach(c => c.onchange = () => { const m = p.models[+c.dataset.i]; if (c.checked) delete p.disabledModels[m.id]; else p.disabledModels[m.id] = true; saveProviders(); refreshAll(true); });
  $$('[data-del]', box).forEach(b => b.onclick = () => { p.models.splice(+b.dataset.del, 1); p.modelsEdited = true; saveProviders(); renderModelRows(p); refreshAll(true); });
}
function addModel(p, id, extra) {
  if (p.models.some(m => m.id === id)) { toast('Já está na lista'); return false; }
  const vis = /vision|vl|gemini|gemma-?[34]|gemma4|qwen3\.[5-9]|gpt-[456]|claude|llama-4|pixtral|grok-4|mistral-(small|medium|large)|kimi/i.test(id);
  p.models.push(Object.assign({ id, v: vis ? 1 : 0, t: 1 }, extra || {})); p.modelsEdited = true; saveProviders(); renderModelRows(p); refreshAll(true);
  return true;
}
async function testProvider(p) {
  const out = $('#pResult');
  const m = p.models.find(x => !p.disabledModels[x.id]);
  if (!m) { out.innerHTML = '<div class="warnbox">Adicione um modelo antes de testar.</div>'; return; }
  out.innerHTML = '<p class="hint">Testando ' + esc(m.id) + '…</p>';
  const t0 = performance.now();
  try {
    const r = await httpRequest({ method: 'POST', url: viaProxy(p, baseOf(p) + '/chat/completions'), headers: headersFor(p), body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'Responda apenas: ok' }], max_tokens: 16 }), timeout: 30000 });
    const ms = Math.round(performance.now() - t0);
    if (r.status < 400) {
      let txt = ''; try { const j = JSON.parse(r.body); txt = j.choices?.[0]?.message?.content || ''; } catch {}
      p.lastTest = { ok: true, ms }; out.innerHTML = '<div class="card" style="padding:10px 12px;font-size:13.5px"><span class="status ok" style="display:inline-block;margin-right:6px"></span>OK em ' + ms + ' ms' + (txt ? ' · “' + esc(txt.slice(0, 60)) + '”' : '') + '</div>';
    } else { p.lastTest = { ok: false, ms }; out.innerHTML = '<div class="warnbox">HTTP ' + r.status + ': ' + esc(parseErr(r.body)) + '</div>'; }
  } catch (e) { p.lastTest = { ok: false, ms: 0 }; out.innerHTML = '<div class="warnbox">Falha: ' + esc(e.message) + '</div>'; }
  saveProviders(); renderProviders();
}
async function fetchModels(p) {
  const out = $('#pResult');
  out.innerHTML = '<p class="hint">Buscando /models…</p>';
  try {
    const h = headersFor(p); delete h['Content-Type'];
    const r = await httpRequest({ url: viaProxy(p, baseOf(p) + '/models'), headers: h, timeout: 30000 });
    if (r.status >= 400) { out.innerHTML = '<div class="warnbox">HTTP ' + r.status + ': ' + esc(parseErr(r.body)) + '</div>'; return; }
    const j = JSON.parse(r.body);
    let items = (j.data || j.models || j.result || []).map(x => typeof x === 'string' ? { id: x } : x).filter(x => x && (x.id || x.name));
    items = items.map(x => ({ id: String(x.id || x.name).replace(/^models\//, ''), free: x.pricing ? (+x.pricing.prompt === 0 && +x.pricing.completion === 0) : null, vis: x.architecture?.input_modalities?.includes('image') }));
    if (p.id === 'openrouter') items.sort((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0));
    const filterFree = p.id === 'openrouter';
    const render = (q) => {
      const list = items.filter(x => (!q || x.id.toLowerCase().includes(q)) && (!filterFree || !$('#onlyFree')?.checked || x.free));
      $('#remote').innerHTML = list.slice(0, 300).map(x => '<button data-id="' + esc(x.id) + '" data-v="' + (x.vis ? 1 : 0) + '" class="' + (p.models.some(m => m.id === x.id) ? 'added' : '') + '">' + esc(x.id) + (x.free ? ' · grátis' : '') + (x.vis ? ' · visão' : '') + '</button>').join('') || '<p class="hint" style="padding:10px">Nada encontrado.</p>';
      $$('#remote button').forEach(b => b.onclick = () => { if (addModel(p, b.dataset.id, b.dataset.v === '1' ? { v: 1 } : null)) b.classList.add('added'); });
    };
    out.innerHTML = '<div class="card" style="padding:10px 12px"><div style="font-size:13.5px;margin-bottom:8px">' + items.length + ' modelos. Toque para adicionar à rota.</div><input class="input" id="remoteQ" placeholder="filtrar">' + (filterFree ? '<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:8px"><input type="checkbox" id="onlyFree" checked> só grátis (:free)</label>' : '') + '<div class="remote-list" id="remote"></div></div>';
    render('');
    $('#remoteQ').oninput = (e) => render(e.target.value.toLowerCase());
    const of = $('#onlyFree'); if (of) of.onchange = () => render($('#remoteQ').value.toLowerCase());
  } catch (e) { out.innerHTML = '<div class="warnbox">Falha: ' + esc(e.message) + '</div>'; }
}
function addCustomProvider() {
  openSheet('<h3>Novo provedor</h3><p class="lead">Qualquer API compatível com OpenAI (LM Studio, vLLM, LiteLLM, OmniRoute, Together…).</p>' +
    '<div class="field"><label>Nome</label><input class="input" id="cName" placeholder="Meu servidor"></div>' +
    '<div class="field"><label>Base URL (termina em /v1)</label><input class="input mono" id="cBase" placeholder="https://…/v1"></div>' +
    '<div class="field"><label>Tipo</label><select class="input" id="cTier"><option value="free">Grátis</option><option value="local">Local</option><option value="paid">Pago</option></select></div>' +
    '<div class="field"><label>Chave (opcional)</label><input class="input mono" id="cKey" type="password"></div>' +
    '<div class="field"><label>Modelo inicial</label><input class="input mono" id="cModel" placeholder="id do modelo"></div>' +
    '<button class="btn primary" id="cSave" style="width:100%">Adicionar</button>');
  $('#cSave').onclick = () => {
    const name = $('#cName').value.trim(), base = $('#cBase').value.trim();
    if (!name || !base) { toast('Informe nome e Base URL'); return; }
    const key = $('#cKey').value.trim(), model = $('#cModel').value.trim();
    const p = { id: 'c-' + uid(), custom: true, name, tier: $('#cTier').value, baseURL: base, key, noKey: !key, enabled: true, accountId: '', rpd: null, rpdUser: null, models: model ? [{ id: model, t: 1 }] : [], modelsEdited: true, disabledModels: {}, lastTest: null, limits: 'Personalizado', training: 'Depende do servidor', notes: '' };
    state.providers.push(p); saveProviders(); refreshAll(); openProvider(p.id);
  };
}

/* ---------------- Render: rotas ---------------- */
function renderRoute() {
  const box = $('#routePanel');
  const list = orderedTargets();
  const s = state.settings;
  const mode = state.route.mode;
  const visible = list.filter(t => isConfigured(t.p));
  const hidden = list.length - visible.length;
  box.innerHTML = '<div class="card" style="margin-bottom:6px"><div class="row"><div class="grow"><div class="title">Só IA grátis</div><div class="sub" style="white-space:normal">Provedores pagos nunca são chamados (chat, imagem, voz e vídeo)</div></div><label class="switch"><input type="checkbox" id="sFree" ' + (s.freeOnly ? 'checked' : '') + '><span></span></label></div></div>' +
    '<div class="section-title">Modo</div>' + modeSeg() +
    (mode === 'manual' ? '<div class="card" style="margin-top:8px"><div class="row"><div class="grow"><div class="title">Fallback no modo manual</div><div class="sub">Se o modelo escolhido falhar, segue a rota</div></div><label class="switch"><input type="checkbox" id="mFb" ' + (state.route.manualFallback ? 'checked' : '') + '><span></span></label></div></div>' : '') +
    '<div class="section-title">Ordem de tentativa <span style="flex:1"></span><button class="btn small ghost" id="rReset">Ordem padrão</button></div>' +
    (visible.length ? '<div class="card list">' + visible.map((t, i) => {
      const st = targetStatus(t);
      const used = state.usage.counts[t.key] || 0;
      const inMode = mode === 'auto' || mode === 'manual' || (mode === 'free' && t.p.tier !== 'paid') || (mode === 'local' && t.p.tier === 'local') || (mode === 'paid' && t.p.tier === 'paid');
      return '<div class="row" style="padding:8px 8px 8px 12px;' + (inMode ? '' : 'opacity:.45') + '"><span class="num">' + (i + 1) + '</span><span class="status ' + (st.ok ? 'ok' : st.cool ? 'cool' : '') + '"></span><div class="grow"><div class="title" style="font-size:14px">' + esc(t.p.name) + (t.m.v ? '<span class="cap">visão</span>' : '') + '</div><div class="sub" style="font-family:var(--mono)">' + esc(t.m.id) + '</div><div class="sub">' + (st.ok ? 'hoje: ' + used + (t.p.rpd ? '/' + t.p.rpd : '') : esc(st.why)) + '</div></div>' +
        '<label class="switch" style="transform:scale(.85)"><input type="checkbox" data-off="' + esc(t.key) + '" ' + (state.route.off[t.key] ? '' : 'checked') + '><span></span></label>' +
        '<div class="order-btns"><button data-up="' + esc(t.key) + '" ' + (i === 0 ? 'disabled' : '') + ' aria-label="Subir">▲</button><button data-down="' + esc(t.key) + '" ' + (i === visible.length - 1 ? 'disabled' : '') + ' aria-label="Descer">▼</button></div></div>';
    }).join('') + '</div>' : '<div class="card" style="padding:14px;font-size:13.5px;color:var(--muted)">Nenhum provedor configurado ainda. Adicione uma chave em Provedores.</div>') +
    (hidden ? '<p class="hint">' + hidden + ' modelos ocultos (provedor sem chave ou desativado).</p>' : '') +
    '<div class="btn-row" style="margin-top:10px"><button class="btn" id="rClearCd">Limpar pausas</button><button class="btn" id="rClearUse">Zerar contagem do dia</button></div>' +
    '<p class="hint">Falha com 429, 5xx, rede, 401/403 ou 404 → pula para o próximo e pausa o alvo (429: Retry-After ou 60s; chave recusada: 10 min; modelo inexistente: 1 h). Com imagem anexada, só entram modelos com visão.</p>' +

    '<div class="section-title">Geração</div><div class="card" style="padding:14px">' +
    '<div class="field"><label>Prompt de sistema</label><textarea class="textarea" id="sSys" placeholder="Ex.: Responda em português do Brasil, de forma direta.">' + esc(s.system) + '</textarea></div>' +
    '<div class="field"><label>Temperatura: <span id="sTempV">' + (s.temperature == null ? 'padrão do modelo' : s.temperature) + '</span></label><input type="range" id="sTemp" min="0" max="2" step="0.1" value="' + (s.temperature ?? 1) + '"><div class="btn-row" style="margin-top:6px"><button class="btn small ghost" id="sTempReset" style="flex:0">Usar padrão</button></div></div>' +
    '<div class="field"><label>Máx. tokens de saída (vazio = padrão)</label><input class="input" id="sMax" type="number" inputmode="numeric" value="' + (s.maxTokens || '') + '"></div>' +
    '<div class="field"><label>Tempo limite por tentativa (s)</label><input class="input" id="sTo" type="number" inputmode="numeric" value="' + s.timeout + '"></div>' +
    '<div class="row" style="padding:0;border:0;min-height:0"><div class="grow"><div class="title" style="font-size:14px">Mostrar raciocínio</div><div class="sub">gpt-oss, DeepSeek e outros enviam o “pensamento”</div></div><label class="switch"><input type="checkbox" id="sReas" ' + (s.reasoning ? 'checked' : '') + '><span></span></label></div>' +
    '</div>' +
    '<p class="hint">Temperatura “padrão” não envia o parâmetro — modelos de raciocínio (GPT-6, o-series) recusam valores fora do padrão.</p>' +

    '<div class="section-title">Proxy CORS</div><div class="card" style="padding:14px">' +
    '<div class="field"><label>URL do seu proxy com o segredo (ex.: https://gw-proxy.seunome.workers.dev/SEGREDO)</label><input class="input mono" id="sProxy" spellcheck="false" placeholder="vazio = sem proxy" value="' + esc(s.proxy || '') + '"></div>' +
    '<div class="btn-row"><button class="btn" id="sWorker">Copiar código do Worker</button></div>' +
    '<p class="hint" style="margin-top:10px">SambaNova, NVIDIA, Cloudflare e Ollama Cloud bloqueiam chamadas do navegador. Crie um Worker grátis na Cloudflare com o código acima e cole a URL aqui. Troque o SECRET no código: sem ele no caminho, o Worker recusa a chamada, evitando que outros gastem sua cota. O proxy só repassa para os hosts da lista e não guarda nada.</p></div>' +
    '<div class="section-title">Chaves</div><div class="card"><div class="row"><div class="grow"><div class="title" style="font-size:14px">Lembrar chaves neste navegador</div><div class="sub">Desligado: as chaves somem ao fechar a aba</div></div><label class="switch"><input type="checkbox" id="sRemember" ' + (s.rememberKeys !== false ? 'checked' : '') + '><span></span></label></div></div>' +
    '<div class="section-title">Backup</div><div class="btn-row"><button class="btn" id="bExp">Exportar (sem chaves)</button><button class="btn" id="bExpK">Exportar com chaves</button><button class="btn" id="bImp">Importar</button></div>' +
    '<p class="hint">A exportação vai para a área de transferência em JSON. As chaves ficam só neste navegador (localStorage) e são enviadas apenas para o provedor correspondente — evite usar em computador compartilhado (desligue “Lembrar chaves”) e só cadastre endpoints personalizados em que você confia, pois eles recebem a chave informada.</p>' +
    '<div class="section-title">JSON da rota</div><div class="btn-row"><button class="btn" id="bJson">Copiar no formato do gateway</button></div>' +
    '<p class="hint">Gera [{"id","tier","baseURL","models","vision"}] — o mesmo formato da pesquisa, para usar no seu gateway em servidor.</p>';

  bindModeSeg(box);
  $('#sFree', box).onchange = (e) => { s.freeOnly = e.target.checked; if (s.freeOnly && state.route.mode === 'paid') state.route.mode = 'auto'; saveSettings(); saveRoute(); renderRoute(); updateRouteChip(); renderProviders(); };
  const fb = $('#mFb', box); if (fb) fb.onchange = () => { state.route.manualFallback = fb.checked; saveRoute(); updateRouteChip(); };
  $$('[data-off]', box).forEach(c => c.onchange = () => { if (c.checked) delete state.route.off[c.dataset.off]; else state.route.off[c.dataset.off] = true; saveRoute(); renderRoute(); updateRouteChip(); });
  const move = (key, dir) => {
    const order = state.route.order; const vis = visible.map(t => t.key);
    const vi = vis.indexOf(key); const other = vis[vi + dir]; if (!other) return;
    const a = order.indexOf(key), b = order.indexOf(other); [order[a], order[b]] = [order[b], order[a]];
    saveRoute(); renderRoute(); updateRouteChip();
  };
  $$('[data-up]', box).forEach(b => b.onclick = () => move(b.dataset.up, -1));
  $$('[data-down]', box).forEach(b => b.onclick = () => move(b.dataset.down, 1));
  $('#rReset', box).onclick = () => { state.route.order = []; saveRoute(); renderRoute(); updateRouteChip(); toast('Ordem padrão: grátis → local → pagos (mais barato primeiro)'); };
  $('#rClearCd', box).onclick = () => { state.cooldown = {}; saveCooldown(); renderRoute(); renderProviders(); updateRouteChip(); toast('Pausas removidas'); };
  $('#rClearUse', box).onclick = () => { state.usage = { date: today(), counts: {} }; saveUsage(); renderRoute(); updateRouteChip(); };
  $('#sSys', box).onchange = (e) => { s.system = e.target.value; saveSettings(); };
  $('#sTemp', box).oninput = (e) => { s.temperature = parseFloat(e.target.value); $('#sTempV').textContent = s.temperature; saveSettings(); };
  $('#sTempReset', box).onclick = () => { s.temperature = null; $('#sTempV').textContent = 'padrão do modelo'; saveSettings(); };
  $('#sMax', box).onchange = (e) => { s.maxTokens = parseInt(e.target.value, 10) || null; saveSettings(); };
  $('#sTo', box).onchange = (e) => { s.timeout = Math.max(10, parseInt(e.target.value, 10) || 120); saveSettings(); };
  $('#sReas', box).onchange = (e) => { s.reasoning = e.target.checked; saveSettings(); };
  $('#sProxy', box).onchange = (e) => { s.proxy = e.target.value.trim(); saveSettings(); refreshAll(); renderRoute(); };
  $('#sWorker', box).onclick = () => copyText(WORKER_CODE);
  $('#sRemember', box).onchange = (e) => { s.rememberKeys = e.target.checked; saveSettings(); saveKeys(); toast(e.target.checked ? 'Chaves salvas neste navegador' : 'Chaves só nesta sessão'); };
  $('#bExp', box).onclick = () => exportCfg(false);
  $('#bExpK', box).onclick = () => exportCfg(true);
  $('#bImp', box).onclick = importCfg;
  $('#bJson', box).onclick = () => {
    const arr = state.providers.filter(p => p.enabled).map(p => ({ id: p.id, tier: p.tier, baseURL: baseOf(p) || p.baseURL, models: p.models.filter(m => !p.disabledModels[m.id]).map(m => m.id), vision: p.models.some(m => m.v && !p.disabledModels[m.id]) }));
    copyText(JSON.stringify(arr, null, 2));
  };
}
function exportCfg(withKeys) {
  const cfg = { app: 'gateway-ia', version: 1, exported: new Date().toISOString(), route: state.route, settings: state.settings,
    providers: state.providers.map(p => ({ id: p.id, custom: p.custom, name: p.name, tier: p.tier, enabled: p.enabled, baseURL: p.baseURL, accountId: p.accountId, rpdUser: p.rpdUser, models: p.models, modelsEdited: p.modelsEdited, disabledModels: p.disabledModels, noKey: p.noKey, ...(withKeys ? { key: p.key } : {}) })) };
  copyText(JSON.stringify(cfg, null, 2));
  if (withKeys) toast('Copiado COM chaves — guarde em local seguro');
}
function importCfg() {
  openSheet('<h3>Importar configuração</h3><p class="lead">Cole o JSON exportado. Chaves ausentes no arquivo são mantidas.</p><textarea class="textarea mono" id="impTxt" style="min-height:200px;font-family:var(--mono);font-size:12px"></textarea><div class="btn-row" style="margin-top:10px"><button class="btn" id="impPaste">Colar</button><button class="btn primary" id="impGo">Importar</button></div>');
  $('#impPaste').onclick = () => readClip().then(t => { if (t) $('#impTxt').value = t; });
  $('#impGo').onclick = () => {
    try {
      const cfg = JSON.parse($('#impTxt').value);
      if (!cfg.providers) throw new Error('JSON sem "providers"');
      const keys = Object.fromEntries(state.providers.map(p => [p.id, p.key]));
      state.providers = mergeProviders(cfg.providers.map(p => ({ ...p, key: p.key || keys[p.id] || '' })));
      const r = cfg.route || {}, st = cfg.settings || {};
      if (MODES.some(m => m[0] === r.mode)) state.route.mode = r.mode;
      if (Array.isArray(r.order)) state.route.order = r.order.filter(x => typeof x === 'string');
      if (typeof r.manual === 'string') state.route.manual = r.manual;
      if (typeof r.manualFallback === 'boolean') state.route.manualFallback = r.manualFallback;
      if (r.off && typeof r.off === 'object') state.route.off = Object.fromEntries(Object.keys(r.off).map(k => [k, true]));
      if (typeof st.system === 'string') state.settings.system = st.system.slice(0, 8000);
      if (typeof st.temperature === 'number' || st.temperature === null) state.settings.temperature = st.temperature;
      if (typeof st.maxTokens === 'number' || st.maxTokens === null) state.settings.maxTokens = st.maxTokens;
      if (typeof st.timeout === 'number') state.settings.timeout = Math.max(10, st.timeout);
      if (typeof st.reasoning === 'boolean') state.settings.reasoning = st.reasoning;
      if (typeof st.proxy === 'string' && (!st.proxy || /^https:\/\//i.test(st.proxy))) state.settings.proxy = st.proxy;
      saveProviders(); saveRoute(); saveSettings(); refreshAll(); closeSheet(); toast('Configuração importada');
    } catch (e) { toast('JSON inválido: ' + e.message); }
  };
}

/* ---------------- Render: guia ---------------- */
function renderGuide() {
  const G = window.GUIDE;
  const free = state.providers.filter(p => p.tier === 'free' && !p.custom);
  const paid = state.providers.filter(p => p.tier === 'paid' && !p.custom);
  const link = (u, t) => '<a href="' + esc(u) + '" data-ext>' + esc(t) + '</a>';
  $('#guidePanel').innerHTML =
    '<div class="section-title">Mudanças recentes · ' + window.CATALOG_DATE + '</div><div class="card">' + G.alerts.map(a => '<a class="alert" href="' + esc(a[2]) + '" data-ext><strong>' + esc(a[0]) + '</strong><span>' + esc(a[1]) + '</span></a>').join('') + '</div>' +
    '<div class="section-title">Grátis — limites e treino</div><div class="card"><table class="gtable">' + free.map(p => '<tr><td>' + esc(p.name) + '<span class="muted">' + esc(p.training) + '</span></td><td>' + esc(p.limits) + '</td></tr>').join('') + '</table></div>' +
    (G.media ? '<div class="section-title">Mídia grátis — imagem, vídeo e voz</div><div class="card"><table class="gtable">' + G.media.map(r => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>').join('') + '</table></div>' : '') +
    '<div class="section-title">Pagos — US$ por 1M tokens (entrada/saída)</div><div class="card"><table class="gtable">' + paid.map(p => '<tr><td>' + esc(p.name) + '<span class="muted">' + esc(p.notes) + '</span></td><td>' + esc(p.limits) + '</td></tr>').join('') + '</table></div>' +
    '<div class="section-title">Ollama — modelos locais</div><div class="card"><table class="gtable">' + G.local.map(r => '<tr><td style="font-family:var(--mono);font-size:12.5px">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '<span class="muted">' + esc(r[2]) + '</span></td></tr>').join('') + '</table></div>' +
    '<p class="hint">RAM/VRAM são estimativas (exceto gpt-oss:20b, oficial). No navegador: OLLAMA_ORIGINS="*" ollama serve e use http://localhost:11434/v1 no mesmo PC.</p>' +
    '<div class="section-title">MCP</div><div class="card"><table class="gtable">' + G.mcp.map(r => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>').join('') + '</table></div>' +
    '<div class="section-title">Navegador e CORS</div><div class="card"><table class="gtable">' + G.cors.map(r => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>').join('') + '</table></div>' +
    '<div class="section-title">Pode estar desatualizado</div><div class="card" style="padding:10px 14px"><ul style="margin:0;padding-left:18px;font-size:13.5px">' + G.stale.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></div>' +
    '<div class="section-title">Fontes oficiais</div><div class="card"><table class="gtable">' + G.sources.map(s => '<tr><td colspan="2" style="width:auto;font-weight:450">' + link(s[1], s[0]) + '</td></tr>').join('') + '</table></div>' +
    '<p class="hint">Gateway IA Web 1.0.0 · catálogo de ' + window.CATALOG_DATE + '. O app chama as APIs direto do seu navegador; nenhum servidor intermediário (exceto o seu proxy, se configurado).</p>';
  $$('#guidePanel a[data-ext]').forEach(a => a.onclick = e => { e.preventDefault(); openUrl(a.getAttribute('href')); });
}

/* ---------------- UI geral ---------------- */
function showView(v) {
  $$('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  state.view = v;
  const titles = { providers: 'Provedores', route: 'Rotas', guide: 'Mais', create: 'Criar' };
  if (v === 'chat') renderChat(); else $('#topTitle').textContent = titles[v];
  if (v === 'route') renderRoute();
  if (v === 'create' && window.Media) Media.renderCreate();
  if (v === 'guide' && window.Media) Media.renderPermissions();
  if (v === 'providers') renderProviders();
  $('#btnNewChat').style.visibility = v === 'chat' ? 'visible' : 'hidden';
}
function openSheet(html) { $('#sheetBody').innerHTML = html; $('#sheet').classList.add('on'); $('#scrim').classList.add('on'); $('#sheetBody').scrollTop = 0; }
function closeSheet() { $('#sheet').classList.remove('on'); if (!$('#drawer').classList.contains('on')) $('#scrim').classList.remove('on'); }
function openDrawer() { renderChatList(); $('#drawer').classList.add('on'); $('#scrim').classList.add('on'); }
function closeDrawer() { $('#drawer').classList.remove('on'); if (!$('#sheet').classList.contains('on')) $('#scrim').classList.remove('on'); }
let toastT;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2200); }
function readClip() { return navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText().catch(() => '') : Promise.resolve(''); }
function copyText(t) { if (window.Native) { Native.copy(t); toast('Copiado'); } else if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Copiado'), () => fallbackCopy(t)); else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('Copiado'); } catch { toast('Não foi possível copiar'); } ta.remove(); }
function openUrl(u) { if (window.Native) Native.open(u); else window.open(u, '_blank', 'noopener'); }
function refreshAll(keepSheet) { renderProviders(); if (state.view === 'route') renderRoute(); updateRouteChip(); if (state.view === 'chat' && !state.busy) renderChat(); }
function autoGrow() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }

window.handleBack = function () {
  if ($('#sheet').classList.contains('on')) { closeSheet(); return true; }
  if ($('#drawer').classList.contains('on')) { closeDrawer(); return true; }
  if (state.view && state.view !== 'chat') { showView('chat'); return true; }
  return false;
};

function init() {
  $$('.tab').forEach(t => t.onclick = () => showView(t.dataset.view));
  $('#btnDrawer').onclick = openDrawer;
  $('#scrim').onclick = () => { closeSheet(); closeDrawer(); };
  $('#btnNewChat').onclick = () => { if (!state.busy) newChat(); };
  $('#btnNewChat2').onclick = () => { if (!state.busy) { newChat(); closeDrawer(); showView('chat'); } };
  $('#btnSend').onclick = () => state.busy ? stop() : send();
  $('#routeChip').onclick = openRouteQuick;
  const input = $('#input');
  input.addEventListener('input', autoGrow);
  $('#fileInput').onchange = (e) => { if (window.Media) Media.handleFiles([...e.target.files]); e.target.value = ''; };
  // fecha o sheet arrastando a alça
  let y0 = null; const sh = $('#sheet');
  $('.sheet-grip').addEventListener('touchstart', e => y0 = e.touches[0].clientY, { passive: true });
  $('.sheet-grip').addEventListener('touchend', e => { if (y0 != null && e.changedTouches[0].clientY - y0 > 40) closeSheet(); y0 = null; });
  sh.addEventListener('click', e => e.stopPropagation());
  renderGuide(); renderProviders(); renderChatList();
  showView('chat'); updateRouteChip();
  setInterval(() => { if (!state.busy) updateRouteChip(); }, 15000);
  if (!PERSIST) setTimeout(() => toast('Modo pré-visualização: nada será salvo. Abra em nova aba para salvar.'), 600);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') window.handleBack(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#btnSend').click(); } });
  let deferred = null; const ib = $('#btnInstall');
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; ib.hidden = false; });
  ib.onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; ib.hidden = true; };
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
setBusy(false);
