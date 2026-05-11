(function () {
  var C = typeof window !== 'undefined' ? window.FF_CHATBOT_CONFIG : null;
  if (!C || typeof C !== 'object') {
    console.error('[storefront-chatbot] Set window.FF_CHATBOT_CONFIG before loading widget.js (see client/zoho-embed-hosted.html)');
    return;
  }
  function _req(key, def) {
    var v = C[key];
    if (v == null || v === '') return def != null ? def : '';
    return String(v);
  }

  var CHAT_BACKEND_URL = _req('CHAT_BACKEND_URL');
  var WIDGET_SECRET = _req('WIDGET_SECRET', '');
  var STORE_NAME = _req('STORE_NAME', 'Your Store');
  var STORE_BASE = _req('STORE_BASE');
  var STORE_DOMAIN = _req('STORE_DOMAIN');
  var STORE_VERTICALS = _req('STORE_VERTICALS', 'general retail');
  var STORE_POLICIES = _req('STORE_POLICIES', 'See the store website for policies.');
  var ZOHO_API = C.ZOHO_API;
  if (!ZOHO_API) {
    try { ZOHO_API = new URL(STORE_BASE).origin + '/storefront/api/v1'; }
    catch (e) { ZOHO_API = 'https://commerce.zoho.com/storefront/api/v1'; }
  } else {
    ZOHO_API = String(ZOHO_API);
  }

  if (!CHAT_BACKEND_URL || !STORE_BASE || !STORE_DOMAIN) {
    console.error('[storefront-chatbot] FF_CHATBOT_CONFIG must include CHAT_BACKEND_URL, STORE_BASE, STORE_DOMAIN');
    return;
  }

  var root = document.createElement('div');
  root.id  = 'ff-chatbot';
  root.innerHTML =
    '<div id="ff-toast"></div>' +
    '<div id="ff-panel">' +
      '<div class="ff-hdr">' +
        '<div class="ff-logo">&#128249;</div>' +
        '<div class="ff-hinfo">' +
          '<div class="ff-hname">' + STORE_NAME + '</div>' +
          '<div class="ff-hstat">Shopping Assistant</div>' +
        '</div>' +
        '<button class="ff-hcart" onclick="ffShowCart()">&#128722; <span id="ff-cbadge"></span></button>' +
        '<button class="ff-hclose" onclick="ffToggle()">&#10005;</button>' +
      '</div>' +
      '<div id="ff-msgs"></div>' +
      '<div class="ff-bar">' +
        '<textarea class="ff-inp" id="ff-inp" rows="1" placeholder="Search, browse categories, or ask a question&hellip;"' +
          ' onkeydown="ffOnKey(event)" oninput="ffResize(this)"></textarea>' +
        '<button class="ff-send" onclick="ffSend()">' +
          '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>' +
    '<button id="ff-fab" onclick="ffToggle()" title="Chat with us">' +
      '&#128249;<span id="ff-fab-badge"></span>' +
    '</button>';
  document.body.appendChild(root);

  var cartId       = localStorage.getItem('ff_cart') || null;
  var Q = {}, V = {}, cache = {}, history = [];
  var isOpen = false;
  var LIST_PRODUCTS_CAP = 30;

  window.ffToggle = function () {
    isOpen = !isOpen;
    document.getElementById('ff-panel').classList.toggle('open', isOpen);
  };

  async function zohoFetch(path, opts) {
    opts = opts || {};
    var headers = { 'domain-name': STORE_DOMAIN, 'Content-Type': 'application/json' };
    if (cartId) headers['Cookie'] = 'zcid=' + cartId;
    var r = await fetch(ZOHO_API + path, {
      method: opts.method || 'GET', headers: headers,
      body: opts.body || undefined, credentials: 'include'
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function searchProducts(q) {
    var d = await zohoFetch('/search-products?q=' + encodeURIComponent(q));
    return (d && d.payload && d.payload.products) || [];
  }

  async function addToCart(variantId, qty) {
    var d = await zohoFetch('/cart', {
      method: 'POST',
      body: JSON.stringify({ product_variant_id: String(variantId), quantity: String(qty) })
    });
    if (d && d.payload && d.payload.cart_id) {
      cartId = d.payload.cart_id;
      localStorage.setItem('ff_cart', cartId);
    }
    if (d && d.payload && typeof d.payload.count === 'number') updateBadge(d.payload.count);
    return d;
  }

  async function getCart() {
    if (!cartId) return null;
    var d = await zohoFetch('/cart?cart_id=' + cartId);
    if (d && d.payload && typeof d.payload.count === 'number') updateBadge(d.payload.count);
    return (d && d.payload) || null;
  }

  async function askClaude(text) {
    history.push({ role: 'user', content: text });
    var base = String(CHAT_BACKEND_URL || '').replace(/\/$/, '');
    if (!base) throw new Error('CHAT_BACKEND_URL is not set');
    var headers = { 'Content-Type': 'application/json' };
    if (WIDGET_SECRET) headers['X-Widget-Secret'] = WIDGET_SECRET;
    var res = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        messages: history,
        context: {
          storeName: STORE_NAME,
          storeBase: STORE_BASE,
          verticals: STORE_VERTICALS,
          policies: STORE_POLICIES,
          productsContext: buildCtx()
        }
      })
    });
    var raw = await res.text();
    var d = {};
    try { d = JSON.parse(raw); } catch (e) {}
    if (!res.ok) throw new Error((d && d.error) || ('Chat API ' + res.status));
    var reply = (d && d.reply) || "I'm not sure — try browsing the store!";
    history.push({ role: 'assistant', content: reply });
    if (history.length > 20) history.splice(0, 2);
    return reply;
  }

  function buildCtx() {
    var prods = Object.values(cache);
    if (!prods.length) return 'None yet.';
    return prods.map(function (p) {
      var price = getPrice(p), orig = getOrig(p);
      var opts = {};
      (p.variants || []).forEach(function (v) {
        (v.options || []).forEach(function (o) {
          if (!opts[o.name]) opts[o.name] = [];
          if (opts[o.name].indexOf(o.value) < 0) opts[o.name].push(o.value);
        });
      });
      var os = Object.keys(opts).map(function (k) { return k + ': ' + opts[k].join(', '); }).join(' | ');
      var d  = (p.short_description || '').replace(/<[^>]*>/g, '').trim();
      return '- ' + p.name + ' Rs.' + price + (orig > price ? ' (was Rs.' + orig + ')' : '') + (os ? ' | ' + os : '') + (d ? ' | ' + d : '');
    }).join('\n');
  }

  function intent(text) {
    var l = text.toLowerCase().trim();
    if (/^(hi|hello|hey|namaste|sup|yo)\b/.test(l)) return 'greeting';
    if (/\b(cart|bag|my order|checkout)\b/.test(l)) return 'cart';

    var wantsCats =
      /\b(categor(y|ies)|department(s)?)\b/.test(l) &&
      /\b(list|show|browse|view|see|display|what|all|every|print|give)\b/.test(l);
    var wantsCols =
      /\b(collection(s)?|lookbook|curated)\b/.test(l) &&
      /\b(list|show|browse|view|see|display|what|all|every|print|give)\b/.test(l);
    if (wantsCols && !wantsCats) return 'collections';
    if (wantsCats && !wantsCols) return 'categories';
    if (wantsCats && wantsCols) return 'categories'; // default to categories; user can ask again for collections

    if (
      /\b(list|show|browse|view)\s+all\s+(products|items)\b/.test(l) ||
      /\b(all|full|entire)\s+(product\s+)?(catalog(ue)?|inventory|range)\b/.test(l) ||
      /\bbrowse\s+all\s+products\b/.test(l)
    ) return 'all_products';

    if (/[?]|^(what|how|does|do|is|are|can|tell|which|why|where|when|explain|describe|material|fabric|care|wash|return|ship|deliver|discount|coupon|price|cost|fit|style|recommend|warranty|assembly|voltage|size|dimension)/i.test(text)) return 'question';
    return text.trim().split(/\s+/).length > 4 ? 'question' : 'search';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function getImg(p)   { var u=(p.images||[])[0] && (p.images||[])[0].url; return u ? STORE_BASE+u+'/600x600' : ''; }
  function getPrice(p) { var v=(p.variants||[])[0]||{}; return v.selling_price||p.selling_price||0; }
  function getOrig(p)  { var v=(p.variants||[])[0]||{}; return v.label_price||p.label_price||0; }
  function getVid(p)   { var v=(p.variants||[])[0]||{}; return v.variant_id||v.id||''; }
  function isOOS(p)    { return p.is_out_of_stock||((p.variants||[])[0]||{}).is_out_of_stock; }

  function updateBadge(n) {
    ['ff-cbadge','ff-fab-badge'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.textContent = n; el.classList.toggle('on', n > 0); }
    });
  }

  function walkCategories(nodes, depth, out) {
    (nodes || []).forEach(function (n) {
      if (n.visibility === false) return;
      out.push({ name: n.name, url: n.url || '', depth: depth });
      walkCategories(n.sub_categories, depth + 1, out);
    });
  }

  function categoryListHtml(rows) {
    return rows.map(function (r) {
      var pad = new Array(r.depth * 3 + 1).join('&nbsp;');
      var href = r.url ? STORE_BASE + r.url : STORE_BASE;
      return pad + '&#8226; <a href="' + esc(href) + '" target="_blank" rel="noopener" style="color:var(--ff-a);font-weight:600">' + esc(r.name) + '</a>';
    }).join('<br>');
  }

  async function showCategoriesInChat() {
    addTyping();
    try {
      var d = await zohoFetch('/categories');
      rmTyping();
      var cats = (d && d.payload && d.payload.categories) || [];
      var flat = [];
      walkCategories(cats, 0, flat);
      if (!flat.length) {
        addRow('bot', 'No categories are available from the store right now.');
        chips(['List all collections', 'Browse all products', 'View cart']);
        return;
      }
      addRow('bot', '<strong>Categories</strong> (tap a link to open on the store):<br><br>' + categoryListHtml(flat));
      chips(['List all collections', 'Browse all products', 'View cart', 'Search in chat']);
    } catch (e) {
      rmTyping();
      addRow('bot', 'Could not load categories. Please try again.');
    }
  }

  async function showCollectionsInChat() {
    addTyping();
    try {
      var d = await zohoFetch('/collections');
      rmTyping();
      var cols = (d && d.payload && d.payload.collections) || [];
      if (!cols.length) {
        addRow('bot', 'No collections are published on the store right now.');
        chips(['List all categories', 'Browse all products', 'View cart']);
        return;
      }
      var lines = cols.map(function (c) {
        var id = String(c.id || '').replace(/'/g, '');
        var label = esc(c.name || 'Collection');
        return '&#8226; <button type="button" class="ff-chip" style="margin:2px 0" onclick="ffLoadCollection(\'' + esc(id) + '\')">' + label + '</button>';
      }).join('<br>');
      addRow('bot', '<strong>Collections</strong> — tap a collection to load its products here:<br><br>' + lines);
      chips(['List all categories', 'Browse all products', 'View cart']);
    } catch (e) {
      rmTyping();
      addRow('bot', 'Could not load collections. Please try again.');
    }
  }

  window.ffLoadCollection = async function (collectionId) {
    if (!collectionId) return;
    addTyping();
    try {
      var d = await zohoFetch('/collections/' + encodeURIComponent(collectionId));
      rmTyping();
      var col = (d && d.payload && d.payload.collection) || {};
      var prods = col.products || [];
      if (!prods.length) {
        addRow('bot', 'This collection has no products to show, or they are not loaded in this view. Open the store page for full results.');
        chips(['List all categories', 'Browse all products', 'View cart']);
        return;
      }
      prods.forEach(function (p) { cache[p.product_id] = p; });
      addRow('bot', 'Collection <strong>' + esc(col.name || 'Selected') + '</strong> — tap a tile for details:');
      addTiles(prods.slice(0, LIST_PRODUCTS_CAP));
      chips(['Ask about these products', 'List all collections', 'View cart']);
    } catch (e) {
      rmTyping();
      addRow('bot', 'Could not load that collection. Try again from the list.');
    }
  };

  async function showAllProductsInChat() {
    addTyping();
    try {
      var prods = await searchProducts('');
      rmTyping();
      if (!prods.length) {
        addRow('bot', 'No products returned for a broad browse. Try searching for something specific.');
        chips(['List all categories', 'List all collections', 'View cart']);
        return;
      }
      var slice = prods.slice(0, LIST_PRODUCTS_CAP);
      slice.forEach(function (p) { cache[p.product_id] = p; });
      addRow('bot', 'Showing up to <strong>' + slice.length + '</strong> products from the catalog (first page). Tap a tile for details:');
      addTiles(slice);
      chips(['Ask about these products', 'List all categories', 'List all collections', 'View cart']);
    } catch (e) {
      rmTyping();
      addRow('bot', 'Could not load products. Please try again.');
    }
  }

  var msgs = document.getElementById('ff-msgs');

  function addRow(role, html) {
    var w = document.createElement('div'); w.className = 'ff-row ' + role;
    w.innerHTML = role === 'bot'
      ? '<div class="ff-av">&#10022;</div><div class="ff-bbl">' + html + '</div>'
      : '<div class="ff-bbl">' + esc(html) + '</div>';
    msgs.appendChild(w); msgs.scrollTop = msgs.scrollHeight;
  }
  function addTyping() {
    var w = document.createElement('div'); w.className = 'ff-row bot'; w.id = 'ff-typ';
    w.innerHTML = '<div class="ff-av">&#10022;</div><div class="ff-bbl"><div class="ff-typing"><span></span><span></span><span></span></div></div>';
    msgs.appendChild(w); msgs.scrollTop = msgs.scrollHeight;
  }
  function rmTyping() { var t = document.getElementById('ff-typ'); if (t) t.remove(); }
  function chips(opts) {
    addRow('bot', '<div class="ff-chips">' + opts.map(function (o) {
      return '<button class="ff-chip" onclick="ffChip(\'' + esc(o) + '\')">' + esc(o) + '</button>';
    }).join('') + '</div>');
  }
  function toast(msg, ok) {
    if (ok === undefined) ok = true;
    var t = document.getElementById('ff-toast');
    t.style.background = ok ? '#162816' : '#2e1616';
    t.style.borderColor = ok ? '#2d5a2d' : '#5a2d2d';
    t.style.color = ok ? '#6dbf6d' : '#e07070';
    t.textContent = msg; t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  function addTiles(prods) {
    prods.forEach(function (p) { cache[p.product_id] = p; });
    var w = document.createElement('div'); w.className = 'ff-row bot'; w.style.maxWidth = '100%';
    w.innerHTML = '<div class="ff-av">&#10022;</div><div class="ff-bbl" style="padding:7px 9px;width:100%"><div class="ff-tscroll">' + prods.map(tileHtml).join('') + '</div></div>';
    msgs.appendChild(w); msgs.scrollTop = msgs.scrollHeight;
  }

  function tileHtml(p) {
    var pid = p.product_id, img = getImg(p);
    var price = getPrice(p), orig = getOrig(p), oos = isOOS(p), vid = getVid(p);
    var disc = (orig > price && orig > 0) ? Math.round((1 - price / orig) * 100) : 0;
    Q[pid] = Q[pid] || 1; V[pid] = V[pid] || vid;
    return '<div class="ff-tile" id="fft-' + pid + '" onclick="ffExpand(\'' + pid + '\')">'
      + (img ? '<img class="ff-timg" src="' + img + '" alt="' + esc(p.name) + '" loading="lazy" onerror="this.outerHTML=\'<div class=\\\'ff-tph\\\'>&#128249;</div>\'">'
             : '<div class="ff-tph">&#128249;</div>')
      + '<div class="ff-tbody">'
      +   '<div class="ff-tname">' + esc(p.name) + '</div>'
      +   '<div class="ff-tpr">'
      +     '<span class="ff-tprice">&#8377;' + price.toLocaleString('en-IN') + '</span>'
      +     (orig > price ? '<span class="ff-torig">&#8377;' + orig.toLocaleString('en-IN') + '</span>' : '')
      +     (disc >= 5    ? '<span class="ff-tbdg">' + disc + '% OFF</span>' : '')
      +   '</div>'
      +   (oos ? '<div class="ff-toos">Out of stock</div>' : '')
      +   '<div class="ff-tatc"><button id="fft-atc-' + pid + '" ' + (oos ? 'disabled' : '')
      +     ' onclick="event.stopPropagation();ffTileATC(\'' + pid + '\',\'' + vid + '\')">'
      +     (oos ? 'SOLD OUT' : 'ADD TO CART') + '</button></div>'
      + '</div></div>';
  }

  window.ffTileATC = async function (pid, vid) {
    if (!vid) { toast('No variant available', false); return; }
    var btn = document.getElementById('fft-atc-' + pid);
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      var r = await addToCart(vid, Q[pid] || 1);
      if (r && (r.status_code === '0' || r.status_code === 0)) {
        toast('Added to cart!');
        if (btn) { btn.textContent = 'ADDED'; setTimeout(function () { btn.disabled = false; btn.textContent = 'ADD TO CART'; }, 2200); }
      } else { toast('Could not add', false); if (btn) { btn.disabled = false; btn.textContent = 'ADD TO CART'; } }
    } catch (e) { toast('Network error', false); if (btn) { btn.disabled = false; btn.textContent = 'ADD TO CART'; } }
  };

  window.ffExpand = function (pid) {
    var p = cache[pid]; if (!p) return;
    var vs = p.variants || [], dv = vs[0] || {};
    V[pid] = dv.variant_id || dv.id || ''; Q[pid] = 1;
    var img = getImg(p), price = getPrice(p), orig = getOrig(p);
    var desc = (p.short_description || '').replace(/<[^>]*>/g, '').trim();
    var url  = STORE_BASE + '/products/' + (p.seo_url || pid);
    var om = {};
    vs.forEach(function (v) {
      (v.options || []).forEach(function (o) {
        if (!om[o.name]) om[o.name] = [];
        if (om[o.name].indexOf(o.value) < 0) om[o.name].push(o.value);
      });
    });
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(vs))));
    var oHtml = Object.keys(om).map(function (name) {
      return '<div class="ff-vgrp"><div class="ff-vlbl">' + esc(name) + '</div><div class="ff-vrow">'
        + om[name].map(function (v, i) {
            return '<button class="ff-vchip' + (i === 0 ? ' sel' : '') + '" data-opt="' + esc(name) + '" data-val="' + esc(v) + '"'
              + ' onclick="ffPickV(this,\'' + pid + '\',\'' + b64 + '\')">' + esc(v) + '</button>';
          }).join('') + '</div></div>';
    }).join('');
    addRow('bot',
      '<div class="ff-pcard">'
      + (img ? '<img class="ff-pcimg" src="' + img + '" alt="' + esc(p.name) + '" onerror="this.outerHTML=\'<div class=\\\'ff-pcph\\\'>&#128249;</div>\'">'
             : '<div class="ff-pcph">&#128249;</div>')
      + '<div class="ff-pcbody">'
      + '<div class="ff-pcname">' + esc(p.name) + '</div>'
      + '<div class="ff-pcprice">&#8377;' + price.toLocaleString('en-IN')
      + (orig > price ? ' <span style="text-decoration:line-through;color:var(--ff-di);font-size:11px;margin-left:4px">&#8377;' + orig.toLocaleString('en-IN') + '</span>' : '')
      + '</div>'
      + (desc ? '<div class="ff-pcdesc">' + esc(desc) + '</div>' : '')
      + oHtml
      + '<div class="ff-atcrow">'
      + '<button class="ff-qb" onclick="ffChQ(\'' + pid + '\',-1)">&#8722;</button>'
      + '<span class="ff-qn" id="ff-qn-' + pid + '">1</span>'
      + '<button class="ff-qb" onclick="ffChQ(\'' + pid + '\',1)">+</button>'
      + '<button class="ff-atcbtn" id="ff-catc-' + pid + '" onclick="ffCardATC(\'' + pid + '\')">ADD TO CART</button>'
      + '<a class="ff-vbtn" href="' + url + '" target="_blank" rel="noopener">&#8599;</a>'
      + '</div></div></div>'
    );
  };

  window.ffPickV = function (btn, pid, b64) {
    btn.closest('.ff-vrow').querySelectorAll('.ff-vchip').forEach(function (c) { c.classList.remove('sel'); });
    btn.classList.add('sel');
    var sels = {};
    btn.closest('.ff-pcbody').querySelectorAll('.ff-vchip.sel').forEach(function (c) { sels[c.dataset.opt] = c.dataset.val; });
    try {
      var vs = JSON.parse(decodeURIComponent(escape(atob(b64))));
      var m  = vs.find(function (v) { return (v.options || []).every(function (o) { return sels[o.name] === o.value; }); });
      if (m) V[pid] = m.variant_id || m.id;
    } catch (e) {}
  };

  window.ffChQ = function (pid, d) {
    Q[pid] = Math.max(1, (Q[pid] || 1) + d);
    var el = document.getElementById('ff-qn-' + pid);
    if (el) el.textContent = Q[pid];
  };

  window.ffCardATC = async function (pid) {
    var vid = V[pid];
    if (!vid) { toast('Select a size/color first', false); return; }
    var btn = document.getElementById('ff-catc-' + pid);
    if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
    try {
      var r = await addToCart(vid, Q[pid] || 1);
      if (r && (r.status_code === '0' || r.status_code === 0)) {
        toast('Added ' + (Q[pid] || 1) + 'x to cart!');
        if (btn) { btn.textContent = 'ADDED'; setTimeout(function () { btn.disabled = false; btn.textContent = 'ADD TO CART'; }, 2500); }
      } else { toast('Could not add', false); if (btn) { btn.disabled = false; btn.textContent = 'ADD TO CART'; } }
    } catch (e) { toast('Network error', false); if (btn) { btn.disabled = false; btn.textContent = 'ADD TO CART'; } }
  };

  window.ffShowCart = async function () {
    addTyping();
    try {
      var cart = await getCart(); rmTyping();
      if (!cart || !cart.items || !cart.items.length) {
        addRow('bot', 'Your cart is empty. What would you like to shop for?');
        return;
      }
      var lines = cart.items.map(function (i) {
        return '- <strong>' + esc(i.name || 'Item') + '</strong> x' + i.quantity
          + ' - Rs.' + ((i.approximate_total || 0).toLocaleString('en-IN'));
      }).join('<br>');
      var href = cartId ? STORE_BASE + '/checkout?checkout_id=' + cartId : STORE_BASE + '/checkout';
      addRow('bot',
        'Your Cart (' + cart.count + ' item' + (cart.count !== 1 ? 's' : '') + ')<br><br>'
        + lines + '<br><br>'
        + '<strong>Subtotal: Rs.' + (cart.sub_total || 0).toLocaleString('en-IN') + '</strong><br><br>'
        + '<a href="' + href + '" target="_blank" rel="noopener" style="color:var(--ff-a);font-weight:600">Proceed to Checkout</a>'
      );
    } catch (e) { rmTyping(); addRow('bot', 'Could not load cart. Please try again.'); }
  };

  async function handleMsg(text) {
    var it = intent(text);
    if (it === 'greeting') {
      addRow('bot', 'Hey! Welcome to <strong>' + STORE_NAME + '</strong>. Search, browse categories and collections, or ask a question.');
      chips(['List all categories', 'List all collections', 'Browse all products', 'Office chair', 'LED TV', 'Sofa', 'Kurti']);
      return;
    }
    if (it === 'cart') { await ffShowCart(); return; }
    if (it === 'categories') { await showCategoriesInChat(); return; }
    if (it === 'collections') { await showCollectionsInChat(); return; }
    if (it === 'all_products') { await showAllProductsInChat(); return; }
    if (it === 'question') {
      addTyping();
      try { var r1 = await askClaude(text); rmTyping(); addRow('bot', esc(r1)); chips(['Show me the product', 'List all categories', 'View cart', 'Ask another question']); }
      catch (e) { rmTyping(); addRow('bot', 'Could not get an answer. Try rephrasing!'); }
      return;
    }
    addTyping();
    var prods = [];
    try { prods = await searchProducts(text); }
    catch (e) { rmTyping(); addRow('bot', 'Could not reach the store API. Please try again.'); return; }
    rmTyping();
    if (!prods.length) {
      addTyping();
      try { var r2 = await askClaude(text); rmTyping(); addRow('bot', esc(r2)); }
      catch (e) { rmTyping(); addRow('bot', 'No results for "' + esc(text) + '". Try another keyword or browse categories.'); chips(['List all categories', 'Browse all products', 'Office chair']); }
      return;
    }
    prods.forEach(function (p) { cache[p.product_id] = p; });
    addRow('bot', 'Found <strong>' + prods.length + '</strong> result' + (prods.length > 1 ? 's' : '') + ' for "' + esc(text) + '" - tap a tile for details:');
    addTiles(prods);
    chips(['Ask about these products', 'List all collections', 'View cart', 'Search something else']);
  }

  window.ffSend = function () {
    var inp = document.getElementById('ff-inp'), text = inp.value.trim();
    if (!text) return;
    addRow('user', text); inp.value = ''; inp.style.height = '';
    handleMsg(text);
  };
  window.ffOnKey   = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ffSend(); } };
  window.ffResize  = function (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 80) + 'px'; };

  var CHIP_ALIASES = {
    'Search in chat': '__focus__',
    'Search something else': '__focus__',
    'Ask another question': '__focus__',
    'View cart': '__cart__',
    'List all categories': '__categories__',
    'List all collections': '__collections__',
    'Browse all products': '__all_products__'
  };

  window.ffChip = function (t) {
    if (CHIP_ALIASES[t] === '__focus__') { document.getElementById('ff-inp').focus(); return; }
    if (CHIP_ALIASES[t] === '__cart__') { ffShowCart(); return; }
    if (CHIP_ALIASES[t] === '__categories__') { addRow('user', t); handleMsg('list all categories'); return; }
    if (CHIP_ALIASES[t] === '__collections__') { addRow('user', t); handleMsg('list all collections'); return; }
    if (CHIP_ALIASES[t] === '__all_products__') { addRow('user', t); handleMsg('browse all products'); return; }
    if (t === 'Ask about these products') { addRow('bot', 'Ask me anything — materials, electronics specs, furniture size, care, or styling.'); document.getElementById('ff-inp').focus(); return; }
    if (t === 'Show me the product') {
      var vals = Object.values(cache), last = vals[vals.length - 1];
      if (last) { addRow('bot', 'Here\'s <strong>' + esc(last.name) + '</strong>:'); ffExpand(last.product_id); }
      else addRow('bot', 'Search or browse products first, then try again.');
      return;
    }
    addRow('user', t); handleMsg(t);
  };

  addRow('bot', 'Welcome to <strong>' + STORE_NAME + '</strong>! Search for items, or say <strong>list all categories</strong>, <strong>list all collections</strong>, or <strong>browse all products</strong>.');
  chips(['List all categories', 'List all collections', 'Browse all products', 'Office chair', 'Wall clock', 'Dining table']);

})();