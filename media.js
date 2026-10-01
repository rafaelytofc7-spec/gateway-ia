'use strict';
/* Gateway IA — arquivos, câmera, voz, notificações, permissões, imagem e vídeo (somente IA grátis). */
(function () {
  const POLL = 'https://gen.pollinations.ai';
  const S = () => state.settings;
  const prov = (id) => provById(id) || {};
  const pollKey = () => (prov('pollinations').key || '').trim();
  const groqReady = () => { const g = prov('groq'); return !!(g.enabled && g.key); };
  const cfReady = () => { const c = prov('cloudflare'); return !!(c.enabled && c.key && c.accountId && S().proxy); };
  const MAX_FILE_CHARS = 60000;

  /* ---------- IndexedDB (galeria e mídia do chat) com fallback em memória ---------- */
  const memDB = new Map();
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const r = indexedDB.open('gateway-ia', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('media', { keyPath: 'id' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch { res(null); }
    });
    return dbp;
  }
  async function put(rec) {
    memDB.set(rec.id, rec);
    const d = await db(); if (!d) return;
    try { await new Promise((ok, ko) => { const tx = d.transaction('media', 'readwrite'); tx.objectStore('media').put(rec); tx.oncomplete = ok; tx.onerror = ko; }); } catch {}
  }
  async function get(id) {
    if (memDB.has(id)) return memDB.get(id);
    const d = await db(); if (!d) return null;
    return new Promise((ok) => { try { const q = d.transaction('media').objectStore('media').get(id); q.onsuccess = () => { if (q.result) memDB.set(id, q.result); ok(q.result || null); }; q.onerror = () => ok(null); } catch { ok(null); } });
  }
  async function all() {
    const d = await db();
    if (!d) return [...memDB.values()].sort((a, b) => b.ts - a.ts);
    return new Promise((ok) => { try { const q = d.transaction('media').objectStore('media').getAll(); q.onsuccess = () => ok((q.result || []).sort((a, b) => b.ts - a.ts)); q.onerror = () => ok([]); } catch { ok([]); } });
  }
  async function del(id) {
    memDB.delete(id); const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
    const d = await db(); if (!d) return;
    try { d.transaction('media', 'readwrite').objectStore('media').delete(id); } catch {}
  }
  const urlCache = new Map();
  async function urlOf(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const r = await get(id); if (!r || !r.blob) return '';
    const u = URL.createObjectURL(r.blob); urlCache.set(id, u); return u;
  }

  /* ---------- utilidades ---------- */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function download(blobOrUrl, name) {
    const a = document.createElement('a');
    a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  async function shareBlob(blob, name, text) {
    try {
      const f = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], text: text || '' }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    download(blob, name);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  function plain(md) {
    return String(md || '').replace(/```[\s\S]*?```/g, ' (bloco de código) ').replace(/`([^`]+)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_#>|]+/g, ' ').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim();
  }

  /* ---------- LLM grátis "silencioso" (usa a mesma rota com fallback) ---------- */
  async function llmOnce(prompt, system) {
    const msgs = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
    for (const t of candidates(false)) {
      if (t.p.tier === 'paid') continue;
      bumpUsage(t.key);
      const r = await callTarget(t, msgs, () => {});
      if (r.ok && r.content) return r.content;
      penalize(t, r);
    }
    return '';
  }

  /* ---------- arquivos ---------- */
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|kt|c|h|cpp|hpp|cs|go|rs|rb|php|swift|sql|sh|bash|zsh|ps1|yml|yaml|toml|ini|env|log|srt|vtt|tex|r|lua|dart|vue|svelte)$/i;
  async function readPdf(file) {
    const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = '';
    const n = Math.min(doc.numPages, 80);
    for (let i = 1; i <= n && out.length < MAX_FILE_CHARS; i++) {
      const pg = await doc.getPage(i);
      const tc = await pg.getTextContent();
      out += '\n[página ' + i + ']\n' + tc.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('');
    }
    if (doc.numPages > n) out += '\n[… ' + (doc.numPages - n) + ' páginas não lidas]';
    return out.trim();
  }
  function pushFile(name, text) {
    const truncated = text.length > MAX_FILE_CHARS;
    state.pendingFiles.push({ name, text: truncated ? text.slice(0, MAX_FILE_CHARS) : text, truncated });
    renderAttach();
  }
  async function handleFiles(files) {
    for (const f of files) {
      try {
        if (window.Project && Project.handles(f)) { await Project.handle(f); continue; }
        if (f.type.startsWith('image/')) { addImage(f); continue; }
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) { toast('Lendo PDF…'); const t = await readPdf(f); if (!t) toast('PDF sem texto (talvez seja só imagem)'); else pushFile(f.name, t); continue; }
        if (f.type.startsWith('audio/') || f.type.startsWith('video/')) { await transcribeFile(f); continue; }
        if (f.type.startsWith('text/') || TEXT_EXT.test(f.name) || f.type === 'application/json' || f.size < 1.5e6) {
          const t = await f.text();
          if (/\u0000/.test(t.slice(0, 2000))) { toast(f.name + ': formato binário não suportado'); continue; }
          pushFile(f.name, t); continue;
        }
        toast(f.name + ': tipo não suportado');
      } catch (e) { toast('Falha ao ler ' + f.name + ': ' + (e.message || e)); }
    }
  }
  function pick(accept, capture) {
    const fi = $('#fileInput');
    fi.accept = accept || '';
    if (capture) fi.setAttribute('capture', capture); else fi.removeAttribute('capture');
    fi.click();
  }
  function openAttachSheet() {
    openSheet('<h3>Anexar</h3><p class="lead">Imagens vão para modelos com visão. Texto, código, CSV e PDF entram no contexto da conversa.</p><div class="card list">' +
      [['img', 'Foto ou imagem da galeria', 'JPG, PNG, WebP'], ['cam', 'Câmera', 'Tirar foto agora'], ['file', 'Arquivo', 'PDF, Word, Excel, PowerPoint, TXT, CSV, JSON, código…'], ['zip', 'Projeto ZIP', 'Lê todos os arquivos e conecta à conversa'], ['projs', 'Projetos salvos', 'Reabrir um ZIP já importado'], ['audio', 'Áudio para transcrever', groqReady() ? 'Groq Whisper (grátis)' : 'Requer chave Groq'], ['gen', 'Gerar imagem com IA grátis', 'Insere o comando /imagem']]
        .map(o => '<button class="row" data-o="' + o[0] + '"><div class="grow"><div class="title">' + o[1] + '</div><div class="sub">' + o[2] + '</div></div></button>').join('') + '</div>');
    $$('[data-o]', $('#sheetBody')).forEach(b => b.onclick = () => {
      const o = b.dataset.o;
      if (o === 'img') { closeSheet(); pick('image/*'); }
      if (o === 'zip') { closeSheet(); pick('.zip,application/zip,application/x-zip-compressed'); }
      if (o === 'projs' && window.Project) Project.openList();
      if (o === 'file') { closeSheet(); pick('.zip,.docx,.xlsx,.pptx,.odt,.ods,.odp,.pdf,.txt,.md,.csv,.tsv,.json,.jsonl,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.java,.kt,.c,.cpp,.cs,.go,.rs,.rb,.php,.swift,.sql,.sh,.yml,.yaml,.toml,.ini,.log,.srt,.vtt,text/*,application/pdf,application/json'); }
      if (o === 'audio') { closeSheet(); pick('audio/*,video/*'); }
      if (o === 'cam') openCamera();
      if (o === 'gen') { closeSheet(); const i = $('#input'); i.value = '/imagem ' + i.value.replace(/^\/imagem\s*/i, ''); i.focus(); autoGrow(); }
    });
  }

  /* ---------- câmera ---------- */
  let camStream = null, camFacing = 'environment';
  function stopCam() { if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; } }
  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Câmera indisponível neste navegador'); return; }
    openSheet('<h3>Câmera</h3><p class="lead">A foto fica só neste aparelho até você enviar.</p><div class="cam"><video id="camV" playsinline autoplay muted></video></div><div class="btn-row" style="margin-top:12px"><button class="btn" id="camFlip">Trocar câmera</button><button class="btn primary" id="camShot">Tirar foto</button></div>');
    const start = async () => {
      stopCam();
      try {
        camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: camFacing, width: { ideal: 1600 } }, audio: false });
        $('#camV').srcObject = camStream;
      } catch (e) { $('.cam').innerHTML = '<div class="warnbox">Sem acesso à câmera: ' + esc(e.message || e.name) + '. Libere em Mais → Permissões ou nas configurações do site.</div>'; }
    };
    $('#camFlip').onclick = () => { camFacing = camFacing === 'environment' ? 'user' : 'environment'; start(); };
    $('#camShot').onclick = () => {
      const v = $('#camV'); if (!v || !v.videoWidth) return;
      const max = 1024, r = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * r); c.height = Math.round(v.videoHeight * r);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      state.pendingImages.push(c.toDataURL('image/jpeg', 0.85)); renderAttach();
      closeSheet(); showView('chat'); toast('Foto anexada');
    };
    start();
  }
  const origClose = closeSheet;
  // eslint-disable-next-line no-global-assign
  closeSheet = function () { stopCam(); origClose(); };

  /* ---------- ditado / transcrição ---------- */
  let rec = null, recChunks = [], sr = null;
  function micUI(on) { const b = $('#btnMic'); b.classList.toggle('rec', on); b.setAttribute('aria-label', on ? 'Parar ditado' : 'Ditar por voz'); }
  async function groqTranscribe(blob, name) {
    const g = prov('groq');
    const fd = new FormData();
    fd.append('file', blob, name || 'audio.webm');
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('language', (S().sttLang || 'pt-BR').slice(0, 2));
    fd.append('response_format', 'json');
    const r = await fetch(baseOf(g) + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + g.key.trim() }, body: fd });
    const txt = await r.text();
    if (!r.ok) throw new Error('Groq ' + r.status + ': ' + parseErr(txt));
    return JSON.parse(txt).text || '';
  }
  function insertText(t) { const i = $('#input'); i.value = (i.value ? i.value.replace(/\s*$/, ' ') : '') + t.trim(); autoGrow(); i.focus(); }
  async function transcribeFile(f) {
    if (!groqReady()) { toast('Para transcrever arquivos, configure a chave grátis da Groq'); return; }
    if (f.size > 25e6) { toast('Arquivo acima de 25 MB'); return; }
    toast('Transcrevendo com Whisper…');
    try { const t = await groqTranscribe(f, f.name); insertText(t); toast('Transcrição inserida'); } catch (e) { toast(e.message); }
  }
  async function toggleMic() {
    if (rec) { rec.stop(); return; }
    if (sr) { sr.stop(); return; }
    const useGroq = S().sttEngine === 'groq' || (S().sttEngine === 'auto' && groqReady());
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (useGroq && window.MediaRecorder && navigator.mediaDevices) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recChunks = [];
        rec = new MediaRecorder(stream);
        rec.ondataavailable = e => e.data.size && recChunks.push(e.data);
        rec.onstop = async () => {
          stream.getTracks().forEach(t => t.stop()); micUI(false);
          const blob = new Blob(recChunks, { type: rec.mimeType || 'audio/webm' }); rec = null;
          if (blob.size < 800) return;
          toast('Transcrevendo…');
          try { insertText(await groqTranscribe(blob, 'ditado.' + (blob.type.includes('mp4') ? 'm4a' : 'webm'))); } catch (e) { toast(e.message); }
        };
        rec.start(); micUI(true); toast('Gravando… toque de novo para parar');
      } catch (e) { toast('Microfone bloqueado: ' + (e.message || e.name)); rec = null; }
      return;
    }
    if (SR) {
      sr = new SR(); sr.lang = S().sttLang || 'pt-BR'; sr.interimResults = true; sr.continuous = true;
      const input = $('#input'); const base = input.value ? input.value.replace(/\s*$/, ' ') : '';
      let finalTxt = '';
      sr.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalTxt += r[0].transcript; else interim += r[0].transcript; }
        input.value = base + finalTxt + interim; autoGrow();
      };
      sr.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Ditado: ' + e.error); };
      sr.onend = () => { sr = null; micUI(false); };
      try { sr.start(); micUI(true); } catch (e) { sr = null; toast('Não foi possível iniciar o ditado'); }
      return;
    }
    toast('Ditado indisponível neste navegador. Configure a Groq para usar Whisper.');
  }

  /* ---------- falar (TTS) ---------- */
  let speaking = null;
  function stopSpeak() {
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (speaking && speaking.audio) { speaking.audio.pause(); }
    if (speaking && speaking.btn) speaking.btn.textContent = 'Ouvir';
    speaking = null;
  }
  function voices() { return window.speechSynthesis ? speechSynthesis.getVoices() : []; }
  function pickVoice() {
    const vs = voices(); const want = S().ttsVoice;
    return vs.find(v => v.voiceURI === want) || vs.find(v => /pt[-_]BR/i.test(v.lang)) || vs.find(v => /^pt/i.test(v.lang)) || null;
  }
  async function pollTTS(text) {
    const key = pollKey();
    if (!key) throw new Error('Voz Pollinations precisa da chave grátis (Provedores → Pollinations)');
    const r = await fetch(POLL + '/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: 'openai/tts-1', input: text.slice(0, 4000), voice: S().pollVoice || 'nova', response_format: 'mp3' }) });
    if (!r.ok) throw new Error('Pollinations ' + r.status + ': ' + parseErr(await r.text()));
    return r.blob();
  }
  async function speak(md, btn, opts) {
    if (speaking && (!btn || speaking.btn === btn)) { stopSpeak(); return; }
    stopSpeak();
    const text = plain(md); if (!text) return;
    const engine = (opts && opts.engine) || S().ttsEngine;
    speaking = { btn }; if (btn) btn.textContent = 'Parar';
    const done = () => { if (speaking && speaking.btn === btn) { if (btn) btn.textContent = 'Ouvir'; speaking = null; } };
    if (engine === 'pollinations') {
      try {
        const blob = await pollTTS(text);
        const a = new Audio(URL.createObjectURL(blob)); speaking.audio = a; a.onended = done; a.play();
        return blob;
      } catch (e) { toast(e.message + ' — usando voz do navegador'); }
    }
    if (!window.speechSynthesis) { toast('Voz indisponível neste navegador'); done(); return; }
    const chunks = text.match(/[^.!?;:]{1,220}[.!?;:]?/g) || [text];
    const v = pickVoice(); const rate = S().ttsRate || 1;
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c.trim()); if (v) u.voice = v; u.lang = v ? v.lang : 'pt-BR'; u.rate = rate;
      if (i === chunks.length - 1) u.onend = done;
      speechSynthesis.speak(u);
    });
  }

  /* ---------- notificações / tela ativa / localização ---------- */
  async function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const opts = { body: (body || '').slice(0, 180), icon: 'icon-192.png', badge: 'icon-192.png', tag: 'gateway-ia' };
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) { await reg.showNotification(title, opts); return true; }
    } catch {}
    try { new Notification(title, opts); return true; } catch { return false; }
  }
  function afterReply(chat, msg) {
    if (S().notify && document.hidden && (msg.content || msg.error)) notify(msg.error && !msg.content ? 'Falha na resposta' : 'Resposta pronta', plain(msg.content || msg.error));
    if (S().autoSpeak && msg.content) speak(msg.content);
  }
  let wl = null;
  async function wake(on) {
    try {
      if (on && S().wakeLock && navigator.wakeLock && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); }
      if (!on && wl) { await wl.release(); wl = null; }
    } catch { wl = null; }
  }
  let loc = null;
  function refreshLocation(force) {
    return new Promise((ok) => {
      if (!navigator.geolocation) return ok(null);
      if (!force && loc && Date.now() - loc.ts < 30 * 60000) return ok(loc);
      navigator.geolocation.getCurrentPosition(p => { loc = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), ts: Date.now() }; ok(loc); }, () => ok(null), { maximumAge: 10 * 60000, timeout: 10000 });
    });
  }
  function locationLine() {
    if (!loc) { refreshLocation(); return ''; }
    if (Date.now() - loc.ts > 30 * 60000) refreshLocation();
    return 'Localização aproximada do usuário (informada pelo navegador): ' + loc.lat.toFixed(3) + ', ' + loc.lon.toFixed(3) + ' (±' + loc.acc + ' m). Use só se for relevante.';
  }

  /* ---------- geração de imagem (somente grátis) ---------- */
  const IMG_MODELS = [
    ['zimage', 'Z-Image Turbo', 'rápido, bom padrão'],
    ['flux', 'FLUX.1 schnell', 'clássico, versátil'],
    ['sana', 'DreamShaper LCM', 'estilizado (com chave)'],
    ['klein', 'FLUX.2 klein 4B', 'detalhado (com chave)'],
    ['gptimage', 'GPT Image 1 mini', 'texto na imagem (com chave)']
  ];
  const SIZES = { '1024x1024': '1:1', '768x1344': '9:16', '1344x768': '16:9', '896x1152': '3:4' };
  async function genPollinations(prompt, model, w, h, seed) {
    const key = pollKey();
    const url = POLL + '/image/' + encodeURIComponent(prompt) + '?model=' + encodeURIComponent(model) + '&width=' + w + '&height=' + h + '&seed=' + seed + '&safe=true';
    const r = await fetch(url, { headers: key ? { Authorization: 'Bearer ' + key } : {} });
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 401 || r.status === 402) throw Object.assign(new Error(key ? 'Pollinations recusou a chave ou o modelo exige saldo pago.' : 'A cota sem chave da Pollinations acabou. Crie uma chave grátis em enter.pollinations.ai/keys e cole em Provedores → Pollinations.'), { auth: true });
      throw new Error('Pollinations ' + r.status + ': ' + parseErr(t));
    }
    const blob = await r.blob();
    if (!blob.type.startsWith('image/')) throw new Error('Resposta inesperada da Pollinations');
    return blob;
  }
  async function genCloudflare(prompt, seed) {
    const c = prov('cloudflare');
    const url = viaProxy(c, 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(c.accountId.trim()) + '/ai/run/@cf/black-forest-labs/flux-1-schnell');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key.trim() }, body: JSON.stringify({ prompt, steps: 4, seed }) });
    const t = await r.text();
    if (!r.ok) throw new Error('Cloudflare ' + r.status + ': ' + parseErr(t));
    const j = JSON.parse(t); const b64 = j.result && j.result.image;
    if (!b64) throw new Error('Cloudflare não retornou imagem');
    const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: 'image/jpeg' });
  }
  async function genImage(prompt, o = {}) {
    const engine = o.engine || S().imgEngine; const model = o.model || S().imgModel;
    const [w, h] = (o.size || S().imgSize || '1024x1024').split('x').map(Number);
    const seed = o.seed != null ? o.seed : Math.floor(Math.random() * 1e9);
    const t0 = performance.now();
    const tries = engine === 'cloudflare' ? ['cloudflare', 'pollinations'] : ['pollinations', 'cloudflare'];
    let lastErr = null;
    for (const eng of tries) {
      if (eng === 'cloudflare' && !cfReady()) { if (engine === 'cloudflare') lastErr = new Error('Cloudflare precisa de token, Account ID e proxy CORS (Rotas)'); continue; }
      try {
        const blob = eng === 'pollinations' ? await genPollinations(prompt, model, w, h, seed) : await genCloudflare(prompt, seed);
        const rec = { id: 'm' + uid(), kind: 'image', blob, prompt, engine: eng === 'pollinations' ? 'Pollinations' : 'Cloudflare', model: eng === 'pollinations' ? model : 'flux-1-schnell', seed, w, h, ms: Math.round(performance.now() - t0), ts: Date.now() };
        await put(rec);
        return rec;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Nenhum gerador grátis disponível');
  }
  async function chatImage(chat, prompt) {
    const msg = { role: 'assistant', content: '', media: [], meta: { trail: [], current: 'Gerando imagem…' } };
    chat.messages.push(msg); renderChat(); setBusy(true); state.busy = { cancelled: false };
    try {
      const rec = await genImage(prompt);
      msg.media.push({ id: rec.id, kind: 'image' });
      msg.meta.via = { provider: rec.engine, tier: 'free', model: rec.model, ms: rec.ms };
      msg.content = 'Imagem gerada para: “' + prompt + '”';
    } catch (e) { msg.error = e.message; }
    delete msg.meta.current; state.busy = null; setBusy(false); chat.updated = Date.now(); saveChats(); renderChat(); renderChatList();
    if (S().notify && document.hidden) notify(msg.error ? 'Falha ao gerar imagem' : 'Imagem pronta', prompt);
  }
  function mediaHtml(items) {
    return '<div class="media-grid">' + items.map(it => {
      const cached = urlCache.get(it.id);
      if (!cached) urlOf(it.id).then(u => { $$('[data-mid="' + it.id + '"]').forEach(el => { if (u) { el.src = u; el.classList.remove('loading'); } else el.replaceWith(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Mídia não está neste aparelho.' })); }); });
      const src = cached ? ' src="' + cached + '"' : '';
      return it.kind === 'video' ? '<video controls playsinline data-mid="' + it.id + '"' + src + '></video>'
        : '<img class="gen' + (cached ? '' : ' loading') + '" data-mid="' + it.id + '"' + src + ' alt="Imagem gerada" onclick="Media.openMedia(\'' + it.id + '\')">';
    }).join('') + '</div>';
  }
  async function openMedia(id) {
    const r = await get(id); if (!r) return;
    const u = await urlOf(id);
    const ext = r.kind === 'video' ? (r.blob.type.includes('mp4') ? 'mp4' : 'webm') : (r.blob.type.includes('png') ? 'png' : 'jpg');
    openSheet('<h3>' + (r.kind === 'video' ? 'Vídeo' : 'Imagem') + '</h3><p class="lead">' + esc(r.engine + ' · ' + r.model + (r.seed != null ? ' · seed ' + r.seed : '')) + '</p>' +
      (r.kind === 'video' ? '<video class="preview" controls playsinline src="' + u + '"></video>' : '<img class="preview" src="' + u + '" alt="">') +
      '<p style="font-size:13.5px;margin:10px 2px">' + esc(r.prompt) + '</p>' +
      '<div class="btn-row"><button class="btn primary" id="mDl">Baixar</button><button class="btn" id="mSh">Compartilhar</button>' + (r.kind === 'image' ? '<button class="btn" id="mChat">Usar no chat</button><button class="btn" id="mAgain">Variação</button>' : '') + '<button class="btn danger" id="mDel">Apagar</button></div>');
    const name = 'gateway-ia-' + stamp() + '.' + ext;
    $('#mDl').onclick = () => download(r.blob, name);
    $('#mSh').onclick = () => shareBlob(r.blob, name, r.prompt);
    const mc = $('#mChat'); if (mc) mc.onclick = async () => { const fr = new FileReader(); fr.onload = () => { addImageFromDataURL(fr.result); closeSheet(); showView('chat'); }; fr.readAsDataURL(r.blob); };
    const ma = $('#mAgain'); if (ma) ma.onclick = () => { closeSheet(); showView('create'); setCreateTab('image'); $('#iPrompt').value = r.prompt; runImage(); };
    $('#mDel').onclick = async () => { await del(id); closeSheet(); if (state.view === 'create') renderCreate(); else renderChat(); };
  }
  function addImageFromDataURL(d) {
    const img = new Image();
    img.onload = () => { const max = 1024, r = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); state.pendingImages.push(c.toDataURL('image/jpeg', 0.85)); renderAttach(); toast('Imagem anexada ao chat'); };
    img.src = d;
  }

  /* ---------- aba Criar ---------- */
  let ctab = 'image';
  function setCreateTab(t) { ctab = t; renderCreate(); }
  function engineNote() {
    return '<p class="hint">Pollinations: ' + (pollKey() ? 'chave configurada' : 'sem chave — algumas imagens por IP, depois pede chave grátis') + ' · Cloudflare: ' + (cfReady() ? 'pronto' : 'precisa de token, Account ID e proxy') + '</p>';
  }
  function renderCreate() {
    const box = $('#createPanel'); const s = S();
    const tabs = '<div class="seg seg3" style="margin-bottom:14px">' + [['image', 'Imagem'], ['video', 'Vídeo'], ['voice', 'Voz']].map(t => '<button data-ct="' + t[0] + '" class="' + (ctab === t[0] ? 'on' : '') + '">' + t[1] + '</button>').join('') + '</div>';
    let body = '';
    if (ctab === 'image') {
      body = '<div class="card" style="padding:14px"><div class="field"><label>Descreva a imagem</label><textarea class="textarea" id="iPrompt" placeholder="Ex.: um ipê amarelo florido numa estrada de terra no noroeste de Minas, luz dourada, fotografia">' + esc(state._lastImgPrompt || '') + '</textarea></div>' +
        '<div class="btn-row" style="margin-bottom:12px"><button class="btn small ghost" id="iEnh" style="flex:0">Melhorar prompt com IA grátis</button></div>' +
        '<div class="field"><label>Gerador</label><select class="input" id="iEng"><option value="pollinations"' + (s.imgEngine === 'pollinations' ? ' selected' : '') + '>Pollinations (grátis)</option><option value="cloudflare"' + (s.imgEngine === 'cloudflare' ? ' selected' : '') + '>Cloudflare FLUX schnell (10k Neurons/dia grátis)</option></select></div>' +
        '<div class="field" id="iModelF"' + (s.imgEngine === 'cloudflare' ? ' hidden' : '') + '><label>Modelo</label><select class="input" id="iModel">' + IMG_MODELS.map(m => '<option value="' + m[0] + '"' + (s.imgModel === m[0] ? ' selected' : '') + '>' + m[1] + ' — ' + m[2] + '</option>').join('') + '</select></div>' +
        '<div class="field"><label>Formato</label><div class="seg seg4">' + Object.entries(SIZES).map(([k, v]) => '<button data-sz="' + k + '" class="' + (s.imgSize === k ? 'on' : '') + '">' + v + '</button>').join('') + '</div></div>' +
        '<div class="field"><label>Quantidade</label><div class="seg seg4">' + [1, 2, 3, 4].map(n => '<button data-n="' + n + '" class="' + ((state._imgN || 1) === n ? 'on' : '') + '">' + n + '</button>').join('') + '</div></div>' +
        '<button class="btn primary" id="iGo" style="width:100%">Gerar imagem</button><div id="iStatus"></div>' + engineNote() + '</div>' +
        '<div class="section-title">Galeria <span style="flex:1"></span><span id="gCount" style="text-transform:none;letter-spacing:0;font-weight:500"></span></div><div class="gallery" id="gallery"></div>' +
        '<p class="hint">No chat, use <code>/imagem descrição</code> para gerar direto na conversa. Imagens ficam salvas só neste navegador.</p>';
    } else if (ctab === 'video') {
      body = '<div class="warnbox" style="margin-bottom:12px">Nenhuma API de vídeo por IA é grátis hoje: na Pollinations todos os modelos de vídeo exigem saldo pago, e fal/Replicate cobram por segundo. Este modo cria um vídeo de graça: a IA grátis roteiriza as cenas, o gerador grátis cria cada quadro e o navegador anima (zoom suave + transições + legendas) e grava o arquivo.</div>' +
        '<div class="card" style="padding:14px"><div class="field"><label>Tema do vídeo</label><textarea class="textarea" id="vPrompt" placeholder="Ex.: 5 curiosidades sobre o Cerrado">' + esc(state._lastVidPrompt || '') + '</textarea></div>' +
        '<div class="field"><label>Formato</label><div class="seg seg3">' + [['9:16', 'Vertical'], ['16:9', 'Horizontal'], ['1:1', 'Quadrado']].map(f => '<button data-vf="' + f[0] + '" class="' + ((state._vf || '9:16') === f[0] ? 'on' : '') + '">' + f[1] + '<small>' + f[0] + '</small></button>').join('') + '</div></div>' +
        '<div class="field"><label>Cenas: <span id="vNv">' + (state._vn || 5) + '</span></label><input type="range" id="vN" min="2" max="8" value="' + (state._vn || 5) + '"></div>' +
        '<div class="field"><label>Segundos por cena: <span id="vSv">' + (state._vs || 3) + '</span></label><input type="range" id="vS" min="2" max="7" value="' + (state._vs || 3) + '"></div>' +
        '<div class="row" style="padding:0 0 10px;border:0;min-height:0"><div class="grow"><div class="title" style="font-size:14px">Legendas</div></div><label class="switch"><input type="checkbox" id="vCap" ' + (state._vcap !== false ? 'checked' : '') + '><span></span></label></div>' +
        '<div class="row" style="padding:0 0 14px;border:0;min-height:0"><div class="grow"><div class="title" style="font-size:14px">Narração</div><div class="sub" style="white-space:normal">' + (pollKey() ? 'Pollinations tts-1 (chave grátis)' : 'Precisa da chave grátis da Pollinations — a voz do navegador não pode ser gravada') + '</div></div><label class="switch"><input type="checkbox" id="vNar" ' + (pollKey() && state._vnar ? 'checked' : '') + (pollKey() ? '' : ' disabled') + '><span></span></label></div>' +
        '<button class="btn primary" id="vGo" style="width:100%">Criar vídeo grátis</button><div id="vStatus"></div>' + engineNote() + '<p class="hint">Mantenha esta aba aberta durante a gravação (dura o tempo do vídeo).</p></div>' +
        '<div class="section-title">Vídeos</div><div class="gallery" id="gallery"></div>';
    } else {
      const vs = voices().filter(v => /^pt/i.test(v.lang)).concat(voices().filter(v => !/^pt/i.test(v.lang)));
      body = '<div class="card" style="padding:14px"><div class="field"><label>Texto para falar</label><textarea class="textarea" id="tText" placeholder="Digite ou cole um texto">' + esc(state._ttsText || '') + '</textarea></div>' +
        '<div class="field"><label>Voz</label><select class="input" id="tEng"><option value="browser"' + (s.ttsEngine === 'browser' ? ' selected' : '') + '>Navegador — grátis, offline</option><option value="pollinations"' + (s.ttsEngine === 'pollinations' ? ' selected' : '') + '>Pollinations tts-1 — grátis com chave</option></select></div>' +
        (s.ttsEngine === 'browser'
          ? '<div class="field"><label>Voz do sistema</label><select class="input" id="tVoice"><option value="">Automática (português)</option>' + vs.map(v => '<option value="' + esc(v.voiceURI) + '"' + (s.ttsVoice === v.voiceURI ? ' selected' : '') + '>' + esc(v.name + ' · ' + v.lang) + '</option>').join('') + '</select></div>' +
            '<div class="field"><label>Velocidade: <span id="tRv">' + (s.ttsRate || 1) + '</span></label><input type="range" id="tRate" min="0.6" max="1.6" step="0.1" value="' + (s.ttsRate || 1) + '"></div>'
          : '<div class="field"><label>Voz Pollinations</label><select class="input" id="tPV">' + ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer'].map(v => '<option' + (s.pollVoice === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></div>') +
        '<div class="btn-row"><button class="btn primary" id="tPlay">Ouvir</button>' + (s.ttsEngine === 'pollinations' ? '<button class="btn" id="tDl">Baixar MP3</button>' : '') + '</div></div>' +
        '<div class="section-title">Ditado e transcrição</div><div class="card" style="padding:14px">' +
        '<div class="field"><label>Mecanismo</label><select class="input" id="sEng"><option value="auto"' + (s.sttEngine === 'auto' ? ' selected' : '') + '>Automático (Groq se houver chave, senão navegador)</option><option value="groq"' + (s.sttEngine === 'groq' ? ' selected' : '') + '>Groq Whisper — grátis com chave</option><option value="browser"' + (s.sttEngine === 'browser' ? ' selected' : '') + '>Navegador — grátis</option></select></div>' +
        '<div class="field"><label>Idioma</label><select class="input" id="sLang">' + [['pt-BR', 'Português (Brasil)'], ['en-US', 'Inglês'], ['es-ES', 'Espanhol']].map(l => '<option value="' + l[0] + '"' + (s.sttLang === l[0] ? ' selected' : '') + '>' + l[1] + '</option>').join('') + '</select></div>' +
        '<div class="btn-row"><button class="btn" id="sFile">Transcrever arquivo de áudio</button></div>' +
        '<p class="hint">No chat, toque no microfone para ditar. Groq: ' + (groqReady() ? 'chave configurada' : 'sem chave') + '.</p></div>' +
        '<div class="section-title">Respostas faladas</div><div class="card"><div class="row"><div class="grow"><div class="title" style="font-size:14px">Ler respostas automaticamente</div><div class="sub">Modo conversa por voz</div></div><label class="switch"><input type="checkbox" id="sAuto" ' + (s.autoSpeak ? 'checked' : '') + '><span></span></label></div></div>';
    }
    box.innerHTML = tabs + body;
    $$('[data-ct]', box).forEach(b => b.onclick = () => setCreateTab(b.dataset.ct));
    if (ctab === 'image') bindImage(box);
    if (ctab === 'video') bindVideo(box);
    if (ctab === 'voice') bindVoice(box);
    if (ctab !== 'voice') renderGallery(ctab === 'video' ? 'video' : 'image');
  }
  async function renderGallery(kind) {
    const g = $('#gallery'); if (!g) return;
    const items = (await all()).filter(r => r.kind === kind);
    const c = $('#gCount'); if (c) c.textContent = items.length ? items.length + ' itens' : '';
    if (!items.length) { g.innerHTML = '<p class="hint" style="grid-column:1/-1">Nada ainda.</p>'; return; }
    g.innerHTML = items.slice(0, 60).map(r => r.kind === 'video' ? '<button data-g="' + r.id + '" class="gv"><video muted playsinline preload="metadata" data-mid="' + r.id + '"></video><span>▶</span></button>' : '<button data-g="' + r.id + '"><img data-mid="' + r.id + '" alt=""></button>').join('');
    for (const r of items.slice(0, 60)) { const u = await urlOf(r.id); $$('[data-mid="' + r.id + '"]', g).forEach(el => el.src = u); }
    $$('[data-g]', g).forEach(b => b.onclick = () => openMedia(b.dataset.g));
  }
  function bindImage(box) {
    const s = S();
    $('#iEng', box).onchange = (e) => { s.imgEngine = e.target.value; saveSettings(); $('#iModelF').hidden = s.imgEngine === 'cloudflare'; };
    $('#iModel', box).onchange = (e) => { s.imgModel = e.target.value; saveSettings(); };
    $$('[data-sz]', box).forEach(b => b.onclick = () => { s.imgSize = b.dataset.sz; saveSettings(); $$('[data-sz]', box).forEach(x => x.classList.toggle('on', x === b)); });
    $$('[data-n]', box).forEach(b => b.onclick = () => { state._imgN = +b.dataset.n; $$('[data-n]', box).forEach(x => x.classList.toggle('on', x === b)); });
    $('#iPrompt', box).oninput = (e) => { state._lastImgPrompt = e.target.value; };
    $('#iEnh', box).onclick = async (e) => {
      const p = $('#iPrompt').value.trim(); if (!p) return;
      e.target.disabled = true; e.target.textContent = 'Melhorando…';
      const out = await llmOnce('Reescreva como um prompt de geração de imagem em inglês, detalhado (assunto, estilo, luz, composição, lente), em uma única frase, sem aspas e sem comentários:\n\n' + p);
      e.target.disabled = false; e.target.textContent = 'Melhorar prompt com IA grátis';
      if (out) { $('#iPrompt').value = out.trim().replace(/^["“]|["”]$/g, ''); state._lastImgPrompt = $('#iPrompt').value; } else toast('Nenhuma IA de texto grátis disponível (configure em Provedores)');
    };
    $('#iGo', box).onclick = runImage;
  }
  let imgBusy = false;
  async function runImage() {
    if (imgBusy) return;
    const p = ($('#iPrompt') || {}).value ? $('#iPrompt').value.trim() : ''; if (!p) { toast('Descreva a imagem'); return; }
    imgBusy = true; const st = $('#iStatus'); const n = state._imgN || 1; const btn = $('#iGo'); if (btn) btn.disabled = true;
    let ok = 0, err = '';
    for (let i = 0; i < n; i++) {
      if (st) st.innerHTML = '<p class="hint">Gerando ' + (i + 1) + ' de ' + n + '…</p>';
      try { await genImage(p); ok++; renderGallery('image'); } catch (e) { err = e.message; break; }
    }
    imgBusy = false; if (btn) btn.disabled = false;
    if (st) st.innerHTML = err ? '<div class="warnbox" style="margin-top:10px">' + esc(err) + '</div>' : '<p class="hint">' + ok + ' imagem(ns) pronta(s).</p>';
    if (S().notify && document.hidden) notify(err ? 'Falha ao gerar imagem' : 'Imagens prontas', p);
  }
  function bindVoice(box) {
    const s = S();
    $('#tText', box).oninput = (e) => { state._ttsText = e.target.value; };
    $('#tEng', box).onchange = (e) => { s.ttsEngine = e.target.value; saveSettings(); renderCreate(); };
    const tv = $('#tVoice', box); if (tv) tv.onchange = (e) => { s.ttsVoice = e.target.value; saveSettings(); };
    const tr = $('#tRate', box); if (tr) tr.oninput = (e) => { s.ttsRate = parseFloat(e.target.value); $('#tRv').textContent = s.ttsRate; saveSettings(); };
    const pv = $('#tPV', box); if (pv) pv.onchange = (e) => { s.pollVoice = e.target.value; saveSettings(); };
    $('#tPlay', box).onclick = (e) => { const t = $('#tText').value.trim(); if (t) speak(t, e.target); };
    const dl = $('#tDl', box); if (dl) dl.onclick = async () => { const t = $('#tText').value.trim(); if (!t) return; dl.disabled = true; try { download(await pollTTS(t), 'voz-' + stamp() + '.mp3'); } catch (e) { toast(e.message); } dl.disabled = false; };
    $('#sEng', box).onchange = (e) => { s.sttEngine = e.target.value; saveSettings(); };
    $('#sLang', box).onchange = (e) => { s.sttLang = e.target.value; saveSettings(); };
    $('#sFile', box).onclick = () => pick('audio/*,video/*');
    $('#sAuto', box).onchange = (e) => { s.autoSpeak = e.target.checked; saveSettings(); };
    if (window.speechSynthesis && !voices().length) speechSynthesis.onvoiceschanged = () => { if (state.view === 'create' && ctab === 'voice') renderCreate(); speechSynthesis.onvoiceschanged = null; };
  }

  /* ---------- vídeo grátis montado no navegador ---------- */
  function bindVideo(box) {
    $('#vPrompt', box).oninput = (e) => { state._lastVidPrompt = e.target.value; };
    $$('[data-vf]', box).forEach(b => b.onclick = () => { state._vf = b.dataset.vf; $$('[data-vf]', box).forEach(x => x.classList.toggle('on', x === b)); });
    $('#vN', box).oninput = (e) => { state._vn = +e.target.value; $('#vNv').textContent = e.target.value; };
    $('#vS', box).oninput = (e) => { state._vs = +e.target.value; $('#vSv').textContent = e.target.value; };
    $('#vCap', box).onchange = (e) => { state._vcap = e.target.checked; };
    const nar = $('#vNar', box); if (nar) nar.onchange = (e) => { state._vnar = e.target.checked; };
    $('#vGo', box).onclick = runVideo;
  }
  function pickMime() {
    const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }
  async function planScenes(theme, n) {
    const out = await llmOnce('Tema do vídeo: "' + theme + '".\nCrie exatamente ' + n + ' cenas para um vídeo curto. Responda SOMENTE com JSON no formato {"cenas":[{"visual":"descrição visual detalhada EM INGLÊS para gerar a imagem","legenda":"frase curta em português (máx. 90 caracteres)"}]}.',
      'Você é um roteirista de vídeos curtos. Responda apenas com JSON válido.');
    try {
      const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      const c = (j.cenas || j.scenes || []).filter(x => x && (x.visual || x.legenda)).slice(0, n);
      if (c.length) return c.map(x => ({ visual: String(x.visual || x.legenda), caption: String(x.legenda || '').slice(0, 120) }));
    } catch {}
    return Array.from({ length: n }, (_, i) => ({ visual: theme + ', cinematic scene ' + (i + 1) + ' of ' + n + ', varied composition', caption: i === 0 ? theme : '' }));
  }
  function loadImg(blob) { return new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = ko; im.src = URL.createObjectURL(blob); }); }
  function wrap(ctx, text, maxW) {
    const words = text.split(/\s+/); const lines = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line); return lines.slice(0, 3);
  }
  let vidBusy = false;
  async function runVideo() {
    if (vidBusy) return;
    const theme = ($('#vPrompt').value || '').trim(); if (!theme) { toast('Descreva o tema'); return; }
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { toast('Seu navegador não grava vídeo (MediaRecorder)'); return; }
    vidBusy = true; const st = $('#vStatus'); const btn = $('#vGo'); btn.disabled = true;
    const log = (t) => { if (st) st.innerHTML = '<p class="hint">' + esc(t) + '</p>'; };
    const n = state._vn || 5, secs = state._vs || 3, fmt = state._vf || '9:16', caps = state._vcap !== false, narr = !!(state._vnar && pollKey());
    const dims = { '9:16': [720, 1280, '768x1344'], '16:9': [1280, 720, '1344x768'], '1:1': [1080, 1080, '1024x1024'] }[fmt];
    wake(true);
    try {
      log('Roteirizando ' + n + ' cenas com IA grátis…');
      const scenes = await planScenes(theme, n);
      const imgs = [];
      for (let i = 0; i < scenes.length; i++) {
        log('Gerando imagem ' + (i + 1) + ' de ' + scenes.length + '…');
        const rec = await genImage(scenes[i].visual + ', high quality, no text', { size: dims[2], seed: 1000 + i * 7919 });
        imgs.push(await loadImg(rec.blob));
      }
      let actx = null, dest = null, buffers = [];
      if (narr) {
        actx = new AudioContext(); dest = actx.createMediaStreamDestination();
        for (let i = 0; i < scenes.length; i++) {
          if (!scenes[i].caption) { buffers.push(null); continue; }
          log('Gerando narração ' + (i + 1) + ' de ' + scenes.length + '…');
          try { const b = await pollTTS(scenes[i].caption); buffers.push(await actx.decodeAudioData(await b.arrayBuffer())); } catch (e) { buffers.push(null); }
        }
      }
      const durs = scenes.map((_, i) => Math.max(secs, buffers[i] ? buffers[i].duration + 0.5 : 0));
      const total = durs.reduce((a, b) => a + b, 0);
      const [W, H] = dims;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
      const stream = cv.captureStream(30);
      if (dest) dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      const mime = pickMime();
      const recd = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5e6 } : { videoBitsPerSecond: 5e6 });
      const chunks = []; recd.ondataavailable = e => e.data.size && chunks.push(e.data);
      const stopped = new Promise(r => recd.onstop = r);
      const drawScene = (i, t, alpha) => {
        const im = imgs[i]; const p = t / durs[i];
        const zoom = 1.04 + 0.12 * p; const dir = i % 2 ? 1 : -1;
        const sc = Math.max(W / im.width, H / im.height) * zoom;
        const w = im.width * sc, h = im.height * sc;
        const x = (W - w) / 2 + dir * (w - W) * 0.25 * (p - 0.5), y = (H - h) / 2;
        ctx.globalAlpha = alpha; ctx.drawImage(im, x, y, w, h); ctx.globalAlpha = 1;
      };
      const drawCaption = (text, alpha) => {
        if (!caps || !text) return;
        const fs = Math.round(Math.min(W, H) * 0.052);
        ctx.font = '700 ' + fs + 'px system-ui, Roboto, sans-serif';
        const lines = wrap(ctx, text, W * 0.84);
        const lh = fs * 1.25, boxH = lines.length * lh + fs * 0.9, y0 = H - boxH - H * 0.07;
        ctx.globalAlpha = alpha * 0.62; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(W * 0.05, y0, W * 0.9, boxH, fs * 0.5) : ctx.rect(W * 0.05, y0, W * 0.9, boxH); ctx.fill();
        ctx.globalAlpha = alpha; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        lines.forEach((l, k) => ctx.fillText(l, W / 2, y0 + fs * 0.45 + k * lh));
        ctx.globalAlpha = 1;
      };
      const starts = durs.map((_, i) => durs.slice(0, i).reduce((a, b) => a + b, 0));
      const XF = 0.6;
      recd.start(250);
      const t0 = performance.now(); let lastScene = -1;
      await new Promise((done) => {
        const tick = () => {
          const t = (performance.now() - t0) / 1000;
          if (t >= total) { done(); return; }
          let i = starts.findIndex((s0, k) => t >= s0 && t < s0 + durs[k]); if (i < 0) i = scenes.length - 1;
          if (i !== lastScene) { lastScene = i; log('Gravando cena ' + (i + 1) + ' de ' + scenes.length + '…'); if (actx && buffers[i]) { const src = actx.createBufferSource(); src.buffer = buffers[i]; src.connect(dest); src.start(); } }
          const lt = t - starts[i];
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          drawScene(i, lt, 1);
          const nextIn = durs[i] - lt;
          if (nextIn < XF && i + 1 < scenes.length) drawScene(i + 1, 0, 1 - nextIn / XF);
          const ca = Math.min(1, lt / 0.4, nextIn / 0.3);
          drawCaption(scenes[i].caption, Math.max(0, ca));
          setTimeout(tick, 1000 / 30);
        };
        tick();
      });
      recd.stop(); await stopped;
      if (actx) actx.close();
      const blob = new Blob(chunks, { type: (recd.mimeType || 'video/webm').split(';')[0] });
      const rec = { id: 'm' + uid(), kind: 'video', blob, prompt: theme, engine: 'Montagem no navegador', model: (imgs.length + ' cenas · ' + total.toFixed(0) + 's · ' + (blob.type.includes('mp4') ? 'MP4' : 'WebM')), ts: Date.now() };
      await put(rec);
      if (st) st.innerHTML = '<video class="preview" style="margin-top:12px" controls playsinline src="' + await urlOf(rec.id) + '"></video><div class="btn-row" style="margin-top:8px"><button class="btn primary" id="vDl">Baixar ' + (blob.type.includes('mp4') ? 'MP4' : 'WebM') + '</button><button class="btn" id="vSh">Compartilhar</button></div>';
      $('#vDl').onclick = () => download(blob, 'video-' + stamp() + (blob.type.includes('mp4') ? '.mp4' : '.webm'));
      $('#vSh').onclick = () => shareBlob(blob, 'video-' + stamp() + (blob.type.includes('mp4') ? '.mp4' : '.webm'), theme);
      renderGallery('video');
      if (S().notify && document.hidden) notify('Vídeo pronto', theme);
    } catch (e) {
      if (st) st.innerHTML = '<div class="warnbox" style="margin-top:10px">' + esc(e.message || String(e)) + '</div>';
    }
    vidBusy = false; btn.disabled = false; wake(false);
  }

  /* ---------- permissões ---------- */
  const PERMS = [
    { id: 'camera', name: 'Câmera', why: 'Tirar foto e enviar para modelos com visão', q: 'camera' },
    { id: 'microphone', name: 'Microfone', why: 'Ditado por voz e transcrição', q: 'microphone' },
    { id: 'notifications', name: 'Notificações', why: 'Avisar quando resposta, imagem ou vídeo ficar pronto', q: 'notifications' },
    { id: 'geolocation', name: 'Localização', why: 'Opcional: incluir local aproximado no contexto', q: 'geolocation' },
    { id: 'clipboard', name: 'Área de transferência', why: 'Colar chaves e configurações', q: 'clipboard-read' },
    { id: 'storage', name: 'Guardar dados', why: 'Evitar que o navegador apague conversas e galeria' },
    { id: 'wakelock', name: 'Tela ligada', why: 'Manter a tela acesa durante respostas e gravação de vídeo' }
  ];
  async function permState(p) {
    try {
      if (p.id === 'storage') return navigator.storage && navigator.storage.persisted ? ((await navigator.storage.persisted()) ? 'granted' : 'prompt') : 'unsupported';
      if (p.id === 'wakelock') return 'wakeLock' in navigator ? (S().wakeLock ? 'granted' : 'off') : 'unsupported';
      if (p.id === 'notifications' && !('Notification' in window)) return 'unsupported';
      if (p.id === 'camera' || p.id === 'microphone') { if (!navigator.mediaDevices) return 'unsupported'; }
      if (p.id === 'geolocation' && !navigator.geolocation) return 'unsupported';
      if (navigator.permissions && p.q) { const r = await navigator.permissions.query({ name: p.q }); return r.state; }
      if (p.id === 'notifications') return Notification.permission === 'default' ? 'prompt' : Notification.permission;
      return 'prompt';
    } catch { return p.id === 'clipboard' ? (navigator.clipboard ? 'prompt' : 'unsupported') : 'prompt'; }
  }
  async function requestPerm(id) {
    try {
      if (id === 'camera') { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop()); }
      if (id === 'microphone') { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
      if (id === 'notifications') { const r = await Notification.requestPermission(); if (r === 'granted') { S().notify = true; saveSettings(); notify('Notificações ativas', 'Você será avisado quando algo ficar pronto.'); } }
      if (id === 'geolocation') { const l = await refreshLocation(true); if (l) toast('Localização obtida (±' + l.acc + ' m)'); else toast('Localização negada ou indisponível'); }
      if (id === 'clipboard') { await navigator.clipboard.readText(); }
      if (id === 'storage') { const ok = await navigator.storage.persist(); toast(ok ? 'Armazenamento persistente ativado' : 'O navegador recusou (instale o app para aumentar a chance)'); }
      if (id === 'wakelock') { S().wakeLock = !S().wakeLock; saveSettings(); }
    } catch (e) { toast((e && e.name === 'NotAllowedError') ? 'Permissão negada — libere nas configurações do site' : (e.message || 'Não foi possível')); }
    renderPermissions();
  }
  const LBL = { granted: ['ok', 'Permitido'], denied: ['err', 'Bloqueado'], prompt: ['', 'Perguntar'], unsupported: ['', 'Indisponível'], off: ['', 'Desligado'] };
  async function renderPermissions() {
    const gp = $('#guidePanel'); if (!gp) return;
    let box = $('#permPanel');
    if (!box) { box = document.createElement('div'); box.id = 'permPanel'; const ap = $('#appearPanel', gp); if (ap) ap.after(box); else gp.prepend(box); }
    const states = await Promise.all(PERMS.map(permState));
    const s = S();
    box.innerHTML = '<div class="section-title">Permissões</div><div class="card list">' + PERMS.map((p, i) => {
      const [cls, lbl] = LBL[states[i]] || ['', states[i]];
      const can = states[i] !== 'unsupported' && !(states[i] === 'granted' && p.id !== 'wakelock');
      const btn = p.id === 'wakelock' ? (states[i] === 'unsupported' ? '' : '<button class="btn small" data-perm="wakelock">' + (s.wakeLock ? 'Desligar' : 'Ligar') + '</button>') : (can ? '<button class="btn small" data-perm="' + p.id + '">' + (states[i] === 'denied' ? 'Tentar' : 'Permitir') + '</button>' : '');
      return '<div class="row"><span class="status ' + cls + '"></span><div class="grow"><div class="title" style="font-size:14px">' + p.name + ' <span class="cap">' + lbl + '</span></div><div class="sub" style="white-space:normal">' + p.why + '</div></div>' + btn + '</div>';
    }).join('') + '</div>' +
      '<p class="hint">Se algo estiver “Bloqueado”, libere no ícone de cadeado da barra de endereço (ou em Configurações do app instalado → Permissões).</p>' +
      '<div class="section-title">Usar permissões</div><div class="card list">' +
      '<div class="row"><div class="grow"><div class="title" style="font-size:14px">Notificar quando ficar pronto</div><div class="sub">Só quando o app estiver em segundo plano</div></div><label class="switch"><input type="checkbox" id="pNotify" ' + (s.notify ? 'checked' : '') + '><span></span></label></div>' +
      '<div class="row"><div class="grow"><div class="title" style="font-size:14px">Incluir minha localização</div><div class="sub" style="white-space:normal">Envia coordenadas aproximadas ao provedor da conversa</div></div><label class="switch"><input type="checkbox" id="pLoc" ' + (s.includeLocation ? 'checked' : '') + '><span></span></label></div>' +
      '<div class="row"><div class="grow"><div class="title" style="font-size:14px">Testar notificação</div></div><button class="btn small" id="pTestN">Enviar</button></div>' +
      '</div>';
    $$('[data-perm]', box).forEach(b => b.onclick = () => requestPerm(b.dataset.perm));
    $('#pNotify', box).onchange = async (e) => {
      if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') { const r = await Notification.requestPermission(); if (r !== 'granted') { e.target.checked = false; toast('Notificações bloqueadas'); renderPermissions(); return; } }
      s.notify = e.target.checked; saveSettings(); renderPermissions();
    };
    $('#pLoc', box).onchange = async (e) => {
      if (e.target.checked) { const l = await refreshLocation(true); if (!l) { e.target.checked = false; toast('Sem acesso à localização'); return; } }
      s.includeLocation = e.target.checked; saveSettings(); renderPermissions();
    };
    $('#pTestN', box).onclick = async () => { if (!(await notify('Gateway IA', 'Notificação de teste funcionando.'))) toast('Permita as notificações primeiro'); };
  }

  /* ---------- exportar conversa ---------- */
  function exportChat(chat) {
    const c = chat && Array.isArray(chat.messages) ? chat : currentChat(); if (!c || !c.messages.length) { toast('Conversa vazia'); return; }
    const md = '# ' + c.title + '\n\n' + c.messages.map(m => (m.role === 'user' ? '## Você\n\n' : '## IA' + (m.meta && m.meta.via ? ' (' + m.meta.via.provider + ' · ' + m.meta.via.model + ')' : '') + '\n\n') + (m.content || m.error || '') + (m.files && m.files.length ? '\n\n_Anexos: ' + m.files.map(f => f.name).join(', ') + '_' : '')).join('\n\n');
    download(new Blob([md], { type: 'text/markdown' }), (c.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'conversa') + '.md');
  }

  /* ---------- ligações ---------- */
  $('#btnAttach').onclick = openAttachSheet;
  $('#btnMic').onclick = toggleMic;
  // Exportar .md fica nas opções de cada conversa (botão ⋯ na lista ou toque no título).
  if (S().includeLocation) refreshLocation();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.busy) wake(true); });

  window.Media = { db: { put, get, all, del }, download, shareBlob, stamp, handleFiles, chatImage, mediaHtml, openMedia, speak, afterReply, wake, locationLine, renderCreate, renderPermissions, notify, exportChat };
  if (state.view === 'chat') renderChat();
})();
