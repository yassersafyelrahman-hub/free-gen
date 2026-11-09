/*
 * Art bot chat widget — one <script> tag, no dependencies.
 * Lives in a Shadow DOM so the store theme's CSS cannot break it (and it cannot break the theme).
 */
(function () {
  'use strict';
  if (window.__artBotLoaded) return;
  window.__artBotLoaded = true;

  var cs = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var API = cs && cs.src ? new URL(cs.src, location.href).origin : '';
  var SKEY = 'artbot.history.v1', LKEY = 'artbot.lang';

  function get(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function set(store, k, v) { try { window[store].setItem(k, v); } catch (e) {} }

  var T = {
    ar: {
      title: 'مساعد اللوحات', ai: 'ذكاء اصطناعي',
      hello: 'أهلًا بيك! أنا مساعد ذكاء اصطناعي في موقع الفنان {a}. قولّي مقاس الحيطة أو الألوان اللي بتحبها أو ميزانيتك، وأرشحلك أنسب الأعمال.',
      ph: 'اكتب سؤالك هنا…', send: 'إرسال', close: 'إغلاق', open: 'اسأل مساعد اللوحات',
      note: 'مساعد آلي وممكن يغلط، فراجع التفاصيل في صفحة العمل. ما تكتبش بيانات شخصية.',
      view: 'عرض', soldout: 'نفدت', was: 'بدل',
      chips: ['عايز لوحة بمقاس معين', 'بحب الفن الفرعوني', 'ميزانيتي محدودة', 'هدية لحد عزيز'],
      'err.RATE': 'بعتّ رسائل كتير. جرّب بعد شوية.',
      'err.DAILY_CAP': 'المساعد وصل للحد اليومي. جرّب بكرة أو تصفّح الأعمال بنفسك.',
      'err.BOT_DISABLED': 'المساعد غير متاح حاليًا.',
      'err.CATALOG_UNAVAILABLE': 'بحمّل قايمة الأعمال. جرّب تاني بعد لحظات.',
      'err.AI_QUOTA': 'المساعد مشغول دلوقتي. جرّب بعد دقيقة.',
      'err.AI_TIMEOUT': 'الرد أخد وقت طويل. جرّب تاني.',
      'err.GENERIC': 'حصل خطأ. جرّب تاني.'
    },
    en: {
      title: 'Art assistant', ai: 'AI',
      hello: 'Hi! I\'m an AI assistant on {a}\'s website. Tell me your wall size, the colors you like or your budget, and I\'ll suggest the best-fitting artworks.',
      ph: 'Type your question…', send: 'Send', close: 'Close', open: 'Ask the art assistant',
      note: 'Automated assistant, it can make mistakes, so check details on the product page. Please don\'t share personal data.',
      view: 'View', soldout: 'Sold out', was: 'was',
      chips: ['I need a specific size', 'I love Pharaonic art', 'I have a small budget', 'A gift for someone'],
      'err.RATE': 'You\'ve sent a lot of messages. Please try again later.',
      'err.DAILY_CAP': 'The assistant reached its daily limit. Try again tomorrow or browse the artworks yourself.',
      'err.BOT_DISABLED': 'The assistant is unavailable right now.',
      'err.CATALOG_UNAVAILABLE': 'Loading the artwork list. Please try again in a moment.',
      'err.AI_QUOTA': 'The assistant is busy right now. Try again in a minute.',
      'err.AI_TIMEOUT': 'That took too long. Please try again.',
      'err.GENERIC': 'Something went wrong. Please try again.'
    }
  };

  var lang = get('localStorage', LKEY);
  if (lang !== 'ar' && lang !== 'en') {
    lang = ((document.documentElement.lang || navigator.language || '') + '').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en';
  }
  var artist = '';
  var msgs = [];
  try { msgs = JSON.parse(get('sessionStorage', SKEY) || '[]'); if (!Array.isArray(msgs)) msgs = []; } catch (e) { msgs = []; }
  var busy = false;

  function t(k) { return (T[lang][k] != null ? T[lang][k] : T.en[k]); }
  function errText(code) { var k = 'err.' + code; return T[lang][k] || T[lang]['err.GENERIC']; }

  /* ---------- DOM ---------- */
  var host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;right:16px;bottom:16px;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif}' +
    '.fab{width:58px;height:58px;border-radius:50%;border:0;background:#d9a441;color:#1a1204;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.35)}' +
    '.fab:focus-visible,button:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid #f0c46a;outline-offset:2px}' +
    '.panel{display:none;flex-direction:column;position:fixed;right:16px;bottom:88px;width:380px;max-width:calc(100vw - 24px);height:min(600px,calc(100vh - 110px));background:#15110c;color:#f3ead9;border:1px solid #33291c;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
    '.panel.open{display:flex}' +
    '.head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#1d1812;border-bottom:1px solid #33291c}' +
    '.head b{flex:1;font-size:15px;color:#f0c46a}.badge{font-size:11px;border:1px solid #6b5522;color:#f0c46a;border-radius:999px;padding:1px 8px}' +
    '.hbtn{background:none;border:1px solid #33291c;color:#f3ead9;border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}' +
    '.x{border:0;font-size:20px;line-height:1;padding:2px 8px}' +
    '.list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}' +
    '.list>*{flex-shrink:0}' +
    '.m{max-width:88%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.m.u{align-self:flex-end;background:#d9a441;color:#1a1204;border-end-end-radius:4px}' +
    '.m.b{align-self:flex-start;background:#241d14;border:1px solid #33291c;border-end-start-radius:4px}' +
    '.m.e{align-self:flex-start;background:#3a1a16;color:#ffb3a8;border:1px solid #6b2a22}' +
    '.cards{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 8px;align-self:stretch;scroll-snap-type:x proximity}' +
    '.card{flex:0 0 160px;scroll-snap-align:start;background:#1d1812;border:1px solid #33291c;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;display:flex;flex-direction:column}' +
    '.card img{width:100%;aspect-ratio:1/1;object-fit:cover;background:#000;display:block}' +
    '.card .c{padding:8px 9px;display:flex;flex-direction:column;gap:3px;flex:1}' +
    '.card .t{font-size:12.5px;line-height:1.35;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
    '.card .p{font-size:13px;color:#f0c46a;font-weight:700}.card .p s{color:#a89a82;font-weight:400;font-size:11.5px;margin-inline-start:4px}' +
    '.card .d{font-size:11.5px;color:#a89a82}.card .so{font-size:11.5px;color:#ffb3a8}' +
    '.card .go{margin-top:auto;font-size:12px;color:#1a1204;background:#d9a441;border-radius:8px;text-align:center;padding:5px;font-weight:700}' +
    '.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{background:#1d1812;border:1px solid #4a3a20;color:#f3ead9;border-radius:999px;padding:6px 12px;font-size:12.5px;cursor:pointer}' +
    '.dots{align-self:flex-start;display:flex;gap:4px;padding:10px 12px;background:#241d14;border:1px solid #33291c;border-radius:14px}' +
    '.dots i{width:6px;height:6px;border-radius:50%;background:#a89a82;animation:b 1.2s infinite}.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}' +
    '@keyframes b{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}' +
    '.note{font-size:11px;color:#a89a82;padding:0 14px 6px;line-height:1.4}' +
    '.row{display:flex;gap:8px;padding:10px 12px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #33291c;background:#1d1812}' +
    'textarea{flex:1;resize:none;max-height:96px;min-height:40px;background:#120f0b;color:#f3ead9;border:1px solid #33291c;border-radius:10px;padding:9px 10px;font-size:16px;line-height:1.4}' +
    '.send{flex:none;background:#d9a441;color:#1a1204;border:0;border-radius:10px;padding:0 16px;font-weight:700;font-size:14px;cursor:pointer}.send:disabled{opacity:.5;cursor:wait}' +
    '@media(max-width:520px){.panel{right:8px;left:8px;bottom:84px;width:auto;max-width:none;height:min(78vh,640px)}}' +
    '@media(prefers-reduced-motion:reduce){.list{scroll-behavior:auto}.dots i{animation:none;opacity:.7}}' +
    '</style>' +
    '<button class="fab" id="fab" type="button"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>' +
    '<section class="panel" id="panel" role="dialog" aria-modal="false">' +
    '<div class="head"><b id="title"></b><span class="badge" id="badge"></span><button class="hbtn" id="lang" type="button"></button><button class="hbtn x" id="close" type="button">×</button></div>' +
    '<div class="list" id="list" aria-live="polite"></div>' +
    '<div class="note" id="note"></div>' +
    '<form class="row" id="form"><textarea id="input" rows="1" maxlength="600"></textarea><button class="send" id="send" type="submit"></button></form>' +
    '</section>';
  document.body.appendChild(host);

  var $ = function (id) { return root.getElementById(id); };
  var panel = $('panel'), list = $('list'), input = $('input'), sendBtn = $('send');

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function cardEl(p) {
    var a = el('a', 'card');
    if (typeof p.url === 'string' && /^https?:\/\//.test(p.url)) a.href = p.url;
    if (p.image && /^https?:\/\//.test(p.image)) { var im = el('img'); im.src = p.image; im.alt = p.title; im.loading = 'lazy'; a.appendChild(im); }
    var c = el('div', 'c');
    c.appendChild(el('div', 't', p.title));
    var pr = el('div', 'p', p.price);
    if (p.was) pr.appendChild(el('s', '', p.was));
    c.appendChild(pr);
    if (p.dims) c.appendChild(el('div', 'd', p.dims));
    if (!p.available) c.appendChild(el('div', 'so', t('soldout')));
    c.appendChild(el('div', 'go', t('view')));
    a.appendChild(c);
    return a;
  }

  function render() {
    root.host.dir = lang === 'ar' ? 'rtl' : 'ltr';
    panel.dir = lang === 'ar' ? 'rtl' : 'ltr';
    $('title').textContent = t('title');
    $('badge').textContent = t('ai');
    $('lang').textContent = lang === 'ar' ? 'EN' : 'عربي';
    $('close').setAttribute('aria-label', t('close'));
    $('fab').setAttribute('aria-label', t('open'));
    $('note').textContent = t('note');
    input.placeholder = t('ph');
    sendBtn.textContent = t('send');
    list.textContent = '';
    list.appendChild(el('div', 'm b', t('hello').replace('{a}', artist || '')));
    if (!msgs.length) {
      var chips = el('div', 'chips');
      t('chips').forEach(function (c) {
        var b = el('button', 'chip', c); b.type = 'button';
        b.addEventListener('click', function () { send(c); });
        chips.appendChild(b);
      });
      list.appendChild(chips);
    }
    msgs.forEach(function (m) {
      if (m.err) { list.appendChild(el('div', 'm e', errText(m.err))); return; }
      var bub = el('div', 'm ' + (m.role === 'user' ? 'u' : 'b'), m.content);
      bub.dir = 'auto';
      list.appendChild(bub);
      if (m.products && m.products.length) {
        var wrap = el('div', 'cards');
        m.products.forEach(function (p) { wrap.appendChild(cardEl(p)); });
        list.appendChild(wrap);
      }
    });
    if (busy) { var d = el('div', 'dots'); d.appendChild(el('i')); d.appendChild(el('i')); d.appendChild(el('i')); list.appendChild(d); }
    list.scrollTop = list.scrollHeight;
  }
  function persist() { set('sessionStorage', SKEY, JSON.stringify(msgs.slice(-30))); }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    msgs.push({ role: 'user', content: text });
    busy = true; sendBtn.disabled = true; input.value = ''; autosize(); render(); persist();
    try {
      var history = msgs.filter(function (m) { return !m.err; }).slice(-10).map(function (m) { return { role: m.role, content: m.content }; });
      var r = await fetch(API + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, lang: lang }) });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw { code: data.error || 'GENERIC' };
      msgs.push({ role: 'assistant', content: data.reply || '', products: data.products || [] });
    } catch (e) {
      msgs.push({ role: 'assistant', content: '', err: (e && e.code) || 'GENERIC' });
    } finally {
      busy = false; sendBtn.disabled = false; render(); persist();
      if (panel.classList.contains('open')) input.focus();
    }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 96) + 'px'; }
  function toggle(open) {
    panel.classList.toggle('open', open);
    if (open) { render(); input.focus(); }
  }

  $('fab').addEventListener('click', function () { toggle(!panel.classList.contains('open')); });
  $('close').addEventListener('click', function () { toggle(false); $('fab').focus(); });
  $('lang').addEventListener('click', function () { lang = lang === 'ar' ? 'en' : 'ar'; set('localStorage', LKEY, lang); render(); });
  $('form').addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { toggle(false); $('fab').focus(); } });

  render();
  fetch(API + '/api/config').then(function (r) { return r.json(); }).then(function (c) { artist = c.artistName || ''; render(); }).catch(function () {});
})();
