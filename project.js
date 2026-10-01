'use strict';
/* Gateway IA — projetos ZIP e documentos Office: ler, conectar à conversa, aplicar edições da IA e baixar ZIP atualizado. */
(function () {
  const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.2/+esm';
  let jzp = null;
  const JSZip = () => jzp || (jzp = import(JSZIP_URL).then(m => m.default || m));
  const DB = Media.db;
  const S = () => state.settings;
  const cache = new Map(); // id -> projeto carregado
  const ctxMap = new Map(); // chat.id -> texto de contexto da última pergunta

  const MAX_TEXT = 1.5e6, MAX_FILES = 4000, PER_FILE_CTX = 24000;
  const SKIP_DIR = /(^|\/)(node_modules|\.git|\.svn|\.hg|__pycache__|\.venv|venv|\.next|\.nuxt|\.gradle|\.idea|\.vscode|\.dart_tool|Pods|DerivedData|\.terraform|\.cache|coverage)(\/|$)/;
  const SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock)$|\.(min\.js|min\.css|map)$/i;
  const OFFICE = /\.(docx|xlsx|pptx|odt|ods|odp)$/i;
  const IMG = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

  /* ---------- texto de XML / Office ---------- */
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const dec = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] != null ? ENT[e] : m));
  const strip = (x) => dec(x.replace(/<[^>]+>/g, ''));
  const num = (p) => +((p.match(/(\d+)\.xml$/) || [0, 0])[1]);
  async function officeText(zip, name) {
    const ext = name.toLowerCase().split('.').pop();
    const read = async (p) => { const f = zip.file(p); return f ? f.async('string') : ''; };
    if (ext === 'docx') {
      const parts = ['word/document.xml', ...Object.keys(zip.files).filter(p => /^word\/(header|footer|footnotes)\d*\.xml$/.test(p))];
      let out = '';
      for (const p of parts) {
        const x = await read(p); if (!x) continue;
        out += strip(x.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, ' | ').replace(/<\/w:tr>/g, '\n')) + '\n';
      }
      return out.replace(/\n{3,}/g, '\n\n').trim();
    }
    if (ext === 'xlsx') {
      const ss = []; const sx = await read('xl/sharedStrings.xml');
      sx.replace(/<si>([\s\S]*?)<\/si>/g, (_, s) => { ss.push(strip(s.replace(/<rPh[\s\S]*?<\/rPh>/g, ''))); return ''; });
      const wb = await read('xl/workbook.xml'); const names = []; wb.replace(/<sheet [^>]*name="([^"]+)"/g, (_, n) => { names.push(dec(n)); return ''; });
      const sheets = Object.keys(zip.files).filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
      let out = '';
      for (let i = 0; i < sheets.length; i++) {
        const x = await read(sheets[i]); let rows = 0;
        out += '## Planilha: ' + (names[i] || 'Planilha ' + (i + 1)) + '\n';
        x.replace(/<row[^>]*>([\s\S]*?)<\/row>/g, (_, r) => {
          if (rows++ > 3000) return '';
          const cells = [];
          r.replace(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (__, attrs, inner) => {
            const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1]; const t = (attrs.match(/t="(\w+)"/) || [])[1];
            let v = inner ? ((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '') : '';
            if (t === 's') v = ss[+v] || ''; else if (t === 'inlineStr') v = strip((inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || ''); else v = dec(v);
            if (ref) { let col = 0; for (const ch of ref) col = col * 26 + ch.charCodeAt(0) - 64; while (cells.length < col - 1) cells.push(''); }
            cells.push(v); return '';
          });
          if (cells.some(c => c !== '')) out += cells.join(';') + '\n';
          return '';
        });
        if (rows > 3000) out += '[… linhas restantes omitidas]\n';
        out += '\n';
      }
      return out.trim();
    }
    if (ext === 'pptx') {
      const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
      let out = '';
      for (const p of slides) {
        const x = await read(p); const ts = []; x.replace(/<a:t>([\s\S]*?)<\/a:t>/g, (_, t) => { ts.push(dec(t)); return ''; });
        const nx = await read(p.replace('slides/slide', 'notesSlides/notesSlide')); const ns = []; nx.replace(/<a:t>([\s\S]*?)<\/a:t>/g, (_, t) => { ns.push(dec(t)); return ''; });
        out += '## Slide ' + num(p) + '\n' + ts.join('\n') + (ns.length ? '\n(Notas: ' + ns.join(' ') + ')' : '') + '\n\n';
      }
      return out.trim();
    }
    // OpenDocument
    const x = await read('content.xml');
    return strip(x.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<\/text:(p|h)>/g, '\n').replace(/<\/table:table-cell>/g, ';').replace(/<\/table:table-row>/g, '\n')).replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------- importar ---------- */
  function bytesToText(u8) {
    const n = Math.min(u8.length, 8000);
    for (let i = 0; i < n; i++) if (u8[i] === 0) return null;
    return new TextDecoder('utf-8').decode(u8);
  }
  async function importZip(file) {
    const Z = await JSZip();
    const zip = await Z.loadAsync(file);
    const files = [], skipped = [];
    let root = null;
    const entries = Object.values(zip.files).filter(e => !e.dir);
    // remove pasta raiz única (ex.: projeto-main/…)
    const firsts = new Set(entries.map(e => e.name.split('/')[0]));
    if (firsts.size === 1 && entries.every(e => e.name.includes('/'))) root = [...firsts][0] + '/';
    for (const e of entries) {
      const path = root ? e.name.slice(root.length) : e.name;
      if (/^__MACOSX\//.test(e.name)) continue;
      const size = e._data && e._data.uncompressedSize || 0;
      if (SKIP_DIR.test(path)) { skipped.push({ path, size, why: 'pasta ignorada' }); continue; }
      if (SKIP_FILE.test(path)) { skipped.push({ path, size, why: 'gerado/lock' }); continue; }
      if (files.length >= MAX_FILES) { skipped.push({ path, size, why: 'limite de arquivos' }); continue; }
      if (IMG.test(path) && !/\.svg$/i.test(path)) { files.push({ path, zpath: e.name, size, bin: true, img: true }); continue; }
      if (OFFICE.test(path)) {
        try { const sub = await Z.loadAsync(await e.async('uint8array')); const t = await officeText(sub, path); files.push({ path, zpath: e.name, size, text: t, office: true }); } catch { files.push({ path, zpath: e.name, size, bin: true }); }
        continue;
      }
      if (/\.pdf$/i.test(path)) { files.push({ path, zpath: e.name, size, bin: true, pdf: true }); continue; }
      if (size > MAX_TEXT) { files.push({ path, zpath: e.name, size, bin: true, big: true }); continue; }
      const t = bytesToText(await e.async('uint8array'));
      if (t == null) files.push({ path, zpath: e.name, size, bin: true });
      else files.push({ path, zpath: e.name, size, text: t });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const rec = { id: 'p' + uid(), kind: 'project', name: file.name.replace(/\.zip$/i, ''), ts: Date.now(), zip: file, root, files, skipped, pins: [] };
    await DB.put(rec); cache.set(rec.id, rec);
    return rec;
  }
  async function load(id) {
    if (cache.has(id)) return cache.get(id);
    const r = await DB.get(id); if (r) cache.set(id, r); return r;
  }
  const save = (p) => { p.ts = Date.now(); return DB.put(p); };

  function handles(f) { return /\.zip$/i.test(f.name) || /zip/.test(f.type) || OFFICE.test(f.name); }
  async function handle(f) {
    if (OFFICE.test(f.name)) {
      toast('Lendo ' + f.name + '…');
      const Z = await JSZip(); const t = await officeText(await Z.loadAsync(f), f.name);
      if (!t) { toast('Documento sem texto'); return; }
      const truncated = t.length > 60000;
      state.pendingFiles.push({ name: f.name, text: truncated ? t.slice(0, 60000) : t, truncated }); renderAttach();
      return;
    }
    toast('Lendo ZIP…');
    const p = await importZip(f);
    const chat = ensureChat();
    chat.project = p.id; if (chat.title === 'Nova conversa') chat.title = 'Projeto ' + p.name;
    saveChats(); renderChatList(); renderBar();
    const tx = p.files.filter(x => x.text != null).length;
    toast(tx + ' arquivos de texto conectados à conversa');
    openProject(p.id);
  }

  /* ---------- contexto para a IA ---------- */
  const STOP = new Set('para com uma umas uns que como onde quando qual quais porque isso esse essa este esta isto aqui ali não sim mais menos muito pouco sobre entre pelo pela pelos pelas dos das nos nas aos foi ser são está estão tem têm ter fazer faça faz arquivo arquivos projeto código the and for with this that from what how into your you are can file files code'.split(' '));
  function tokens(s) { return (s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9_$.-]{3,}/g) || []).filter(w => !STOP.has(w)); }
  function tree(p) {
    const lines = p.files.slice(0, 600).map(f => f.path + (f.bin ? ' [binário' + (f.img ? '/imagem' : f.pdf ? '/pdf' : '') + ']' : '') + ' (' + fmtSize(f.size || (f.text || '').length) + ')' + (f.mod ? ' *alterado' : '') + (f.added ? ' *novo' : ''));
    if (p.files.length > 600) lines.push('… +' + (p.files.length - 600) + ' arquivos');
    return lines.join('\n');
  }
  function pickFiles(p, question, history) {
    const budget = S().projBudget || 60000;
    const txt = p.files.filter(f => f.text != null);
    const total = txt.reduce((a, f) => a + Math.min(f.text.length, PER_FILE_CTX), 0);
    if (total <= budget) return txt;
    const q = question.toLowerCase();
    const qt = tokens(question + ' ' + (history || ''));
    const scored = txt.map(f => {
      let s = 0; const base = f.path.split('/').pop().toLowerCase();
      if (p.pins.includes(f.path)) s += 1000;
      if (q.includes(f.path.toLowerCase())) s += 500; else if (base.length >= 4 && q.includes(base)) s += 300; else if (base.includes('.') && q.includes(base.split('.')[0]) && base.split('.')[0].length >= 4) s += 80;
      if (f.mod || f.added) s += 40;
      if (/^(readme|package\.json|pyproject\.toml|requirements\.txt|build\.gradle|pom\.xml|cargo\.toml|go\.mod|index\.html|main\.\w+|app\.\w+)$/i.test(base)) s += 15;
      const low = f.text.slice(0, 200000).toLowerCase(); const pl = f.path.toLowerCase();
      for (const w of new Set(qt)) {
        if (pl.includes(w)) s += 12;
        let c = 0, i = 0; while ((i = low.indexOf(w, i)) !== -1 && c < 30) { c++; i += w.length; }
        s += c ? 2 + Math.log2(1 + c) * 2 : 0;
      }
      return { f, s: s / (1 + Math.log10(1 + f.text.length / 4000)) };
    }).sort((a, b) => b.s - a.s);
    const out = []; let used = 0;
    for (const { f, s } of scored) { if (s <= 0 && out.length) break; const n = Math.min(f.text.length, PER_FILE_CTX); if (used + n > budget && out.length) continue; out.push(f); used += n; if (used >= budget) break; }
    return out;
  }
  async function prepare(chat, question, userMsg) {
    const p = await load(chat.project);
    if (!p) { ctxMap.delete(chat.id); return; }
    const hist = chat.messages.slice(-4, -1).map(m => (m.content || '').slice(0, 600)).join(' ');
    const sel = pickFiles(p, question || '', hist);
    if (userMsg) userMsg.ctxFiles = sel.map(f => f.path);
    const ctx = 'O usuário conectou o projeto “' + p.name + '” (' + p.files.length + ' arquivos). Use o conteúdo abaixo para responder; cite os caminhos dos arquivos. Se precisar de um arquivo que não foi incluído, peça pelo caminho.\n' +
      'Para ALTERAR ou CRIAR arquivos, escreva o arquivo COMPLETO em um bloco de código com o caminho no cabeçalho, assim:\n```js path=src/exemplo.js\n…conteúdo completo…\n```\nO app mostra um botão para aplicar essas mudanças e baixar o ZIP atualizado.\n\n' +
      '# Estrutura\n' + tree(p) + '\n\n# Arquivos incluídos (' + sel.length + ')\n' +
      sel.map(f => '----- ' + f.path + ' -----\n' + (f.text.length > PER_FILE_CTX ? f.text.slice(0, PER_FILE_CTX) + '\n[… truncado: ' + f.text.length + ' caracteres no total]' : f.text)).join('\n\n');
    ctxMap.set(chat.id, ctx);
  }
  function contextFor(chat) { return chat && chat.project ? ctxMap.get(chat.id) || '' : ''; }

  /* ---------- edições propostas pela IA ---------- */
  function parseEdits(content) {
    const out = []; const re = /```([^\n`]*)\n([\s\S]*?)```/g; let m;
    while ((m = re.exec(content || ''))) {
      const pm = /path=["']?([^\s"'`]+)/.exec(m[1]); if (!pm) continue;
      const path = pm[1].replace(/^\.?\//, '');
      if (/\.\.(\/|$)/.test(path)) continue;
      out.push({ path, text: m[2].replace(/\n$/, '') + '\n' });
    }
    const map = new Map(); out.forEach(e => map.set(e.path, e)); return [...map.values()];
  }
  function editButton(content) {
    const n = parseEdits(content).length;
    return n ? '<button data-a="apply" class="apply">' + (currentChat() && currentChat().project ? 'Aplicar ' + n + ' arquivo' + (n > 1 ? 's' : '') + ' ao projeto' : 'Salvar ' + n + ' arquivo' + (n > 1 ? 's' : '') + ' em ZIP') + '</button>' : '';
  }
  function lineDiff(a, b) {
    const A = (a || '').split('\n'), B = b.split('\n'); const setA = new Map(); A.forEach(l => setA.set(l, (setA.get(l) || 0) + 1));
    let same = 0; B.forEach(l => { const c = setA.get(l); if (c) { same++; setA.set(l, c - 1); } });
    return { add: B.length - same, del: A.length - same };
  }
  async function applyEdits(content) {
    const edits = parseEdits(content); if (!edits.length) return;
    const chat = currentChat();
    let p = chat && chat.project ? await load(chat.project) : null;
    if (!p) {
      p = { id: 'p' + uid(), kind: 'project', name: 'arquivos-gerados-' + Media.stamp(), ts: Date.now(), zip: null, root: null, files: [], skipped: [], pins: [] };
      cache.set(p.id, p); if (chat) { chat.project = p.id; saveChats(); }
    }
    const rows = edits.map(e => {
      const cur = p.files.find(f => f.path === e.path);
      const d = lineDiff(cur && cur.text, e.text);
      return { e, cur, d };
    });
    openSheet('<h3>Aplicar mudanças</h3><p class="lead">Projeto ' + esc(p.name) + '. Uma cópia da versão anterior fica guardada para desfazer.</p><div class="card list">' +
      rows.map((r, i) => '<label class="row"><input type="checkbox" checked data-ei="' + i + '"><div class="grow"><div class="title mono">' + esc(r.e.path) + '</div><div class="sub">' + (r.cur ? (r.cur.bin ? 'substitui binário' : 'alterado') : 'novo arquivo') + ' · <span class="plus">+' + r.d.add + '</span> <span class="minus">−' + r.d.del + '</span> linhas</div></div></label>').join('') +
      '</div><div class="btn-row" style="margin-top:12px"><button class="btn primary" id="apGo">Aplicar</button><button class="btn" id="apGoDl">Aplicar e baixar ZIP</button></div>');
    const go = async (dl) => {
      const sel = $$('[data-ei]', $('#sheetBody')).filter(x => x.checked).map(x => rows[+x.dataset.ei]);
      for (const r of sel) {
        if (r.cur) { if (!r.cur.mod && !r.cur.added) r.cur.orig = r.cur.text != null ? r.cur.text : null; r.cur.text = r.e.text; r.cur.bin = false; r.cur.img = false; r.cur.mod = !r.cur.added; r.cur.size = r.e.text.length; }
        else p.files.push({ path: r.e.path, text: r.e.text, size: r.e.text.length, added: true });
      }
      p.files.sort((a, b) => a.path.localeCompare(b.path));
      await save(p); toast(sel.length + ' arquivo(s) aplicados'); renderBar();
      if (dl) await exportZip(p);
      closeSheet(); renderChat();
    };
    $('#apGo').onclick = () => go(false); $('#apGoDl').onclick = () => go(true);
  }
  async function exportZip(p) {
    const Z = await JSZip(); let zip;
    if (p.zip) zip = await Z.loadAsync(p.zip); else zip = new Z();
    const pre = p.root || '';
    for (const f of p.files) if ((f.mod || f.added) && f.text != null) zip.file(pre + f.path, f.text);
    for (const d of p.deleted || []) zip.remove(pre + d);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    Media.download(blob, p.name + (p.files.some(f => f.mod || f.added) ? '-editado' : '') + '.zip');
  }

  /* ---------- interface ---------- */
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0).replace('.', ',') + ' KB' : (n / 1048576).toFixed(1).replace('.', ',') + ' MB'; }
  async function renderBar() {
    const bar = $('#projBar'); if (!bar) return;
    const c = currentChat();
    const p = c && c.project ? await load(c.project) : null;
    if (!p) { bar.hidden = true; bar.innerHTML = ''; return; }
    const mods = p.files.filter(f => f.mod || f.added).length;
    bar.hidden = false;
    bar.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><button class="pb-open">' + esc(p.name) + ' <small>' + p.files.length + ' arquivos' + (mods ? ' · ' + mods + ' alterados' : '') + (p.pins.length ? ' · ' + p.pins.length + ' fixados' : '') + '</small></button><button class="pb-x" aria-label="Desconectar projeto">✕</button>';
    $('.pb-open', bar).onclick = () => openProject(p.id);
    $('.pb-x', bar).onclick = () => { c.project = null; ctxMap.delete(c.id); saveChats(); renderBar(); toast('Projeto desconectado desta conversa'); };
  }
  let filterQ = '';
  async function openProject(id, focusPath) {
    const p = await load(id); if (!p) { toast('Projeto não encontrado neste aparelho'); return; }
    if (focusPath) return openFile(p, focusPath);
    const tx = p.files.filter(f => f.text != null);
    const chars = tx.reduce((a, f) => a + f.text.length, 0);
    const mods = p.files.filter(f => f.mod || f.added).length;
    const listHtml = () => {
      const q = filterQ.toLowerCase();
      const fs = p.files.filter(f => !q || f.path.toLowerCase().includes(q) || (q.length > 2 && f.text && f.text.toLowerCase().includes(q))).slice(0, 400);
      return fs.map(f => {
        const depth = f.path.split('/').length - 1; const name = f.path.split('/').pop(); const dir = f.path.slice(0, f.path.length - name.length);
        return '<button class="frow" data-p="' + esc(f.path) + '"><span class="fname"><small>' + esc(dir) + '</small>' + esc(name) + '</span><span class="fmeta">' + (p.pins.includes(f.path) ? '<b class="pin">fixado</b>' : '') + (f.mod ? '<b class="mod">alterado</b>' : '') + (f.added ? '<b class="mod">novo</b>' : '') + (f.bin ? '<b>' + (f.img ? 'imagem' : f.pdf ? 'pdf' : 'binário') + '</b>' : '') + (f.office ? '<b>office</b>' : '') + fmtSize(f.size || (f.text || '').length) + '</span></button>';
      }).join('') + (p.files.length > 400 && !q ? '<p class="hint">Mostrando 400 de ' + p.files.length + '. Use a busca.</p>' : '') || '<p class="hint">Nada encontrado.</p>';
    };
    const c = currentChat();
    const linked = c && c.project === p.id;
    openSheet('<h3>' + esc(p.name) + '</h3><p class="lead">' + p.files.length + ' arquivos · ' + tx.length + ' com texto (' + (chars < 1000 ? chars + ' caracteres' : Math.round(chars / 1000) + 'k caracteres') + ')' + (p.skipped.length ? ' · ' + p.skipped.length + ' ignorados' : '') + (mods ? ' · ' + mods + ' alterados' : '') + '</p>' +
      '<div class="btn-row" style="margin-bottom:10px">' + (linked ? '' : '<button class="btn small primary" id="pjLink">Conectar a esta conversa</button>') + '<button class="btn small" id="pjNew">Nova conversa sobre ele</button><button class="btn small" id="pjSum">Resumir projeto</button><button class="btn small" id="pjZip">Baixar ZIP' + (mods ? ' editado' : '') + '</button></div>' +
      '<input class="input" id="pjQ" type="search" placeholder="Buscar por nome ou conteúdo" value="' + esc(filterQ) + '" style="margin-bottom:8px"><div class="card list flist" id="pjList">' + listHtml() + '</div>' +
      (p.skipped.length ? '<details class="hint" style="margin-top:8px"><summary>Ignorados (' + p.skipped.length + ')</summary>' + p.skipped.slice(0, 80).map(s => esc(s.path) + ' — ' + s.why).join('<br>') + '</details>' : '') +
      '<p class="hint">A cada pergunta, o app envia a estrutura e os arquivos mais relevantes (até ' + Math.round((S().projBudget || 60000) / 1000) + 'k caracteres). Fixe arquivos para incluí-los sempre. Cite o nome do arquivo na pergunta para priorizá-lo.</p>' +
      '<div class="field"><label>Limite de contexto do projeto</label><select class="input" id="pjBud">' + [[20000, '20k caracteres — modelos pequenos'], [60000, '60k — padrão'], [120000, '120k — modelos com contexto grande'], [300000, '300k — Gemini e similares']].map(o => '<option value="' + o[0] + '"' + ((S().projBudget || 60000) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<div class="btn-row"><button class="btn small danger" id="pjDel">Apagar projeto do aparelho</button></div>');
    const bindList = () => $$('.frow', $('#pjList')).forEach(b => b.onclick = () => openFile(p, b.dataset.p));
    bindList();
    $('#pjQ').oninput = (e) => { filterQ = e.target.value; $('#pjList').innerHTML = listHtml(); bindList(); };
    const lk = $('#pjLink'); if (lk) lk.onclick = () => { const ch = ensureChat(); ch.project = p.id; saveChats(); renderBar(); closeSheet(); showView('chat'); toast('Projeto conectado'); };
    $('#pjNew').onclick = () => { newChatWith(p); closeSheet(); };
    $('#pjSum').onclick = () => { const ch = currentChat() && currentChat().project === p.id ? currentChat() : newChatWith(p); closeSheet(); showView('chat'); send('Resuma este projeto: objetivo, tecnologias, estrutura de pastas, como rodar e pontos que merecem atenção (bugs, segurança, melhorias).'); };
    $('#pjZip').onclick = () => exportZip(p);
    $('#pjBud').onchange = (e) => { S().projBudget = +e.target.value; saveSettings(); };
    $('#pjDel').onclick = async () => { if (!confirm('Apagar o projeto ' + p.name + ' deste aparelho?')) return; await DB.del(p.id); cache.delete(p.id); state.chats.forEach(ch => { if (ch.project === p.id) ch.project = null; }); saveChats(); renderBar(); closeSheet(); };
  }
  function newChatWith(p) {
    const ch = { id: uid(), title: 'Projeto ' + p.name, messages: [], updated: Date.now(), project: p.id };
    state.chats.unshift(ch); state.current = ch.id; saveChats(); renderChatList(); renderChat(); renderBar(); showView('chat');
    return ch;
  }
  async function openFile(p, path) {
    const f = p.files.find(x => x.path === path); if (!f) return;
    const pinned = p.pins.includes(path);
    let body = '';
    if (f.text != null) {
      const lines = f.text.split('\n'); const shown = lines.slice(0, 3000);
      body = '<pre class="fview"><code>' + shown.map((l, i) => '<span class="ln">' + (i + 1) + '</span>' + esc(l)).join('\n') + '</code></pre>' + (lines.length > 3000 ? '<p class="hint">Mostrando 3.000 de ' + lines.length + ' linhas.</p>' : '');
    } else if (f.img && p.zip) {
      const Z = await JSZip(); const z = await Z.loadAsync(p.zip); const bl = await z.file(f.zpath).async('blob');
      f._blob = bl; body = '<img class="preview" src="' + URL.createObjectURL(bl) + '" alt="">';
    } else body = '<div class="warnbox">Arquivo binário — não enviado à IA.' + (f.pdf ? ' Para ler o PDF, use “Extrair texto”.' : '') + '</div>';
    openSheet('<h3 class="mono" style="font-size:15px;word-break:break-all">' + esc(path) + '</h3><p class="lead">' + fmtSize(f.size || (f.text || '').length) + (f.mod ? ' · alterado pela IA' : '') + (f.added ? ' · criado pela IA' : '') + '</p>' +
      '<div class="btn-row" style="margin-bottom:10px"><button class="btn small" id="fBack">Voltar</button>' +
      (f.text != null ? '<button class="btn small" id="fPin">' + (pinned ? 'Desafixar' : 'Fixar no contexto') + '</button><button class="btn small primary" id="fAsk">Perguntar sobre ele</button><button class="btn small" id="fCopy">Copiar</button>' : '') +
      (f.img ? '<button class="btn small primary" id="fImg">Anexar imagem ao chat</button>' : '') +
      (f.pdf && p.zip ? '<button class="btn small primary" id="fPdf">Extrair texto</button>' : '') +
      '<button class="btn small" id="fDl">Baixar</button>' + (f.orig !== undefined ? '<button class="btn small danger" id="fUndo">Desfazer alteração</button>' : '') + '</div>' + body);
    $('#fBack').onclick = () => openProject(p.id);
    const pin = $('#fPin'); if (pin) pin.onclick = async () => { if (pinned) p.pins = p.pins.filter(x => x !== path); else p.pins.push(path); await save(p); renderBar(); openFile(p, path); };
    const ask = $('#fAsk'); if (ask) ask.onclick = () => { const ch = ensureChat(); if (ch.project !== p.id) { ch.project = p.id; saveChats(); renderBar(); } closeSheet(); showView('chat'); const i = $('#input'); i.value = 'Sobre ' + path + ': '; autoGrow(); i.focus(); };
    const cp = $('#fCopy'); if (cp) cp.onclick = () => copyText(f.text);
    const im = $('#fImg'); if (im) im.onclick = () => { addImage(new File([f._blob], path.split('/').pop(), { type: f._blob.type || 'image/png' })); closeSheet(); showView('chat'); };
    const pd = $('#fPdf'); if (pd) pd.onclick = async () => {
      pd.disabled = true; pd.textContent = 'Lendo…';
      try {
        const Z = await JSZip(); const z = await Z.loadAsync(p.zip); const bl = await z.file(f.zpath).async('blob');
        const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs';
        const doc = await pdfjs.getDocument({ data: await bl.arrayBuffer() }).promise; let out = '';
        for (let i = 1; i <= Math.min(doc.numPages, 80); i++) { const tc = await (await doc.getPage(i)).getTextContent(); out += '\n[página ' + i + ']\n' + tc.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join(''); }
        f.text = out.trim(); f.bin = false; f.pdf = false; await save(p); openFile(p, path);
      } catch (e) { toast('Falha ao ler PDF: ' + e.message); pd.disabled = false; pd.textContent = 'Extrair texto'; }
    };
    $('#fDl').onclick = async () => {
      if (f.text != null && !f.office) { Media.download(new Blob([f.text], { type: 'text/plain' }), path.split('/').pop()); return; }
      if (p.zip && f.zpath) { const Z = await JSZip(); const z = await Z.loadAsync(p.zip); Media.download(await z.file(f.zpath).async('blob'), path.split('/').pop()); }
    };
    const un = $('#fUndo'); if (un) un.onclick = async () => {
      if (f.added) p.files = p.files.filter(x => x !== f); else { f.text = f.orig; delete f.orig; f.mod = false; if (f.text == null) f.bin = true; }
      await save(p); renderBar(); toast('Alteração desfeita'); openProject(p.id);
    };
  }
  async function openList() {
    const ps = (await DB.all()).filter(r => r.kind === 'project');
    if (!ps.length) { openSheet('<h3>Projetos salvos</h3><p class="lead">Nenhum projeto ainda. Anexe um arquivo .zip para começar.</p>'); return; }
    openSheet('<h3>Projetos salvos</h3><p class="lead">Ficam só neste aparelho.</p><div class="card list">' + ps.map(p => '<button class="row" data-pj="' + p.id + '"><div class="grow"><div class="title">' + esc(p.name) + '</div><div class="sub">' + p.files.length + ' arquivos · ' + new Date(p.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</div></div></button>').join('') + '</div>');
    $$('[data-pj]', $('#sheetBody')).forEach(b => b.onclick = () => openProject(b.dataset.pj));
  }

  /* ---------- ligações ---------- */
  const origRender = renderChat;
  // eslint-disable-next-line no-global-assign
  renderChat = function () { origRender(); renderBar(); };
  const cs = $('#chatSearch'); if (cs) cs.oninput = (e) => { state.chatQuery = e.target.value; renderChatList(); };

  window.Project = { handles, handle, prepare, contextFor, editButton, applyEdits, openProject, openList, exportZip, officeText, parseEdits, _load: load };
  renderBar();
})();
