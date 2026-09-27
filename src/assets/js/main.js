/* Eden Park Arcachon — scripts du site (panier, filtres, galerie, cookies, paiement) */
(function () {
  'use strict';

  var CAT = window.EP_CATALOG || { products: [], shipping: {} };
  var SHIP = CAT.shipping;
  var BACKORDER_DAYS = CAT.backorderDays || 15;
  var STOCK = CAT.stock || {}; // remplacé par le stock en temps réel (/api/stock)
  var GIFT = CAT.gift || { enabled: false };
  var GIFT_KEY = 'ep_gift';
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- Utilitaires ---------- */
  function euro(cents) {
    var v = cents / 100;
    return v.toLocaleString('fr-FR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key));
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }
  function product(slug) {
    for (var i = 0; i < CAT.products.length; i++) if (CAT.products[i].slug === slug) return CAT.products[i];
    return null;
  }
  function imageFor(p, color) {
    if (!p) return '';
    for (var i = 0; i < p.images.length; i++) if (p.images[i].variant && p.images[i].variant === color) return p.images[i].src;
    return p.images[0] ? p.images[0].src : '';
  }

  /* ---------- Soldes et promotions : prix appliqué à la date du jour (Paris) ---------- */
  function parisToday() {
    try { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function activeOffer(slug) {
    var p = product(slug);
    if (!p) return null;
    var d = parisToday();
    return (p.offers || []).filter(function (o) {
      return (!o.starts || d >= o.starts) && (!o.ends || d <= o.ends) && o.price < p.price;
    }).sort(function (a, b) { return a.price - b.price; })[0] || null;
  }
  function effPrice(slug) {
    var o = activeOffer(slug);
    return o ? o.price : product(slug).price;
  }
  function saleBadge(o) { return o.ref ? '-' + o.percent + ' %' : o.label; }
  function dateLong(iso) {
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  // Met à jour les prix affichés (générés à la publication) selon la date du jour
  function refreshPrices() {
    $$('[data-price-slug]').forEach(function (el) {
      var slug = el.getAttribute('data-price-slug');
      var p = product(slug);
      if (!p) return;
      var o = activeOffer(slug);
      var page = el.getAttribute('data-price-style') === 'page';
      el.innerHTML = o
        ? '<ins>' + euro(o.price) + '</ins>' + (o.ref ? ' <del>' + euro(o.ref) + '</del>' : '') + (page ? ' <span class="badge badge--sale">' + esc(saleBadge(o)) + '</span>' : '')
        : euro(p.price);
      var card = el.closest('.card');
      if (card) { card.setAttribute('data-price', o ? o.price : p.price); card.setAttribute('data-sale', o ? '1' : '0'); }
    });
    $$('[data-sale-badge]').forEach(function (b) {
      var o = activeOffer(b.getAttribute('data-sale-badge'));
      b.hidden = !o;
      if (o) b.textContent = saleBadge(o);
    });
    $$('[data-sale-note]').forEach(function (n) {
      var o = activeOffer(n.getAttribute('data-sale-note'));
      var parts = [];
      if (o && o.ref) parts.push(o.label + ' : le prix barré est le prix le plus bas pratiqué au cours des 30 jours précédant la réduction.');
      if (o && o.ends) parts.push('Offre valable jusqu’au ' + dateLong(o.ends) + ' inclus.');
      n.textContent = parts.join(' ');
    });
  }

  refreshPrices();

  /* ---------- Panier ---------- */
  var CART_KEY = 'ep_cart_v1';
  var memoryCart = [];
  function getCart() {
    var c = store(CART_KEY);
    if (!Array.isArray(c)) c = memoryCart;
    // ignore les produits retirés du catalogue
    return c.filter(function (l) { return product(l.slug) && l.qty > 0; });
  }
  function saveCart(c) {
    memoryCart = c;
    store(CART_KEY, c);
    renderCart();
    refreshPromo();
  }
  function addToCart(slug, color, size, qty) {
    var c = getCart();
    var found = null;
    c.forEach(function (l) { if (l.slug === slug && l.color === color && l.size === size) found = l; });
    if (found) found.qty = Math.min(10, found.qty + qty); else c.push({ slug: slug, color: color, size: size, qty: qty });
    saveCart(c);
  }
  function subtotal(c) {
    return c.reduce(function (s, l) { return s + effPrice(l.slug) * l.qty; }, 0);
  }
  function shippingCost(zone, sub) {
    if (zone === 'retrait') return 0;
    if (zone === 'domtom') return SHIP.domtom_price;
    return sub >= SHIP.free_threshold ? 0 : SHIP.metro_price;
  }
  function freeShipHtml(sub) {
    if (!sub) return '';
    var left = SHIP.free_threshold - sub;
    var pct = Math.min(100, Math.round(sub / SHIP.free_threshold * 100));
    var msg = left > 0
      ? 'Plus que <strong>' + euro(left) + '</strong> pour profiter de la livraison offerte.'
      : '<strong>Bonne nouvelle :</strong> la livraison est offerte en France métropolitaine !';
    return msg + '<div class="free-ship__bar"><span style="width:' + pct + '%"></span></div>';
  }
  /* Stock : nombre disponible, ou null si non suivi (considéré disponible) */
  function avail(slug, color, size) {
    var s = STOCK[slug];
    var v = s ? s[color + '|' + size] : undefined;
    return typeof v === 'number' ? v : null;
  }
  function isLate(slug, color, size, qty) {
    var a = avail(slug, color, size);
    return a !== null && qty > a;
  }
  var lateText = 'Sur commande · expédition sous ' + BACKORDER_DAYS + ' jours';

  function lineHtml(l, i, big) {
    var p = product(l.slug);
    var meta = esc(l.color) + (l.size && l.size !== 'Taille unique' ? ' · Taille ' + esc(l.size) : '');
    var unit = effPrice(l.slug);
    var late = isLate(l.slug, l.color, l.size, l.qty) ? '<br><span class="late">' + lateText + '</span>' : '';
    var img = '<img src="' + esc(imageFor(p, l.color)) + '" alt="" width="110" height="140" loading="lazy">';
    var qty = '<div class="qty qty--sm"><button type="button" data-line-qty="' + i + '" data-delta="-1" aria-label="Diminuer">−</button>' +
      '<input type="number" value="' + l.qty + '" min="1" max="10" data-line-input="' + i + '" aria-label="Quantité"><button type="button" data-line-qty="' + i + '" data-delta="1" aria-label="Augmenter">+</button></div>';
    if (!big) {
      return '<div class="mini-item">' + img + '<div><p class="mini-item__name"><a href="' + p.url + '">' + esc(p.name) + '</a></p><p class="mini-item__meta">' + meta + late + '</p>' + qty +
        '</div><div class="mini-item__price">' + euro(unit * l.qty) + '<br><button class="link-btn" type="button" data-line-remove="' + i + '">Retirer</button></div></div>';
    }
    return '<div class="cart-line">' + img + '<div><p class="cart-line__name"><a href="' + p.url + '">' + esc(p.name) + '</a></p><p class="cart-line__meta">' + meta + ' · ' + euro(unit) + (unit < p.price ? ' <del>' + euro(p.price) + '</del>' : '') + late + '</p>' + qty +
      '</div><div class="cart-line__side"><strong>' + euro(unit * l.qty) + '</strong><button class="link-btn" type="button" data-line-remove="' + i + '">Supprimer</button></div></div>';
  }
  function currentZone() {
    var r = $('input[name="zone"]:checked');
    return r ? r.value : 'metro';
  }
  function renderCart() {
    var c = getCart();
    var count = c.reduce(function (s, l) { return s + l.qty; }, 0);
    var sub = subtotal(c);
    $$('[data-cart-count]').forEach(function (el) { el.textContent = count; el.setAttribute('data-count', count); });
    $$('[data-subtotal]').forEach(function (el) { el.textContent = euro(sub); });
    $$('[data-free-ship]').forEach(function (el) { el.innerHTML = freeShipHtml(sub); });

    var mini = $('[data-mini-cart]');
    if (mini) {
      mini.innerHTML = c.length ? c.map(function (l, i) { return lineHtml(l, i, false); }).join('')
        : '<div class="mini-empty"><p>Votre panier est vide.</p><a class="btn btn--ghost" href="/boutique/">Découvrir la boutique</a></div>';
      var foot = $('[data-mini-foot]');
      if (foot) foot.hidden = !c.length;
    }

    var page = $('[data-cart-page]');
    if (page) {
      var lines = $('[data-cart-lines]');
      var summary = $('[data-summary]');
      if (!c.length) {
        lines.innerHTML = '<div class="empty-state"><p>Votre panier est vide.</p><a class="btn" href="/boutique/">Découvrir la collection</a></div>';
        summary.hidden = true;
      } else {
        summary.hidden = false;
        lines.innerHTML = c.map(function (l, i) { return lineHtml(l, i, true); }).join('');
        var zone = currentZone();
        var discount = PROMO ? Math.min(PROMO.discount || 0, sub) : 0;
        var freeShip = !!(PROMO && PROMO.freeShipping);
        var ship = freeShip ? 0 : shippingCost(zone, sub - discount);
        $('[data-shipping]').textContent = ship ? euro(ship) : (zone === 'retrait' ? 'Gratuit' : 'Offerte');
        $('[data-discount-row]').hidden = !discount;
        if (discount) {
          $('[data-discount-label]').textContent = 'Code ' + PROMO.code + ' (' + PROMO.label + ')';
          $('[data-discount]').textContent = '−' + euro(discount);
        }
        var giftOn = GIFT.enabled && giftState().on;
        var giftPrice = giftOn ? (GIFT.price || 0) : 0;
        var gr = $('[data-gift-row]');
        if (gr) { gr.hidden = !giftOn; $('[data-gift-price]').textContent = giftPrice ? euro(giftPrice) : 'Offert'; }
        $('[data-total]').textContent = euro(sub - discount + ship + giftPrice);
        renderCartLook(c);
        var mp = $('[data-ship-price="metro"]');
        if (mp) mp.textContent = freeShip || sub - discount >= SHIP.free_threshold ? 'Offerte' : euro(SHIP.metro_price);
        var late = c.some(function (l) { return isLate(l.slug, l.color, l.size, l.qty); });
        $('[data-backorder-note]').innerHTML = late
          ? '<div class="notice">Un ou plusieurs articles sont <strong>sur commande</strong> : votre commande vous parviendra sous ' + BACKORDER_DAYS + ' jours environ.</div>'
          : '';
      }
    }
  }
  /* ---------- Code promo (panier) ---------- */
  var PROMO_KEY = 'ep_promo';
  var PROMO = null; // { code, discount, freeShipping, label } renvoyé par le serveur
  var promoTimer;
  function promoMsg(html, cls) {
    var m = $('[data-promo-msg]');
    if (!m) return;
    m.className = 'promo__msg' + (cls ? ' ' + cls : '');
    m.innerHTML = html;
  }
  function checkPromo(code, silent) {
    if (!code) return;
    fetch('/api/promo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, items: getCart() }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.ok) {
          PROMO = res.d;
          store(PROMO_KEY, PROMO.code);
          promoMsg('Code <strong>' + esc(PROMO.code) + '</strong> appliqué : ' + esc(PROMO.label) + '<button type="button" data-promo-remove>Retirer</button>', 'is-ok');
        } else {
          PROMO = null;
          if (!silent || res.status === 400) promoMsg(esc(res.d.error || 'Code invalide') + (store(PROMO_KEY) ? '<button type="button" data-promo-remove>Retirer</button>' : ''), 'is-error');
        }
        renderCart();
      })
      .catch(function () { promoMsg('Les codes promo ne sont pas disponibles pour le moment.', 'is-error'); });
  }
  var promoForm = $('[data-promo-form]');
  if (promoForm) {
    promoForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = promoForm.code.value.trim().toUpperCase();
      if (!code) { promoMsg('Saisissez un code.', 'is-error'); return; }
      checkPromo(code, false);
    });
    promoForm.addEventListener('click', function (e) {
      if (!e.target.closest('[data-promo-remove]')) return;
      PROMO = null;
      store(PROMO_KEY, null);
      promoForm.code.value = '';
      promoMsg('');
      renderCart();
    });
    var savedCode = store(PROMO_KEY);
    if (savedCode) { promoForm.code.value = savedCode; checkPromo(savedCode, true); }
  }
  // le montant de la remise dépend du panier : on le recalcule après chaque modification
  function refreshPromo() {
    if (!promoForm || !PROMO) return;
    clearTimeout(promoTimer);
    promoTimer = setTimeout(function () { checkPromo(PROMO.code, true); }, 350);
  }

  function updateLine(i, qty) {
    var c = getCart();
    if (!c[i]) return;
    if (qty <= 0) c.splice(i, 1); else c[i].qty = Math.min(10, qty);
    saveCart(c);
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-line-qty]');
    if (t) {
      var i = +t.getAttribute('data-line-qty');
      var c = getCart();
      if (c[i]) updateLine(i, c[i].qty + +t.getAttribute('data-delta'));
      return;
    }
    t = e.target.closest('[data-line-remove]');
    if (t) { updateLine(+t.getAttribute('data-line-remove'), 0); return; }
    t = e.target.closest('[data-quick-add]');
    if (t) {
      e.preventDefault();
      var p = product(t.getAttribute('data-quick-add'));
      addToCart(p.slug, p.colors[0], p.sizes[0], 1);
      openDrawer('mini-cart');
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('[data-line-input]')) updateLine(+t.getAttribute('data-line-input'), parseInt(t.value, 10) || 0);
    if (t.name === 'zone') renderCart();
  });

  /* ---------- Tiroirs (menu mobile, mini-panier) ---------- */
  var lastFocus = null;
  function openDrawer(id) {
    var d = document.getElementById(id);
    if (!d) return;
    lastFocus = document.activeElement;
    d.classList.add('is-open');
    d.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    $$('[aria-controls="' + id + '"]').forEach(function (b) { b.setAttribute('aria-expanded', 'true'); });
    var f = $('[data-close]:not(.drawer__backdrop)', d);
    if (f) setTimeout(function () { f.focus(); }, 50);
  }
  function closeDrawers() {
    $$('.drawer.is-open').forEach(function (d) {
      d.classList.remove('is-open');
      d.setAttribute('aria-hidden', 'true');
      $$('[aria-controls="' + d.id + '"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    });
    document.body.style.overflow = '';
    if (lastFocus) lastFocus.focus();
  }
  document.addEventListener('click', function (e) {
    var o = e.target.closest('[data-open]');
    if (o) {
      // le lien panier mène à /panier/ ; sur la page panier elle-même, on le laisse faire
      if (o.getAttribute('data-open') === 'mini-cart' && $('[data-cart-page]')) return;
      e.preventDefault();
      openDrawer(o.getAttribute('data-open'));
      return;
    }
    if (e.target.closest('[data-close]')) closeDrawers();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawers(); });

  /* ---------- Fiche produit ---------- */
  var form = $('[data-add-form]');
  if (form) {
    var slug = form.slug.value;
    var gallery = $('[data-gallery]');
    var show = function (i) {
      $$('[data-slide]', gallery).forEach(function (f) { f.classList.toggle('is-active', +f.getAttribute('data-slide') === i); });
      $$('[data-thumb]', gallery).forEach(function (b) { b.setAttribute('aria-current', +b.getAttribute('data-thumb') === i ? 'true' : 'false'); });
    };
    gallery.addEventListener('click', function (e) {
      var b = e.target.closest('[data-thumb]');
      if (b) show(+b.getAttribute('data-thumb'));
    });
    form.addEventListener('change', function (e) {
      if (e.target.name === 'color') {
        $('[data-color-label]').textContent = e.target.value;
        var match = $$('[data-thumb]', gallery).filter(function (b) { return b.getAttribute('data-variant') === e.target.value; })[0];
        if (match) show(+match.getAttribute('data-thumb'));
      }
      if (e.target.name === 'size') $('[data-size-error]').hidden = true;
      renderAvailability();
    });
    form.qty.addEventListener('input', function () { renderAvailability(); });
    $$('[data-qty]', form).forEach(function (b) {
      b.addEventListener('click', function () {
        var q = form.qty;
        q.value = Math.max(1, Math.min(10, (parseInt(q.value, 10) || 1) + +b.getAttribute('data-qty')));
        renderAvailability();
      });
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var size = $('input[name="size"]:checked', form);
      var color = $('input[name="color"]:checked', form);
      if (!size) {
        $('[data-size-error]').hidden = false;
        $('.size-opts input', form).focus();
        return;
      }
      var qty = Math.max(1, Math.min(10, parseInt(form.qty.value, 10) || 1));
      addToCart(slug, color.value, size.value, qty);
      openDrawer('mini-cart');
    });
  }

  /* Disponibilité de la variante choisie (fiche produit) */
  function renderAvailability() {
    if (!form) return;
    var slug = form.slug.value;
    var color = $('input[name="color"]:checked', form).value;
    var size = $('input[name="size"]:checked', form);
    // grise légèrement les tailles épuisées dans la couleur choisie (elles restent commandables)
    $$('input[name="size"]', form).forEach(function (inp) {
      var a = avail(slug, color, inp.value);
      var out = a !== null && a <= 0;
      inp.nextElementSibling.classList.toggle('is-out', out);
      inp.nextElementSibling.title = out ? 'Sur commande – expédition sous ' + BACKORDER_DAYS + ' jours' : '';
    });
    var el = $('[data-availability]');
    renderEta();
    if (!size) { el.innerHTML = ''; return; }
    var a = avail(slug, color, size.value);
    var qty = Math.max(1, parseInt(form.qty.value, 10) || 1);
    if (a === null || qty <= a) {
      el.className = 'availability is-ok';
      el.innerHTML = a !== null && a <= 3
        ? '<strong>Plus que ' + a + ' en stock</strong> · expédié sous 1 à 2 jours'
        : '<strong>En stock</strong> · expédié sous 1 à 2 jours';
    } else {
      el.className = 'availability is-late';
      el.innerHTML = a > 0
        ? '<strong>Seulement ' + a + ' en stock</strong> · au-delà, commande expédiée sous ' + BACKORDER_DAYS + ' jours'
        : '<strong>Sur commande</strong> · expédition sous ' + BACKORDER_DAYS + ' jours';
    }
  }

  /* Date de livraison estimée (fiche produit) */
  function addBusinessDays(d, n) {
    var x = new Date(d);
    while (n > 0) { x.setDate(x.getDate() + 1); if (x.getDay() !== 0 && x.getDay() !== 6) n--; }
    return x;
  }
  function fmtDay(d) { return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }); }
  function renderEta() {
    var el = $('[data-eta]');
    if (!el || !form) return;
    var size = $('input[name="size"]:checked', form);
    if (!size) { el.innerHTML = ''; return; }
    var color = $('input[name="color"]:checked', form).value;
    var qty = Math.max(1, parseInt(form.qty.value, 10) || 1);
    var today = new Date();
    var m = String(SHIP.metro_delay || '').match(/(\d+)\D+(\d+)/);
    var tmin = m ? +m[1] : 2, tmax = m ? +m[2] : 4;
    var from, to, pickup;
    if (isLate(form.slug.value, color, size.value, qty)) {
      from = new Date(today); from.setDate(from.getDate() + Math.max(1, BACKORDER_DAYS - 3));
      to = new Date(today); to.setDate(to.getDate() + BACKORDER_DAYS);
      pickup = null;
    } else {
      from = addBusinessDays(today, 1 + tmin);   // préparation 1 à 2 jours + transport Colissimo
      to = addBusinessDays(today, 2 + tmax);
      pickup = addBusinessDays(today, 1);
    }
    el.innerHTML = 'Livraison estimée en France : entre le <strong>' + fmtDay(from) + '</strong> et le <strong>' + fmtDay(to) + '</strong>' +
      (pickup ? '<br>Retrait gratuit en boutique dès le <strong>' + fmtDay(pickup) + '</strong>' : '');
  }

  /* Barre « Ajouter au panier » fixe sur mobile */
  var buybar = $('[data-buybar]');
  if (buybar && form && 'IntersectionObserver' in window) {
    var mainBtn = $('button[type="submit"]', form);
    new IntersectionObserver(function (entries) {
      var hidden = !entries[0].isIntersecting && entries[0].boundingClientRect.top < 0;
      buybar.classList.toggle('is-visible', hidden);
      buybar.setAttribute('aria-hidden', hidden ? 'false' : 'true');
      $('[data-buybar-add]', buybar).tabIndex = hidden ? 0 : -1;
    }).observe(mainBtn);
    $('[data-buybar-add]', buybar).addEventListener('click', function () {
      if ($('input[name="size"]:checked', form)) { form.requestSubmit ? form.requestSubmit() : mainBtn.click(); return; }
      $('[data-size-error]').hidden = false;
      $('.size-opts', form).scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  /* Avis clients : envoi (publié après validation par la boutique) */
  var reviewForm = $('[data-review-form]');
  if (reviewForm) {
    reviewForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = $('[data-review-msg]', reviewForm);
      var fd = new FormData(reviewForm);
      var data = {};
      fd.forEach(function (v, k) { data[k] = v; });
      var fail = function (t) { msg.textContent = t; msg.hidden = false; };
      if (!data.rating) return fail('Choisissez une note en cliquant sur les étoiles.');
      if (!data.consent) return fail('Merci d’accepter la publication de votre avis.');
      var btn = $('button[type="submit"]', reviewForm);
      btn.disabled = true;
      fetch('/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Envoi impossible'); }); })
        .then(function () {
          reviewForm.innerHTML = '<h3>Merci pour votre avis !</h3><p>Il sera publié après vérification par notre équipe.</p>';
        })
        .catch(function (err) { fail(err.message === 'Failed to fetch' ? 'Envoi impossible pour le moment, réessayez plus tard.' : err.message); btn.disabled = false; });
    });
  }

  /* ---------- Emballage cadeau (panier) ---------- */
  function giftState() { return store(GIFT_KEY) || { on: false, message: '' }; }
  var giftBox = $('[data-gift]');
  if (giftBox) {
    var gOn = $('[data-gift-on]', giftBox), gMsg = $('[data-gift-message]', giftBox);
    var gs = giftState();
    gOn.checked = !!gs.on;
    gMsg.value = gs.message || '';
    var syncGift = function () {
      $('[data-gift-msg]', giftBox).hidden = !gOn.checked;
      $('[data-gift-left]', giftBox).textContent = 200 - gMsg.value.length;
      store(GIFT_KEY, { on: gOn.checked, message: gMsg.value.slice(0, 200) });
      renderCart();
    };
    gOn.addEventListener('change', syncGift);
    gMsg.addEventListener('input', syncGift);
    $('[data-gift-msg]', giftBox).hidden = !gOn.checked;
    $('[data-gift-left]', giftBox).textContent = 200 - gMsg.value.length;
  }

  /* ---------- « Complétez le look » dans le panier ---------- */
  function renderCartLook(c) {
    var box = $('[data-cart-look]');
    if (!box) return;
    var inCart = c.map(function (l) { return l.slug; });
    var picks = [];
    c.forEach(function (l) {
      (product(l.slug).look || []).forEach(function (s) {
        if (inCart.indexOf(s) === -1 && picks.indexOf(s) === -1 && product(s)) picks.push(s);
      });
    });
    picks = picks.slice(0, 3);
    box.hidden = !picks.length;
    $('[data-cart-look-items]', box).innerHTML = picks.map(function (s) {
      var p = product(s);
      var o = activeOffer(s);
      var one = p.sizes.length === 1 && p.colors.length === 1;
      var img = p.images[0] ? '<img src="' + esc(p.images[0].src) + '" alt="" loading="lazy">' : '';
      return '<div class="look-item"><a class="look-item__img" href="' + p.url + '">' + img + '</a>' +
        '<div class="look-item__body"><a href="' + p.url + '">' + esc(p.name) + '</a><span class="price">' +
        (o ? '<ins>' + euro(o.price) + '</ins>' + (o.ref ? ' <del>' + euro(o.ref) + '</del>' : '') : euro(p.price)) + '</span></div>' +
        (one ? '<button class="btn btn--ghost btn--sm" type="button" data-quick-add="' + s + '">Ajouter</button>' : '<a class="btn btn--ghost btn--sm" href="' + p.url + '">Choisir</a>') + '</div>';
    }).join('');
  }

  /* ---------- Recherche ---------- */
  function norm(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[«»'’]/g, ' '); }
  function searchProducts(q) {
    var words = norm(q).split(/\s+/).filter(function (w) { return w.length > 1; });
    if (!words.length) return [];
    return CAT.products.map(function (p) {
      var hay = norm(p.search || p.name);
      var name = norm(p.name);
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        if (hay.indexOf(words[i]) === -1) return null; // tous les mots doivent être présents
        score += name.indexOf(words[i]) > -1 ? 3 : 1;
      }
      return { p: p, score: score };
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).map(function (x) { return x.p; });
  }
  function highlight(text, q) {
    var out = esc(text);
    norm(q).split(/\s+/).filter(function (w) { return w.length > 1; }).forEach(function (w) {
      var i = norm(text).indexOf(w);
      if (i > -1) {
        var orig = text.substr(i, w.length);
        out = out.replace(esc(orig), '<mark>' + esc(orig) + '</mark>');
      }
    });
    return out;
  }
  var panel = $('#search-panel');
  if (panel) {
    var sInput = $('[data-search-input]', panel), sRes = $('[data-search-results]', panel);
    var openSearch = function () {
      panel.hidden = false;
      document.body.style.overflow = 'hidden';
      setTimeout(function () { sInput.focus(); }, 30);
    };
    var closeSearch = function () { panel.hidden = true; document.body.style.overflow = ''; };
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-open-search]')) { e.preventDefault(); openSearch(); }
      if (e.target.closest('[data-close-search]')) closeSearch();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) closeSearch();
      if (e.key === '/' && panel.hidden && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
    });
    sInput.addEventListener('input', function () {
      var q = sInput.value.trim();
      if (q.length < 2) { sRes.innerHTML = ''; return; }
      var hits = searchProducts(q);
      sRes.innerHTML = hits.length
        ? hits.slice(0, 6).map(function (p) {
            var o = activeOffer(p.slug);
            var img = p.images[0] ? '<img src="' + esc(p.images[0].src) + '" alt="">' : '<span></span>';
            return '<a class="search-hit" href="' + p.url + '">' + img + '<span><strong>' + highlight(p.name, q) + '</strong><small>' + esc(p.category) + '</small></span>' +
              '<span class="price">' + (o ? '<ins>' + euro(o.price) + '</ins>' : euro(p.price)) + '</span></a>';
          }).join('') + (hits.length > 6 ? '<a class="search-all" href="/recherche/?q=' + encodeURIComponent(q) + '">Voir les ' + hits.length + ' résultats</a>' : '')
        : '<p class="search-empty">Aucun produit ne correspond à « ' + esc(q) + ' ». Essayez « polo », « casquette » ou « Dune du Pyla ».</p>';
    });
  }
  // Page /recherche/ : affiche les cartes produits correspondantes
  var sPage = $('[data-search-page]');
  if (sPage) {
    var q0 = '';
    try { q0 = new URLSearchParams(location.search).get('q') || ''; } catch (e) { /* ancien navigateur */ }
    sPage.q.value = q0;
    var grid = $('[data-search-grid]'), src = $('[data-search-source]');
    var hits0 = searchProducts(q0);
    hits0.forEach(function (p) { var card = $('.card[data-slug="' + p.slug + '"]', src); if (card) grid.appendChild(card); });
    $('[data-search-count]').textContent = q0
      ? (hits0.length ? hits0.length + ' résultat' + (hits0.length > 1 ? 's' : '') + ' pour « ' + q0 + ' »' : 'Aucun résultat pour « ' + q0 + ' ». Découvrez toute la boutique ci-dessous.')
      : 'Saisissez un mot : polo, casquette, Dune du Pyla, rose…';
    if (q0 && !hits0.length) $$('.card', src).forEach(function (card) { grid.appendChild(card); });
  }

  /* ---------- Zoom plein écran sur les photos produit ---------- */
  var lb = $('#lightbox');
  if (lb && lb.showModal) {
    var slides = $$('[data-slide]');
    var lbImg = $('.lightbox__img', lb), lbIdx = 0;
    var lbShow = function (i) {
      lbIdx = (i + slides.length) % slides.length;
      lbImg.src = slides[lbIdx].getAttribute('data-full');
      lbImg.alt = slides[lbIdx].getAttribute('data-alt') || '';
      $('.lightbox__count', lb).textContent = (lbIdx + 1) + ' / ' + slides.length;
      $$('.lightbox__nav', lb).forEach(function (b) { b.hidden = slides.length < 2; });
    };
    var lbOpen = function (i) { lbShow(i); lb.showModal(); };
    slides.forEach(function (f, i) {
      f.addEventListener('click', function () { lbOpen(i); });
      f.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lbOpen(i); } });
    });
    lb.addEventListener('click', function (e) {
      var nav = e.target.closest('[data-lb]');
      if (nav) { lbShow(lbIdx + +nav.getAttribute('data-lb')); return; }
      if (e.target.closest('[data-lb-close]') || e.target === lb) lb.close();
    });
    lb.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') lbShow(lbIdx + 1);
      if (e.key === 'ArrowLeft') lbShow(lbIdx - 1);
    });
    // balayage sur mobile
    var x0 = null;
    lb.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 50) lbShow(lbIdx + (dx < 0 ? 1 : -1));
      x0 = null;
    });
  }

  /* Stock en temps réel */
  function refreshStock() {
    fetch('/api/stock', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.stock) return;
        STOCK = data.stock;
        if (data.backorderDays) BACKORDER_DAYS = data.backorderDays;
        lateText = 'Sur commande · expédition sous ' + BACKORDER_DAYS + ' jours';
        renderAvailability();
        renderCart();
      })
      .catch(function () { /* hors ligne ou site local : on garde le stock du build */ });
  }
  renderAvailability();
  if (form || $('[data-cart-page]') || getCart().length) refreshStock();

  /* Dialogues (guide des tailles) */
  document.addEventListener('click', function (e) {
    var o = e.target.closest('[data-open-dialog]');
    if (o) {
      var d = document.getElementById(o.getAttribute('data-open-dialog'));
      if (d && d.showModal) d.showModal();
    }
    if (e.target.closest('[data-close-dialog]')) { var dd = e.target.closest('dialog'); if (dd) dd.close(); }
    if (e.target.tagName === 'DIALOG') e.target.close();
  });

  /* ---------- Catalogue : filtres, tri, pagination ---------- */
  var shop = $('[data-shop]');
  if (shop) {
    var PER_PAGE = 12;
    var page = 1;
    var grid = $('[data-grid]', shop);
    var cards = $$('.card', grid);
    var filters = $('[data-filters]', shop);
    var sortSel = $('[data-sort]', shop);

    var values = function (name) { return $$('input[name="' + name + '"]:checked', filters).map(function (i) { return i.value; }); };
    var intersects = function (attr, wanted) {
      if (!wanted.length) return true;
      var have = attr.split('|');
      return wanted.some(function (w) { return have.indexOf(w) > -1; });
    };
    var apply = function (resetPage) {
      if (resetPage) page = 1;
      var cats = values('cat'), sizes = values('size'), colors = values('color'), fits = values('fit');
      var saleOnly = values('sale').length > 0;
      var min = parseFloat(filters.min.value) * 100 || 0;
      var max = parseFloat(filters.max.value) * 100 || Infinity;
      var sort = sortSel.value;
      var keyed = cards.slice().sort(function (a, b) {
        var pa = +a.dataset.price, pb = +b.dataset.price;
        if (sort === 'asc') return pa - pb;
        if (sort === 'desc') return pb - pa;
        if (sort === 'new') return b.dataset.date.localeCompare(a.dataset.date);
        return +b.dataset.pop - +a.dataset.pop;
      });
      var visible = keyed.filter(function (c) {
        var p = +c.dataset.price;
        return (!cats.length || cats.indexOf(c.dataset.cat) > -1) && (!saleOnly || c.dataset.sale === '1') && intersects(c.dataset.sizes, sizes) &&
          intersects(c.dataset.colors, colors) && intersects(c.dataset.fit, fits) && p >= min && p <= max;
      });
      keyed.forEach(function (c) { grid.appendChild(c); c.hidden = true; });
      var pages = Math.max(1, Math.ceil(visible.length / PER_PAGE));
      page = Math.min(page, pages);
      visible.slice((page - 1) * PER_PAGE, page * PER_PAGE).forEach(function (c) { c.hidden = false; });
      $('[data-count]', shop).textContent = visible.length + ' produit' + (visible.length > 1 ? 's' : '');
      $('[data-empty]', shop).hidden = visible.length > 0;
      var pager = $('[data-pager]', shop);
      pager.innerHTML = '';
      if (pages > 1) {
        for (var i = 1; i <= pages; i++) {
          var b = document.createElement('button');
          b.type = 'button'; b.textContent = i; b.setAttribute('aria-label', 'Page ' + i);
          if (i === page) b.setAttribute('aria-current', 'true');
          b.addEventListener('click', (function (n) { return function () { page = n; apply(false); shop.scrollIntoView({ behavior: 'smooth' }); }; })(i));
          pager.appendChild(b);
        }
      }
    };
    filters.addEventListener('change', function () { apply(true); });
    filters.addEventListener('input', function (e) { if (e.target.type === 'number') apply(true); });
    filters.addEventListener('reset', function () { setTimeout(function () { apply(true); }, 0); });
    sortSel.addEventListener('change', function () { apply(true); });
    var reset = $('[data-reset]', shop);
    if (reset) reset.addEventListener('click', function () { filters.reset(); });
    var tgl = $('[data-filters-toggle]', shop);
    if (tgl) tgl.addEventListener('click', function () {
      var open = filters.classList.toggle('is-open');
      tgl.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // filtres pré-remplis via l'URL, ex. /boutique/?taille=M
    try {
      var qs = new URLSearchParams(location.search);
      [['cat', 'categorie'], ['size', 'taille'], ['color', 'couleur']].forEach(function (pair) {
        qs.getAll(pair[1]).forEach(function (v) {
          var inp = $('input[name="' + pair[0] + '"][value="' + v.replace(/"/g, '') + '"]', filters);
          if (inp) inp.checked = true;
        });
      });
    } catch (e) { /* navigateur ancien */ }
    apply(true);
  }

  /* ---------- Commande (Stripe Checkout) ---------- */
  var checkout = $('[data-checkout]');
  if (checkout) {
    checkout.addEventListener('click', function () {
      var cgv = $('[data-cgv]');
      var err = $('[data-cgv-error]');
      if (!cgv.checked) { err.hidden = false; cgv.focus(); return; }
      err.hidden = true;
      var c = getCart();
      if (!c.length) return;
      var msg = $('[data-checkout-msg]');
      checkout.disabled = true;
      checkout.lastChild.textContent = ' Redirection vers le paiement…';
      fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: c, zone: currentZone(), promo: PROMO ? PROMO.code : null, gift: GIFT.enabled && giftState().on ? giftState() : null })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
      }).then(function (res) {
        if (res.ok && res.data.url) { location.href = res.data.url; return; }
        if (res.data.demo || res.status === 404 || res.status === 405 || res.status === 503) {
          // Paiement non configuré (site local ou clés Stripe absentes) : simulation
          msg.innerHTML = '<div class="notice">Mode démonstration : le paiement Stripe n’est pas encore activé. Simulation de la commande…</div>';
          setTimeout(function () { location.href = '/merci/?demo=1'; }, 1600);
          return;
        }
        throw new Error(res.data.error || 'Erreur');
      }).catch(function (e2) {
        msg.innerHTML = '<div class="notice">Le paiement n’a pas pu être initialisé (' + esc(e2.message) + '). Merci de réessayer ou de nous contacter.</div>';
        checkout.disabled = false;
        checkout.lastChild.textContent = ' Commander';
      });
    });
  }

  /* Page de remerciement : vide le panier */
  if ($('[data-thanks]')) {
    var params = new URLSearchParams(location.search);
    if (params.get('session_id') || params.get('demo')) { store('ep_promo', null); store('ep_gift', null); saveCart([]); }
    if (params.get('demo')) $('[data-demo-notice]').hidden = false;
  }

  /* ---------- Cookies (RGPD) ---------- */
  var CONSENT_KEY = 'ep_consent';
  var TWELVE_MONTHS = 365 * 24 * 3600 * 1000;
  var banner = $('#cookie');
  function loadAnalytics() {
    var id = CAT.analyticsId;
    if (!id || /X{4}/.test(id) || window.gtag) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id, { anonymize_ip: true });
  }
  function saveConsent(analytics) {
    store(CONSENT_KEY, { analytics: !!analytics, date: Date.now() });
    banner.classList.remove('is-visible', 'show-prefs');
    if (analytics) loadAnalytics();
  }
  function showBanner(withPrefs) {
    var c = store(CONSENT_KEY);
    $('#ck-analytics').checked = !!(c && c.analytics);
    banner.classList.add('is-visible');
    banner.classList.toggle('show-prefs', !!withPrefs);
    $('[data-cookie="custom"]').textContent = withPrefs ? 'Enregistrer mes choix' : 'Personnaliser';
  }
  if (banner) {
    var consent = store(CONSENT_KEY);
    if (!consent || Date.now() - consent.date > TWELVE_MONTHS) showBanner(false);
    else if (consent.analytics) loadAnalytics();
    banner.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cookie]');
      if (!b) return;
      var a = b.getAttribute('data-cookie');
      if (a === 'accept') saveConsent(true);
      else if (a === 'refuse') saveConsent(false);
      else if (banner.classList.contains('show-prefs')) saveConsent($('#ck-analytics').checked);
      else showBanner(true);
    });
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-cookie-prefs]')) showBanner(true);
    });
  }

  /* ---------- Apparition au défilement ---------- */
  var fades = $$('.fade-up');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    fades.forEach(function (f) { io.observe(f); });
  } else {
    fades.forEach(function (f) { f.classList.add('is-in'); });
  }

  /* Synchronise les onglets ouverts */
  window.addEventListener('storage', function (e) { if (e.key === CART_KEY) renderCart(); });

  renderCart();
})();
