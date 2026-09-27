/* Eden Park Arcachon — espace d'administration (produits, photos, stock, commandes) */
(function () {
  'use strict';

  var ALL_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'Taille unique'];
  var TOKEN_KEY = 'ep_admin_token';
  var state = { catalog: null, stock: {}, editing: null, isNew: false, dirty: false, rebuild: false, backorderDays: 15 };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function euro(cents) { return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }); }
  function slugify(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[«»"'’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  function token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return state.token; } }
  function setToken(t) { state.token = t; try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* navigation privée */ } }

  var toastTimer;
  function toast(msg, isError) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', !!isError);
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-visible'); }, isError ? 6000 : 4000);
  }

  function api(method, url, body, raw) {
    var headers = { Authorization: 'Bearer ' + token() };
    if (body && !raw) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = 'image/jpeg';
    return fetch(url, { method: method, headers: headers, body: raw ? body : (body ? JSON.stringify(body) : undefined) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 401 && url.indexOf('/login') === -1) { showLogin(); throw new Error(data.error || 'Session expirée'); }
          if (!r.ok) throw new Error(data.error || ('Erreur ' + r.status));
          return data;
        });
      });
  }

  /* ---------- Connexion ---------- */
  function showLogin() {
    setToken(null);
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#pwd').focus();
  }
  $('#login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('#login-error');
    err.hidden = true;
    fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pwd').value }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Connexion impossible'); return d; }); })
      .then(function (d) { setToken(d.token); $('#pwd').value = ''; start(); })
      .catch(function (ex) { err.textContent = ex.message === 'Failed to fetch' ? 'Serveur injoignable' : ex.message; err.hidden = false; });
  });
  $('#logout').addEventListener('click', function () { showLogin(); });

  function start() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    load().then(function () { showTab('products'); loadOrders(); loadReviews(); });
    loadPublish();
    fetch('/api/stock').then(function (r) { return r.json(); }).then(function (d) {
      state.backorderDays = d.backorderDays || 15;
      $$('[data-bo-days]').forEach(function (el) { el.textContent = state.backorderDays; });
    }).catch(function () {});
  }

  function load() {
    return Promise.all([
      api('GET', '/api/admin/catalog').then(function (d) {
        state.catalog = d.catalog;
        state.stock = d.stock || {};
        state.rebuild = d.rebuild;
      }),
      api('GET', '/api/admin/content').then(function (d) {
        state.site = d.site;
        state.content = d.content;
        state.uploads = d.uploads || [];
      })
    ]).catch(function (e) { toast(e.message, true); });
  }

  /* ---------- Onglets ---------- */
  function showTab(name) {
    if (state.dirty && !confirm('Des modifications ne sont pas enregistrées. Les abandonner ?')) return false;
    state.dirty = false;
    $$('.view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== name; });
    $$('[data-tab]').forEach(function (b) { b.setAttribute('aria-current', b.getAttribute('data-tab') === name || (name === 'editor' && b.getAttribute('data-tab') === 'products') ? 'true' : 'false'); });
    if (name === 'products') renderProducts();
    if (name === 'stock') renderStockAll();
    if (name === 'orders') loadOrders();
    if (name === 'pages') renderPages();
    if (name === 'categories') renderCategories();
    if (name === 'settings') renderSettings();
    if (name === 'promos') renderPromos();
    if (name === 'sales') renderSales();
    if (name === 'reviews') loadReviews();
    window.scrollTo(0, 0);
    return true;
  }
  $$('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });
  window.addEventListener('beforeunload', function (e) { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- Photos : URL d'aperçu ---------- */
  function previewSrc(img, product, index) {
    if (!img) return '';
    if (img.placeholder) return '/assets/img/produits/ph-' + product.slug + '-' + (index + 1) + '.svg';
    return thumbOf(img.src);
  }
  // Aperçu d'une photo : envoyée depuis l'admin (servie par /api/images/) ou livrée avec le site
  function thumbOf(src) {
    if (!src) return '';
    if (/(^|\/)uploads\//.test(src)) return '/api/images/' + src.split('/').pop().replace(/\.jpg$/, '-720.jpg');
    return '/assets/img/' + src.replace(/\.jpg$/, '-720.jpg');
  }
  function onImgError(e) {
    var im = e.target;
    if (im.tagName !== 'IMG') return;
    var step = +(im.dataset.fallback || 0);
    im.dataset.fallback = step + 1;
    // 1) photo envoyée en local, déjà intégrée au site : /assets/img/uploads/
    if (step === 0 && im.src.indexOf('/api/images/') > -1) { im.src = '/assets/img/uploads/' + im.src.split('/').pop(); return; }
    // 2) pas de version réduite : on prend l'originale
    if (step <= 1 && im.src.indexOf('-720.jpg') > -1) im.src = im.src.replace('-720.jpg', '.jpg');
  }
  document.addEventListener('error', onImgError, true);

  /* ---------- Stock : helpers ---------- */
  function stockSummary(p) {
    var s = state.stock[p.slug] || {};
    var total = 0, tracked = 0, out = 0, cells = 0;
    p.colors.forEach(function (c) {
      p.sizes.forEach(function (sz) {
        cells++;
        var v = s[c.name + '|' + sz];
        if (typeof v === 'number') { tracked++; total += v; if (v <= 0) out++; }
      });
    });
    if (!tracked) return '<span class="tag">Stock non suivi</span>';
    if (out === cells) return '<span class="tag tag--late">Épuisé · sur commande</span>';
    return '<span class="tag tag--ok">' + total + ' en stock</span>' + (out ? ' <span class="tag tag--late">' + out + ' épuisé' + (out > 1 ? 's' : '') + '</span>' : '');
  }

  function stockTable(p, values, onInput) {
    var s = values || {};
    var html = '<table><thead><tr><th>Couleur</th>' + p.sizes.map(function (sz) { return '<th>' + esc(sz) + '</th>'; }).join('') + '</tr></thead><tbody>';
    p.colors.forEach(function (c) {
      html += '<tr><td>' + esc(c.name || '(sans nom)') + '</td>';
      p.sizes.forEach(function (sz) {
        var k = c.name + '|' + sz;
        var v = typeof s[k] === 'number' ? s[k] : '';
        html += '<td><input type="number" min="0" step="1" inputmode="numeric" data-key="' + esc(k) + '" value="' + v + '" class="' + (v === 0 ? 'zero' : '') + '" aria-label="Stock ' + esc(c.name) + ' ' + esc(sz) + '"></td>';
      });
      html += '</tr>';
    });
    return html + '</tbody></table>';
  }

  /* ---------- Liste des produits ---------- */
  function catName(slug) {
    var c = state.catalog.categories.filter(function (x) { return x.slug === slug; })[0];
    return c ? c.name : slug;
  }
  function renderProducts() {
    var list = $('#plist');
    if (!state.catalog) { list.innerHTML = ''; return; }
    if (!state.catalog.products.length) { list.innerHTML = '<p class="empty">Aucun produit. Créez le premier !</p>'; return; }
    list.innerHTML = state.catalog.products.map(function (p, i) {
      return '<button type="button" class="pcard" data-edit="' + i + '"><img src="' + esc(previewSrc(p.images[0], p, 0)) + '" alt="" loading="lazy">' +
        '<span class="pcard__body"><span class="pcard__name">' + esc(p.name) + '</span>' +
        '<span class="pcard__meta"><span>' + esc(catName(p.category)) + '</span><strong>' + euro(p.price) + '</strong></span>' +
        '<span>' + stockSummary(p) + (p.featured ? ' <span class="tag">Accueil</span>' : '') + '</span></span></button>';
    }).join('');
  }
  $('#plist').addEventListener('click', function (e) {
    var b = e.target.closest('[data-edit]');
    if (b) openEditor(+b.getAttribute('data-edit'));
  });
  $('#new-product').addEventListener('click', function () { openEditor(-1); });

  /* ---------- Éditeur ---------- */
  var ed = $('#editor');
  function blankProduct() {
    return {
      slug: '', name: '', category: state.catalog.categories[0].slug, price: 0,
      colors: [{ name: 'Marine', hex: '#16213d' }], sizes: ['S', 'M', 'L', 'XL', '2XL'],
      fit: 'Coupe droite', badges: ['Nouveau'], featured: false, popularity: 50,
      date: new Date().toISOString().slice(0, 10), short: '', description: [], details: [], care: '', images: []
    };
  }

  function openEditor(index) {
    if (!showTab('editor')) return;
    state.isNew = index < 0;
    state.index = index;
    state.editing = JSON.parse(JSON.stringify(state.isNew ? blankProduct() : state.catalog.products[index]));
    state.editStock = JSON.parse(JSON.stringify(state.isNew ? {} : (state.stock[state.editing.slug] || {})));
    state.stockChanges = {};
    var p = state.editing;
    $('#ed-title').textContent = state.isNew ? 'Nouveau produit' : p.name;
    $('#ed-delete').hidden = state.isNew;
    $('#ed-error').hidden = true;
    $('#f-cat').innerHTML = state.catalog.categories.map(function (c) { return '<option value="' + esc(c.slug) + '">' + esc(c.name) + '</option>'; }).join('');
    $('#f-name').value = p.name;
    $('#f-slug').value = p.slug;
    $('#f-slug').readOnly = !state.isNew;
    $('#f-slug-help').textContent = state.isNew ? 'Générée à partir du nom. Elle ne pourra plus changer ensuite (bon pour Google).' : 'Adresse définitive de la page produit.';
    $('#f-cat').value = p.category;
    $('#f-price').value = p.price ? (p.price / 100).toFixed(2) : '';
    var sale = p.sale || {};
    $('#f-sale').value = sale.price ? (sale.price / 100).toFixed(2) : '';
    $('#f-sale-start').value = sale.starts || '';
    $('#f-sale-end').value = sale.ends || '';
    $('#f-fit').value = p.fit || '';
    $('#f-badges').value = (p.badges || []).join(', ');
    $('#f-featured').checked = !!p.featured;
    $('#f-short').value = p.short || '';
    $('#f-desc').value = (p.description || []).join('\n\n');
    $('#f-details').value = (p.details || []).join('\n');
    $('#f-care').value = p.care || '';
    renderColors();
    renderSizes();
    renderPhotos();
    renderEditorStock();
    renderRelated();
    state.dirty = false;
  }

  // relit les champs du formulaire dans state.editing
  function readForm() {
    var p = state.editing;
    p.name = $('#f-name').value.trim();
    if (state.isNew) p.slug = $('#f-slug').value.trim();
    p.category = $('#f-cat').value;
    p.price = Math.round(parseFloat(String($('#f-price').value).replace(',', '.')) * 100) || 0;
    var salePrice = Math.round(parseFloat(String($('#f-sale').value).replace(',', '.')) * 100) || 0;
    if (salePrice) p.sale = { price: salePrice, starts: $('#f-sale-start').value || '', ends: $('#f-sale-end').value || '' };
    else delete p.sale;
    p.fit = $('#f-fit').value.trim();
    p.badges = $('#f-badges').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    p.featured = $('#f-featured').checked;
    p.short = $('#f-short').value.trim();
    p.description = $('#f-desc').value.split(/\n\s*\n/).map(function (s) { return s.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    p.details = $('#f-details').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    p.care = $('#f-care').value.trim();
    p.related = $$('#related input:checked').map(function (i) { return i.value; });
    if (!p.related.length) delete p.related;
    return p;
  }

  ed.addEventListener('input', function (e) {
    state.dirty = true;
    if (e.target.id === 'f-name' && state.isNew && !$('#f-slug').dataset.touched) $('#f-slug').value = slugify(e.target.value);
    if (e.target.id === 'f-slug') { e.target.dataset.touched = '1'; e.target.value = slugify(e.target.value); }
    if (e.target.id === 'f-name' && !state.isNew) $('#ed-title').textContent = e.target.value || 'Produit';
  });

  /* Complétez le look : produits associés */
  function renderRelated() {
    var p = state.editing;
    var chosen = p.related || [];
    $('#related').innerHTML = state.catalog.products.filter(function (x) { return x.slug !== p.slug; }).map(function (x) {
      return '<label class="chip"><input type="checkbox" value="' + esc(x.slug) + '"' + (chosen.indexOf(x.slug) > -1 ? ' checked' : '') + '><span>' + esc(x.name) + '</span></label>';
    }).join('') || '<p class="muted small">Aucun autre produit pour l’instant.</p>';
  }
  $('#related').addEventListener('change', function () { state.dirty = true; });

  /* Couleurs */
  function renderColors() {
    var p = state.editing;
    $('#colors').innerHTML = p.colors.map(function (c, i) {
      var hasAccent = !!c.accent && c.accent !== c.hex;
      return '<div class="color-row" data-color="' + i + '">' +
        '<input type="color" value="' + esc(c.hex) + '" data-c="hex" aria-label="Teinte">' +
        '<input type="text" value="' + esc(c.name) + '" data-c="name" placeholder="Nom de la couleur" aria-label="Nom de la couleur">' +
        '<label class="accent" title="Deuxième couleur (écusson, détail)"><input type="checkbox" data-c="has-accent"' + (hasAccent ? ' checked' : '') + '> détail <input type="color" data-c="accent" value="' + esc(c.accent || '#f3b9cb') + '"' + (hasAccent ? '' : ' hidden') + '></label>' +
        '<button type="button" class="icon" data-c="remove" aria-label="Retirer cette couleur"' + (p.colors.length < 2 ? ' disabled' : '') + '>✕</button></div>';
    }).join('');
  }
  $('#colors').addEventListener('input', function (e) {
    var row = e.target.closest('[data-color]');
    if (!row) return;
    var c = state.editing.colors[+row.getAttribute('data-color')];
    var field = e.target.getAttribute('data-c');
    var oldName = c.name;
    if (field === 'hex') c.hex = e.target.value;
    if (field === 'name') {
      c.name = e.target.value;
      renameVariant(oldName, c.name);
    }
    if (field === 'accent') c.accent = e.target.value;
    if (field === 'has-accent') {
      c.accent = e.target.checked ? $('[data-c="accent"]', row).value : undefined;
      $('[data-c="accent"]', row).hidden = !e.target.checked;
    }
    if (field === 'name') { renderEditorStock(); renderPhotoVariants(); }
  });
  $('#colors').addEventListener('click', function (e) {
    if (e.target.getAttribute('data-c') !== 'remove') return;
    var i = +e.target.closest('[data-color]').getAttribute('data-color');
    state.editing.colors.splice(i, 1);
    state.dirty = true;
    renderColors(); renderEditorStock(); renderPhotoVariants();
  });
  $('#add-color').addEventListener('click', function () {
    state.editing.colors.push({ name: '', hex: '#ffffff' });
    state.dirty = true;
    renderColors(); renderEditorStock();
    var rows = $$('#colors [data-c="name"]');
    rows[rows.length - 1].focus();
  });
  // garde le stock et les photos associés quand on renomme une couleur
  function renameVariant(oldName, newName) {
    if (oldName === newName) return;
    Object.keys(state.editStock).forEach(function (k) {
      var parts = k.split('|');
      if (parts[0] === oldName) {
        var nk = newName + '|' + parts.slice(1).join('|');
        state.editStock[nk] = state.editStock[k];
        state.stockChanges[nk] = state.editStock[k];
        delete state.editStock[k];
      }
    });
    state.editing.images.forEach(function (im) { if (im.variant === oldName) im.variant = newName; });
  }

  /* Tailles */
  function renderSizes() {
    var p = state.editing;
    $('#sizes').innerHTML = ALL_SIZES.map(function (s) {
      return '<label class="chip"><input type="checkbox" value="' + esc(s) + '"' + (p.sizes.indexOf(s) > -1 ? ' checked' : '') + '><span>' + esc(s) + '</span></label>';
    }).join('');
  }
  $('#sizes').addEventListener('change', function () {
    state.editing.sizes = $$('#sizes input:checked').map(function (i) { return i.value; });
    renderEditorStock();
  });

  /* Stock dans l'éditeur */
  function renderEditorStock() {
    var p = state.editing;
    if (!p.sizes.length || !p.colors.length) { $('#stock-grid').innerHTML = '<p class="muted small">Choisissez au moins une couleur et une taille.</p>'; return; }
    $('#stock-grid').innerHTML = stockTable(p, state.editStock);
  }
  $('#stock-grid').addEventListener('input', function (e) {
    var k = e.target.getAttribute('data-key');
    if (!k) return;
    var v = e.target.value === '' ? null : Math.max(0, parseInt(e.target.value, 10) || 0);
    if (v === null) delete state.editStock[k]; else state.editStock[k] = v;
    state.stockChanges[k] = v;
    e.target.classList.toggle('zero', v === 0);
  });

  /* Photos */
  function renderPhotos() {
    var p = state.editing;
    $('#photos').innerHTML = p.images.map(function (im, i) {
      return '<div class="photo" data-photo="' + i + '">' + (i === 0 ? '<span class="photo__main">Photo principale</span>' : '') +
        '<img src="' + esc(previewSrc(im, p, i)) + '" alt="">' +
        '<div class="photo__body">' +
        '<input type="text" data-p="alt" value="' + esc(im.alt) + '" placeholder="Description de la photo" aria-label="Description de la photo">' +
        '<select data-p="variant" aria-label="Couleur montrée"></select>' +
        '<div class="photo__tools"><button type="button" class="icon" data-p="left" aria-label="Déplacer à gauche"' + (i === 0 ? ' disabled' : '') + '>←</button>' +
        '<button type="button" class="icon" data-p="right" aria-label="Déplacer à droite"' + (i === p.images.length - 1 ? ' disabled' : '') + '>→</button>' +
        '<button type="button" class="icon" data-p="remove" aria-label="Supprimer la photo">🗑</button></div></div></div>';
    }).join('') || '<p class="muted small">Aucune photo pour l’instant.</p>';
    renderPhotoVariants();
  }
  function renderPhotoVariants() {
    var p = state.editing;
    $$('#photos [data-p="variant"]').forEach(function (sel) {
      var im = p.images[+sel.closest('[data-photo]').getAttribute('data-photo')];
      sel.innerHTML = '<option value="">Couleur : toutes</option>' + p.colors.map(function (c) {
        return '<option value="' + esc(c.name) + '"' + (im.variant === c.name ? ' selected' : '') + '>Couleur : ' + esc(c.name) + '</option>';
      }).join('');
    });
  }
  $('#photos').addEventListener('input', function (e) {
    var box = e.target.closest('[data-photo]');
    if (!box) return;
    var im = state.editing.images[+box.getAttribute('data-photo')];
    if (e.target.getAttribute('data-p') === 'alt') im.alt = e.target.value;
    if (e.target.getAttribute('data-p') === 'variant') { if (e.target.value) im.variant = e.target.value; else delete im.variant; }
  });
  $('#photos').addEventListener('click', function (e) {
    var action = e.target.getAttribute('data-p');
    if (!action || ['left', 'right', 'remove'].indexOf(action) === -1) return;
    var imgs = state.editing.images;
    var i = +e.target.closest('[data-photo]').getAttribute('data-photo');
    if (action === 'remove') { if (!confirm('Retirer cette photo du produit ?')) return; imgs.splice(i, 1); }
    if (action === 'left' && i > 0) imgs.splice(i - 1, 0, imgs.splice(i, 1)[0]);
    if (action === 'right' && i < imgs.length - 1) imgs.splice(i + 1, 0, imgs.splice(i, 1)[0]);
    state.dirty = true;
    renderPhotos();
  });

  // Redimensionne une image dans le navigateur (JPEG, grand côté = max px)
  function resize(bitmap, max) {
    var scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    var c = document.createElement('canvas');
    c.width = Math.round(bitmap.width * scale);
    c.height = Math.round(bitmap.height * scale);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    return new Promise(function (res) { c.toBlob(res, 'image/jpeg', max > 1000 ? 0.82 : 0.78); });
  }
  // Redimensionne puis envoie une photo (2 tailles). Renvoie son chemin, ex. « uploads/polo-ab12cd.jpg »
  function uploadPhoto(file, base) {
    var name = (slugify(base || 'photo') || 'photo') + '-' + Math.random().toString(36).slice(2, 8);
    return decode(file).then(function (bmp) {
      return Promise.all([resize(bmp, 1600), resize(bmp, 720)]);
    }).then(function (blobs) {
      return api('POST', '/api/admin/upload?name=' + name + '.jpg', blobs[0], true)
        .then(function () { return api('POST', '/api/admin/upload?name=' + name + '-720.jpg', blobs[1], true); });
    }).then(function () {
      if (state.uploads) state.uploads.unshift(name + '.jpg');
      return 'uploads/' + name + '.jpg';
    });
  }
  function decode(file) {
    if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(file); });
    return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = URL.createObjectURL(file); });
  }
  $('#upload').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    var p = readForm();
    var base = slugify(p.slug || p.name || 'produit') || 'produit';
    var status = $('#upload-status');
    var done = 0;
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        status.textContent = 'Envoi de la photo ' + (done + 1) + ' / ' + files.length + '…';
        return uploadPhoto(file, base).then(function (src) {
          state.editing.images.push({ src: src, alt: p.name || '' });
          state.dirty = true;
          done++;
          renderPhotos();
        }).catch(function (err) {
          toast('« ' + file.name + ' » : ' + (err.message || 'format non pris en charge'), true);
        });
      });
    });
    chain.then(function () { status.textContent = done ? done + ' photo(s) ajoutée(s). Pensez à enregistrer.' : ''; });
  });

  /* Enregistrement */
  function saveCatalog(catalog, stockChanges, successMsg) {
    return api('PUT', '/api/admin/catalog', { catalog: catalog, stock: stockChanges }).then(function (d) {
      state.catalog = catalog;
      state.stock = d.stock || state.stock;
      state.dirty = false;
      if (d.publish) setPublish(d.publish);
      toast(successMsg + ' Cliquez sur « Publier » quand vous avez terminé vos modifications.');
      return d;
    });
  }

  ed.addEventListener('submit', function (e) {
    e.preventDefault();
    var p = readForm();
    var err = $('#ed-error');
    var fail = function (m) { err.textContent = m; err.hidden = false; window.scrollTo(0, 0); };
    err.hidden = true;
    p.colors.forEach(function (c) { c.name = c.name.trim(); if (!c.accent) delete c.accent; });
    if (!p.name) return fail('Indiquez le nom du produit.');
    if (!p.slug) return fail('Indiquez l’adresse de la page.');
    if (!p.price) return fail('Indiquez un prix.');
    if (!p.short) return fail('Rédigez un résumé d’une phrase.');
    if (!p.sizes.length) return fail('Cochez au moins une taille.');
    if (p.colors.some(function (c) { return !c.name; })) return fail('Donnez un nom à chaque couleur.');
    if (!p.images.length && !confirm('Ce produit n’a pas de photo. Enregistrer quand même ?')) return;
    var catalog = JSON.parse(JSON.stringify(state.catalog));
    if (state.isNew) {
      if (catalog.products.some(function (x) { return x.slug === p.slug; })) return fail('Un produit utilise déjà cette adresse.');
      catalog.products.push(p);
    } else {
      catalog.products[state.index] = p;
    }
    // le stock complet du produit est envoyé à la création, seulement les cases modifiées sinon
    var changes = {};
    changes[p.slug] = state.isNew ? state.editStock : state.stockChanges;
    var btn = $('button[type="submit"]', ed);
    btn.disabled = true;
    saveCatalog(catalog, changes, 'Produit enregistré.').then(function () {
      state.isNew = false;
      showTab('products');
    }).catch(function (ex) { fail(ex.message); }).then(function () { btn.disabled = false; });
  });

  $('#ed-delete').addEventListener('click', function () {
    var p = state.editing;
    if (!confirm('Supprimer définitivement « ' + p.name + ' » de la boutique ?')) return;
    var catalog = JSON.parse(JSON.stringify(state.catalog));
    catalog.products.splice(state.index, 1);
    saveCatalog(catalog, {}, 'Produit supprimé.').then(function () { showTab('products'); })
      .catch(function (ex) { toast(ex.message, true); });
  });
  $('[data-back]').addEventListener('click', function () { showTab('products'); });

  /* ---------- Stock global ---------- */
  var stockChanges = {};
  function renderStockAll() {
    stockChanges = {};
    $('#save-stock').disabled = true;
    var box = $('#stock-all');
    if (!state.catalog) return;
    box.innerHTML = state.catalog.products.map(function (p) {
      return '<div class="stock-product" data-slug="' + esc(p.slug) + '"><h2>' + esc(p.name) + ' ' + stockSummary(p) + '</h2><div class="table-wrap">' + stockTable(p, state.stock[p.slug]) + '</div></div>';
    }).join('');
  }
  $('#stock-all').addEventListener('input', function (e) {
    var k = e.target.getAttribute('data-key');
    if (!k) return;
    var slug = e.target.closest('[data-slug]').getAttribute('data-slug');
    var v = e.target.value === '' ? null : Math.max(0, parseInt(e.target.value, 10) || 0);
    stockChanges[slug] = stockChanges[slug] || {};
    stockChanges[slug][k] = v;
    e.target.classList.add('dirty');
    e.target.classList.toggle('zero', v === 0);
    $('#save-stock').disabled = false;
    state.dirty = true;
  });
  $('#save-stock').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    api('PATCH', '/api/admin/catalog', { stock: stockChanges }).then(function (d) {
      state.stock = d.stock;
      state.dirty = false;
      toast('Stock enregistré. Il est déjà à jour sur le site.');
      renderStockAll();
    }).catch(function (ex) { toast(ex.message, true); btn.disabled = false; });
  });

  /* ---------- Commandes : liste et suivi ---------- */
  var ZONES = { metro: 'Colissimo France', domtom: 'Colissimo DOM-TOM', retrait: 'Retrait en boutique' };
  var STATUTS = [['a_preparer', 'À préparer'], ['prete', 'Prête en boutique'], ['expediee', 'Expédiée'], ['livree', 'Livrée / retirée'], ['annulee', 'Annulée']];
  var statutLabel = function (s) { var x = STATUTS.filter(function (y) { return y[0] === s; })[0]; return x ? x[1] : s; };
  var orderFilter = 'a_traiter';
  var ordersCache = [];
  var trackUrl = function (n) { return 'https://www.laposte.fr/outils/suivre-vos-envois?code=' + encodeURIComponent(n); };

  // E-mail pré-rédigé pour prévenir le client (s'ouvre dans la messagerie de la boutique)
  function mailtoFor(o) {
    var prenom = (o.client.nom || '').split(' ')[0];
    var hello = 'Bonjour' + (prenom ? ' ' + prenom : '') + ',\n\n';
    var sign = '\n\nÀ très bientôt,\nL’équipe Eden Park Arcachon\n' + (state.site ? state.site.phone : '');
    var subject, body;
    if (o.statut === 'expediee') {
      subject = 'Votre commande Eden Park Arcachon est en route';
      body = hello + 'Bonne nouvelle : votre commande vient d’être expédiée en Colissimo.' +
        (o.suivi ? '\n\nNuméro de suivi : ' + o.suivi + '\nSuivre votre colis : ' + trackUrl(o.suivi) : '') + sign;
    } else if (o.statut === 'prete') {
      subject = 'Votre commande Eden Park Arcachon vous attend en boutique';
      body = hello + 'Votre commande est prête ! Vous pouvez la retirer à la boutique' +
        (state.site ? ', ' + state.site.address.street + ' à ' + state.site.address.city : '') + ', aux horaires d’ouverture, sur présentation de votre e-mail de confirmation.' + sign;
    } else {
      subject = 'Votre commande Eden Park Arcachon';
      body = hello + sign;
    }
    return 'mailto:' + encodeURIComponent(o.client.email || '') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  function updateOrdersCount() {
    var n = ordersCache.filter(function (o) { return o.statut === 'a_preparer'; }).length;
    var c = $('#orders-count');
    c.hidden = !n;
    c.textContent = n;
  }

  function renderOrders() {
    var box = $('#orders');
    var filters = [['a_traiter', 'À traiter'], ['tout', 'Toutes']].concat(STATUTS);
    var list = ordersCache.filter(function (o) {
      if (orderFilter === 'tout') return true;
      if (orderFilter === 'a_traiter') return o.statut === 'a_preparer' || o.statut === 'prete';
      return o.statut === orderFilter;
    });
    var html = '<div class="order-filters">' + filters.map(function (f) {
      var n = ordersCache.filter(function (o) { return f[0] === 'tout' || (f[0] === 'a_traiter' ? (o.statut === 'a_preparer' || o.statut === 'prete') : o.statut === f[0]); }).length;
      return '<button type="button" data-filter="' + f[0] + '" aria-current="' + (orderFilter === f[0]) + '">' + f[1] + ' (' + n + ')</button>';
    }).join('') + '</div>';
    if (!ordersCache.length) { box.innerHTML = '<p class="empty">Aucune commande pour le moment.</p>'; return; }
    if (!list.length) { box.innerHTML = html + '<p class="empty">Aucune commande dans cette catégorie.</p>'; return; }
    box.innerHTML = html + list.map(function (o) {
      var date = new Date(o.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
      var items = o.articles.map(function (a) {
        var p = state.catalog.products.filter(function (x) { return x.slug === a.slug; })[0];
        return '<li>' + a.qty + ' × ' + esc(p ? p.name : a.slug) + ' – ' + esc(a.color) + (a.size !== 'Taille unique' ? ' – ' + esc(a.size) : '') +
          (a.surCommande ? ' <span class="tag tag--late">sur commande</span>' : '') + '</li>';
      }).join('');
      var addr = o.adresse ? [o.adresse.line1, o.adresse.line2, (o.adresse.postal_code || '') + ' ' + (o.adresse.city || ''), o.adresse.country].filter(Boolean).map(esc).join(', ') : '';
      var opts = STATUTS.map(function (s) { return '<option value="' + s[0] + '"' + (o.statut === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('');
      var canNotify = o.client.email && (o.statut === 'expediee' || o.statut === 'prete');
      return '<div class="order" data-order="' + esc(o.id) + '">' +
        '<div><strong>' + esc(date) + '</strong><br><span class="st st--' + esc(o.statut) + '">' + esc(statutLabel(o.statut)) + '</span><br><span class="muted small">' + esc(ZONES[o.zone] || o.zone || '') + '</span>' +
        (o.surCommande ? '<br><span class="tag tag--late">Délai ' + state.backorderDays + ' jours</span>' : '') + '</div>' +
        '<div><strong>' + esc(o.client.nom) + '</strong> · <a href="mailto:' + esc(o.client.email) + '">' + esc(o.client.email) + '</a> ' + esc(o.client.telephone) +
        (addr ? '<br><span class="muted small">' + addr + '</span>' : '') + '<ul>' + items + '</ul>' +
        (o.cadeau ? '<p class="gift-tag">🎁 <strong>Emballage cadeau</strong>' + (o.messageCadeau ? ' · message : « ' + esc(o.messageCadeau) + ' »' : '') + '</p>' : '') +
        (o.promo ? '<span class="tag">Code ' + esc(o.promo) + (o.remise ? ' : −' + euro(o.remise) : '') + '</span>' : '') + '</div>' +
        '<div class="order__total">' + euro(o.total || 0) + '</div>' +
        '<div class="order__track">' +
        '<label>Statut<select data-f="statut">' + opts + '</select></label>' +
        (o.zone === 'retrait' ? '<span></span>' : '<label>N° de suivi Colissimo<input data-f="suivi" value="' + esc(o.suivi) + '" placeholder="ex. 6A12345678901"></label>') +
        '<label>Note interne<input data-f="note" value="' + esc(o.note) + '" placeholder="ex. préparée par Léa"></label>' +
        '<div class="order__actions"><button type="button" class="btn btn--sm" data-save-order>Enregistrer</button>' +
        (canNotify ? '<a class="btn btn--ghost btn--sm" href="' + esc(mailtoFor(o)) + '">Prévenir le client ✉</a>' : '') +
        (o.suivi ? '<a class="btn btn--ghost btn--sm" href="' + esc(trackUrl(o.suivi)) + '" target="_blank" rel="noopener">Suivi ↗</a>' : '') + '</div>' +
        '</div></div>';
    }).join('');
  }

  function loadOrders() {
    var box = $('#orders');
    if (!ordersCache.length) box.innerHTML = '<p class="muted">Chargement…</p>';
    return api('GET', '/api/admin/orders').then(function (d) {
      ordersCache = d.orders;
      updateOrdersCount();
      renderOrders();
    }).catch(function (ex) { box.innerHTML = '<p class="error">' + esc(ex.message) + '</p>'; });
  }
  $('#refresh-orders').addEventListener('click', loadOrders);
  $('#orders').addEventListener('click', function (e) {
    var f = e.target.closest('[data-filter]');
    if (f) { orderFilter = f.getAttribute('data-filter'); renderOrders(); return; }
    var b = e.target.closest('[data-save-order]');
    if (!b) return;
    var card = b.closest('[data-order]');
    var body = { id: card.getAttribute('data-order') };
    $$('[data-f]', card).forEach(function (inp) { body[inp.getAttribute('data-f')] = inp.value; });
    if (body.statut === 'expediee' && !body.suivi && !confirm('Aucun numéro de suivi saisi. Enregistrer quand même ?')) return;
    b.disabled = true;
    api('PATCH', '/api/admin/orders', body).then(function (d) {
      ordersCache = ordersCache.map(function (o) { return o.id === d.order.id ? d.order : o; });
      updateOrdersCount();
      renderOrders();
      var canNotify = d.order.client.email && (d.order.statut === 'expediee' || d.order.statut === 'prete');
      toast('Commande mise à jour.' + (canNotify ? ' Cliquez sur « Prévenir le client » pour lui envoyer un e-mail.' : ''));
    }).catch(function (ex) { toast(ex.message, true); b.disabled = false; });
  });

  /* =====================================================================
     Médiathèque : choisir une photo existante ou en envoyer une nouvelle
     ===================================================================== */
  var picker = $('#picker');
  var pickerCallback = null;
  var libraryCache = null;
  function openPicker(callback, uploadBase) {
    pickerCallback = callback;
    picker.dataset.base = uploadBase || 'photo';
    $('#picker-status').textContent = '';
    var grid = $('#picker-grid');
    grid.innerHTML = '<p class="muted">Chargement…</p>';
    if (picker.showModal) picker.showModal(); else picker.setAttribute('open', '');
    var lib = libraryCache ? Promise.resolve(libraryCache)
      : fetch('/assets/img/library.json').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    lib.then(function (items) {
      libraryCache = items;
      var seen = {};
      var all = (state.uploads || []).map(function (n) { return { src: 'uploads/' + n }; }).concat(items);
      grid.innerHTML = all.filter(function (it) {
        var k = it.src.split('/').pop();
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      }).map(function (it) {
        var th = it.thumb ? '/assets/img/' + it.thumb : thumbOf(it.src);
        return '<button type="button" data-pick="' + esc(it.src) + '" title="' + esc(it.src.split('/').pop()) + '"><img src="' + esc(th) + '" alt="" loading="lazy"></button>';
      }).join('') || '<p class="muted">Aucune photo pour l’instant. Envoyez-en une !</p>';
    });
  }
  function closePicker() { if (picker.close) picker.close(); else picker.removeAttribute('open'); pickerCallback = null; }
  $('#picker-grid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pick]');
    if (!b || !pickerCallback) return;
    var cb = pickerCallback;
    closePicker();
    cb(b.getAttribute('data-pick'));
  });
  $('[data-picker-close]').addEventListener('click', closePicker);
  $('#picker-upload').addEventListener('change', function (e) {
    var file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#picker-status').textContent = 'Envoi de la photo…';
    uploadPhoto(file, picker.dataset.base).then(function (src) {
      var cb = pickerCallback;
      closePicker();
      if (cb) cb(src);
      toast('Photo envoyée. Pensez à enregistrer.');
    }).catch(function (err) { $('#picker-status').textContent = 'Échec : ' + err.message; });
  });
  $('#pick-product-photo').addEventListener('click', function () {
    var p = readForm();
    openPicker(function (src) {
      state.editing.images.push({ src: src, alt: p.name || '' });
      state.dirty = true;
      renderPhotos();
    }, p.slug || p.name);
  });

  /* =====================================================================
     Moteur de formulaires (Pages, Catégories, Réglages)
     Chaque champ est lié à obj[key] : la saisie modifie directement le brouillon.
     ===================================================================== */
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  var uid = 0;
  function markDirty() { state.dirty = true; }

  function fieldEl(obj, def) {
    var id = 'g' + (++uid);
    var label = el('label', { for: id, text: def.label });
    var input;
    var val = obj[def.k];
    switch (def.type) {
      case 'textarea':
      case 'paragraphs':
      case 'lines':
        input = el('textarea', { id: id, rows: def.rows || (def.type === 'lines' ? 4 : 4) });
        input.value = def.type === 'paragraphs' ? (val || []).join('\n\n') : def.type === 'lines' ? (val || []).join('\n') : (val || '');
        input.addEventListener('input', function () {
          var v = input.value;
          obj[def.k] = def.type === 'paragraphs' ? v.split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean)
            : def.type === 'lines' ? v.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : v;
          markDirty();
        });
        break;
      case 'euro':
        input = el('input', { id: id, type: 'number', min: '0', step: '0.01', inputmode: 'decimal' });
        input.value = typeof val === 'number' ? (val / 100).toFixed(2) : '';
        input.addEventListener('input', function () { obj[def.k] = Math.round(parseFloat(input.value.replace(',', '.')) * 100) || 0; markDirty(); });
        break;
      case 'int':
        input = el('input', { id: id, type: 'number', min: String(def.min || 0), step: '1', inputmode: 'numeric' });
        input.value = typeof val === 'number' ? val : '';
        input.addEventListener('input', function () { obj[def.k] = parseInt(input.value, 10) || 0; markDirty(); });
        break;
      case 'bool':
        input = el('input', { id: id, type: 'checkbox' });
        input.checked = !!val;
        input.addEventListener('change', function () { obj[def.k] = input.checked; markDirty(); });
        var row = el('label', { class: 'check', for: id }, [input, el('span', { text: def.label })]);
        return el('div', { class: 'field' }, def.help ? [row, el('small', { text: def.help })] : [row]);
      case 'checks':
        if (!Array.isArray(obj[def.k])) obj[def.k] = [];
        var group = el('div', { class: 'chips' });
        (typeof def.options === 'function' ? def.options() : def.options).forEach(function (o) {
          var cb = el('input', { type: 'checkbox', value: o[0] });
          cb.checked = obj[def.k].indexOf(o[0]) > -1;
          cb.addEventListener('change', function () {
            obj[def.k] = $$('input', group).filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
            markDirty();
          });
          group.appendChild(el('label', { class: 'chip' }, [cb, el('span', { text: o[1] })]));
        });
        var fc = el('div', { class: 'field' }, [el('label', { text: def.label }), group]);
        if (def.help) fc.appendChild(el('small', { text: def.help }));
        return fc;
      case 'select':
        input = el('select', { id: id });
        def.options.forEach(function (o) { input.appendChild(el('option', { value: o[0], text: o[1] })); });
        input.value = val || def.options[0][0];
        input.addEventListener('change', function () { obj[def.k] = input.value; markDirty(); });
        break;
      default:
        input = el('input', { id: id, type: def.type === 'link' ? 'text' : (def.type || 'text') });
        if (def.placeholder) input.placeholder = def.placeholder;
        input.value = val == null ? '' : val;
        if (def.readonly) input.readOnly = true;
        input.addEventListener('input', function () { obj[def.k] = input.value; markDirty(); if (def.onInput) def.onInput(input.value); });
    }
    var f = el('div', { class: 'field' }, [label, input]);
    if (def.help) f.appendChild(el('small', { text: def.help }));
    return f;
  }

  // Photo : objet { src, alt } (mode "image") ou simple chemin (mode "imagepath")
  function imageEl(obj, def) {
    var isPath = def.type === 'imagepath';
    if (!isPath && !obj[def.k]) obj[def.k] = { src: '', alt: '' };
    var get = function () { return isPath ? obj[def.k] : obj[def.k].src; };
    var set = function (src) { if (isPath) obj[def.k] = src; else obj[def.k].src = src; };
    var img = el('img', { alt: '', src: thumbOf(get()) || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' });
    var change = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Changer la photo' });
    var pick = function () {
      openPicker(function (src) { set(src); img.src = thumbOf(src); markDirty(); }, def.base || def.label);
    };
    change.addEventListener('click', pick);
    img.addEventListener('click', pick);
    var right = [el('div', { class: 'field' }, [el('label', { text: def.label })]), change];
    if (def.optional) {
      var rm = el('button', { type: 'button', class: 'link', text: 'Retirer', style: 'margin-left:10px' });
      rm.addEventListener('click', function () { set(''); img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; markDirty(); });
      right.push(rm);
    }
    if (!isPath) {
      var altDef = { k: 'alt', label: 'Description de la photo (pour Google)' };
      right.push(fieldEl(obj[def.k], altDef));
    }
    return el('div', { class: 'imgfield' }, [img, el('div', {}, right)]);
  }

  function listEl(obj, def) {
    if (!Array.isArray(obj[def.k])) obj[def.k] = [];
    var arr = obj[def.k];
    var box = el('div', {});
    function render() {
      box.innerHTML = '';
      arr.forEach(function (item, i) {
        var tools = el('div', {});
        [['↑', -1], ['↓', 1]].forEach(function (m) {
          var b = el('button', { type: 'button', class: 'icon', text: m[0], 'aria-label': m[1] < 0 ? 'Monter' : 'Descendre' });
          if ((m[1] < 0 && i === 0) || (m[1] > 0 && i === arr.length - 1)) b.disabled = true;
          b.addEventListener('click', function () { arr.splice(i + m[1], 0, arr.splice(i, 1)[0]); markDirty(); render(); });
          tools.appendChild(b);
        });
        var del = el('button', { type: 'button', class: 'icon', text: '✕', 'aria-label': 'Supprimer' });
        if (def.min && arr.length <= def.min) del.disabled = true;
        del.addEventListener('click', function () {
          if (def.canDelete && !def.canDelete(item)) return;
          if (!confirm('Supprimer cet élément ?')) return;
          arr.splice(i, 1); markDirty(); render();
        });
        tools.appendChild(del);
        var title = (def.itemTitle ? def.itemTitle(item, i) : (def.itemLabel || 'Élément') + ' ' + (i + 1));
        var card = el('div', { class: 'list-item' }, [el('div', { class: 'list-item__head' }, [el('span', { text: title }), tools])]);
        renderFieldsInto(card, item, def.fields);
        box.appendChild(card);
      });
      if (!def.max || arr.length < def.max) {
        var add = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: '+ ' + (def.addLabel || 'Ajouter') });
        add.addEventListener('click', function () { arr.push(JSON.parse(JSON.stringify(def.template))); markDirty(); render(); });
        box.appendChild(add);
      }
    }
    render();
    return el('div', { class: 'field' }, [el('label', { text: def.label }), box]);
  }

  function renderFieldsInto(container, obj, fields) {
    fields.forEach(function (def) {
      if (def.type === 'group') {
        var target = def.k ? (obj[def.k] = obj[def.k] || {}) : obj;
        var card = el('fieldset', { class: 'card' }, [el('legend', { text: def.label })]);
        if (def.help) card.appendChild(el('p', { class: 'muted small', text: def.help }));
        renderFieldsInto(card, target, def.fields);
        container.appendChild(card);
      } else if (def.type === 'image' || def.type === 'imagepath') container.appendChild(imageEl(obj, def));
      else if (def.type === 'list') container.appendChild(listEl(obj, def));
      else if (def.type === 'hours') container.appendChild(hoursEl(obj, def));
      else container.appendChild(fieldEl(obj, def));
    });
  }

  /* ---------- Pages & photos ---------- */
  var IMG = function (k, label) { return { k: k, type: 'image', label: label || 'Photo' }; };
  var TOKENS_HELP = 'Astuce : ces mots entre accolades sont remplacés automatiquement par les valeurs des Réglages : {livraison_offerte}, {prix_livraison}, {prix_domtom}, {delai_france}, {delai_domtom}, {delai_retour}, {delai_sur_commande}, {telephone}, {email}.';
  var LOOK = [IMG('__self', 'Photo'), { k: 'title', label: 'Titre (sur la photo)' }, { k: 'subtitle', label: 'Sous-titre' }];
  var PAGES = [
    { id: 'home', label: 'Accueil', root: 'home', fields: [
      { type: 'group', k: 'hero', label: 'Grande bannière (haut de page)', fields: [
        IMG('image', 'Photo de fond'),
        { k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }, { k: 'accent', label: 'Titre en italique rose' },
        { k: 'text', type: 'textarea', label: 'Texte' },
        { k: 'cta1_label', label: 'Bouton 1 : texte' }, { k: 'cta1_link', type: 'link', label: 'Bouton 1 : lien', help: 'Page du site (ex. /boutique/polos/) ou adresse https://' },
        { k: 'cta2_label', label: 'Bouton 2 : texte (vide = pas de bouton)' }, { k: 'cta2_link', type: 'link', label: 'Bouton 2 : lien' }] },
      { type: 'group', label: 'Titres des sections', fields: [
        { type: 'group', k: 'universes', label: 'Nos univers (catégories)', fields: [{ k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }] },
        { type: 'group', k: 'featured', label: 'Produits mis en avant', help: 'Les produits affichés sont ceux cochés « Mettre en avant » dans l’onglet Produits.', fields: [{ k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }] }] },
      { type: 'group', k: 'story', label: 'Notre histoire', fields: [
        IMG('image'), { k: 'tag', label: 'Étiquette rose sur la photo (vide = aucune)' },
        { k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }, { k: 'lead', type: 'textarea', label: 'Chapeau' },
        { k: 'text', type: 'textarea', label: 'Texte', rows: 5 }, { k: 'button_label', label: 'Texte du bouton' }] },
      { type: 'list', k: 'emblems', label: 'Emblèmes du Bassin', itemLabel: 'Emblème', max: 6, addLabel: 'Ajouter un emblème',
        template: { icon: 'dune', title: '', text: '' },
        fields: [{ k: 'icon', type: 'select', label: 'Dessin', options: [['dune', 'Dune'], ['whale', 'Queue de baleine'], ['pine', 'Pin']] }, { k: 'title', label: 'Titre' }, { k: 'text', type: 'textarea', label: 'Texte', rows: 2 }] },
      { type: 'group', k: 'perso', label: 'Personnalisation', fields: [
        IMG('image'), { k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }, { k: 'lead', type: 'textarea', label: 'Texte' },
        { k: 'points', type: 'lines', label: 'Points forts (un par ligne)' }, { k: 'button_label', label: 'Texte du bouton' }] },
      { type: 'group', k: 'store', label: 'La boutique', fields: [
        IMG('image'), { k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }, { k: 'text', type: 'textarea', label: 'Texte' }] },
      { type: 'group', k: 'instagram', label: 'Instagram', fields: [
        { k: 'title', label: 'Titre' }, { k: 'text', type: 'textarea', label: 'Texte' },
        { type: 'list', k: 'images', label: 'Photos (6 conseillées)', itemLabel: 'Photo', max: 12, addLabel: 'Ajouter une photo', template: { src: '', alt: '' }, fields: [IMG('__self')] }] }
    ] },
    { id: 'collection', label: 'Notre collection', root: 'collection', fields: [
      { type: 'group', label: 'En-tête', fields: [{ k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }, { k: 'lead', type: 'textarea', label: 'Introduction' }] },
      { type: 'group', label: 'Grandes photos', fields: [
        { type: 'list', k: 'hero_looks', label: 'Silhouettes (2 conseillées)', itemLabel: 'Silhouette', max: 4, addLabel: 'Ajouter une silhouette', template: { src: '', alt: '', title: '', subtitle: '' }, fields: LOOK },
        { k: 'hero_button_label', label: 'Texte du bouton (vide = pas de bouton)' }, { k: 'hero_button_link', type: 'link', label: 'Lien du bouton' }] },
      { type: 'group', k: 'story', label: 'L’histoire', fields: [
        IMG('image'), { k: 'tag', label: 'Étiquette rose sur la photo' }, { k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' },
        { k: 'paragraphs', type: 'paragraphs', label: 'Texte', rows: 8, help: 'Laissez une ligne vide entre deux paragraphes.' }] },
      { type: 'group', k: 'season', label: 'Essentiels de la saison', fields: [
        { k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }, { k: 'lead', type: 'textarea', label: 'Texte' },
        { type: 'list', k: 'looks', label: 'Photos', itemLabel: 'Photo', max: 12, addLabel: 'Ajouter une photo', template: { src: '', alt: '', title: '', subtitle: '' }, fields: LOOK }] }
    ] },
    { id: 'boutique', label: 'La boutique d’Arcachon', root: 'boutique', fields: [
      { type: 'group', label: 'En-tête', fields: [{ k: 'eyebrow', label: 'Petit titre' }, { k: 'title', label: 'Titre' }, { k: 'lead', type: 'textarea', label: 'Introduction' }] },
      { type: 'group', label: 'Photos de la boutique', fields: [
        { type: 'list', k: 'photos', label: 'Photos (2 conseillées)', itemLabel: 'Photo', max: 6, addLabel: 'Ajouter une photo', template: { src: '', alt: '' }, fields: [IMG('__self')] }] },
      { type: 'group', label: 'Informations', fields: [{ k: 'access', type: 'textarea', label: 'Accès (parking, gare…)', rows: 4 }] },
      { type: 'list', k: 'services', label: 'Services en boutique', itemLabel: 'Service', max: 6, addLabel: 'Ajouter un service', template: { title: '', text: '' },
        fields: [{ k: 'title', label: 'Titre' }, { k: 'text', type: 'textarea', label: 'Texte', rows: 2 }] }
    ] },
    { id: 'faq', label: 'FAQ', root: 'faq', fields: [
      { type: 'group', label: 'En-tête', help: TOKENS_HELP, fields: [{ k: 'title', label: 'Titre' }, { k: 'lead', type: 'textarea', label: 'Introduction', rows: 2 }] },
      { type: 'group', label: 'Guide des tailles', fields: [{ k: 'size_intro', type: 'textarea', label: 'Texte avant le tableau', rows: 3 }, { k: 'size_note', type: 'textarea', label: 'Texte après le tableau', rows: 2 }] },
      { type: 'list', k: 'sections', label: 'Rubriques et questions', itemLabel: 'Rubrique', addLabel: 'Ajouter une rubrique',
        itemTitle: function (s) { return (s.title || 'Nouvelle rubrique') + ' · ' + (s.questions || []).length + ' question(s)'; },
        template: { title: '', questions: [{ q: '', a: '' }] },
        fields: [
          { k: 'title', label: 'Nom de la rubrique' },
          { type: 'list', k: 'questions', label: 'Questions', itemLabel: 'Question', addLabel: 'Ajouter une question', template: { q: '', a: '' },
            itemTitle: function (x, i) { return (i + 1) + '. ' + (x.q ? x.q.slice(0, 70) : 'Nouvelle question'); },
            fields: [{ k: 'q', label: 'Question' }, { k: 'a', type: 'textarea', label: 'Réponse', rows: 3 }] }
        ] }
    ] },
    { id: 'journal', label: 'Journal (articles)', root: null, fields: [
      { type: 'group', k: 'journal_intro', label: 'Page « Le Journal »', fields: [{ k: 'title', label: 'Titre' }, { k: 'lead', type: 'textarea', label: 'Introduction', rows: 2 }] },
      { type: 'list', k: 'journal', label: 'Articles', itemLabel: 'Article', addLabel: 'Écrire un nouvel article',
        itemTitle: function (a) { return (a.title || 'Nouvel article') + (a.published === false ? ' · brouillon' : '') + (a.date ? ' · ' + a.date : ''); },
        template: { slug: '', title: '', date: '', excerpt: '', image: { src: '', alt: '' }, published: false, body: '' },
        fields: [
          { k: 'title', label: 'Titre de l’article' },
          { k: 'date', type: 'date', label: 'Date de publication' },
          { k: 'published', type: 'bool', label: 'Publié (décoché = brouillon, invisible sur le site)' },
          IMG('image', 'Photo principale'),
          { k: 'excerpt', type: 'textarea', label: 'Résumé (affiché dans la liste et sur Google)', rows: 2 },
          { k: 'body', type: 'textarea', label: 'Texte de l’article', rows: 16,
            help: 'Mise en forme : laissez une ligne vide entre deux paragraphes. « ## Mon intertitre » pour un intertitre, « - » en début de ligne pour une liste, **texte** pour du gras, [texte du lien](/boutique/) pour un lien. Les mots magiques ({telephone}, {delai_retour}…) fonctionnent aussi.' }
        ] }
    ] },
    { id: 'general', label: 'Bandeau & pied de page', root: null, fields: [
      { type: 'group', label: 'Bandeau d’annonce (tout en haut du site)', fields: [{ k: 'announcement', type: 'lines', label: 'Messages (un par ligne, 3 maximum conseillés)', help: TOKENS_HELP }] },
      { type: 'group', label: 'Pied de page', fields: [{ k: 'footer_text', type: 'textarea', label: 'Texte de présentation' }] }
    ] }
  ];
  // Une photo « __self » désigne l'élément de liste lui-même ({ src, alt, … })
  var baseImageEl = imageEl;
  imageEl = function (obj, def) {
    if (def.k !== '__self') return baseImageEl(obj, def);
    var holder = { __self: obj };
    return baseImageEl(holder, def);
  };

  var pageTab = 'home';
  function renderPages() {
    if (!state.content) return;
    state.pagesDraft = JSON.parse(JSON.stringify(state.content));
    var nav = $('#page-subtabs');
    nav.innerHTML = '';
    PAGES.forEach(function (pg) {
      var b = el('button', { type: 'button', text: pg.label, 'aria-current': pg.id === pageTab ? 'true' : 'false' });
      b.addEventListener('click', function () { pageTab = pg.id; renderPageForm(); $$('button', nav).forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); }); });
      nav.appendChild(b);
    });
    renderPageForm();
  }
  function renderPageForm() {
    var pg = PAGES.filter(function (x) { return x.id === pageTab; })[0];
    var box = $('#pages-form');
    box.innerHTML = '';
    var grid = el('div', { class: 'form-grid' });
    var target = pg.root ? state.pagesDraft[pg.root] : state.pagesDraft;
    renderFieldsInto(grid, target, pg.fields.filter(function (f) { return f.type === 'group'; }));
    box.appendChild(grid);
    var others = pg.fields.filter(function (f) { return f.type !== 'group'; });
    if (others.length) {
      var card = el('div', { class: 'card' });
      renderFieldsInto(card, target, others);
      box.appendChild(card);
    }
  }

  /* ---------- Catégories ---------- */
  function renderCategories() {
    if (!state.catalog) return;
    state.catsDraft = JSON.parse(JSON.stringify(state.catalog.categories));
    var existing = state.catsDraft.map(function (c) { return c.slug; });
    var box = $('#categories-form');
    box.innerHTML = '';
    var holder = { cats: state.catsDraft };
    var countOf = function (slug) { return state.catalog.products.filter(function (p) { return p.category === slug; }).length; };
    box.appendChild(listEl(holder, {
      k: 'cats', label: '', min: 1, addLabel: 'Ajouter une catégorie',
      template: { slug: '', name: '', title: '', intro: '', meta_title: '', meta_description: '', image: '' },
      itemTitle: function (c) { var n = countOf(c.slug); return (c.name || 'Nouvelle catégorie') + (c.slug && n ? ' · ' + n + ' produit' + (n > 1 ? 's' : '') : ''); },
      canDelete: function (c) {
        var n = countOf(c.slug);
        if (n) { alert('Cette catégorie contient ' + n + ' produit(s). Déplacez-les d’abord dans une autre catégorie.'); return false; }
        return true;
      },
      fields: [
        { k: 'name', label: 'Nom (menu et filtres) *' },
        { k: 'title', label: 'Titre de la page', help: 'Ex. « Polos brodés Bassin d’Arcachon »' },
        { k: 'intro', type: 'textarea', label: 'Texte d’introduction', rows: 3 },
        { k: 'image', type: 'imagepath', label: 'Photo (page d’accueil)', optional: true },
        { k: 'meta_title', label: 'Titre pour Google (60 caractères max.)' },
        { k: 'meta_description', type: 'textarea', label: 'Description pour Google (160 caractères max.)', rows: 2 }
      ]
    }));
    state.catsExisting = existing;
  }

  /* ---------- Réglages ---------- */
  var DAY_LABELS = [['Monday', 'Lun'], ['Tuesday', 'Mar'], ['Wednesday', 'Mer'], ['Thursday', 'Jeu'], ['Friday', 'Ven'], ['Saturday', 'Sam'], ['Sunday', 'Dim']];
  function hoursEl(obj, def) {
    var box = el('div', {});
    function render() {
      box.innerHTML = '';
      obj[def.k].forEach(function (row, i) {
        var days = el('div', { class: 'days' });
        DAY_LABELS.forEach(function (d) {
          var inp = el('input', { type: 'checkbox', value: d[0] });
          inp.checked = (row.schema_days || []).indexOf(d[0]) > -1;
          inp.addEventListener('change', function () {
            row.schema_days = DAY_LABELS.map(function (x) { return x[0]; }).filter(function (x) { return x === d[0] ? inp.checked : row.schema_days.indexOf(x) > -1; });
            markDirty();
          });
          days.appendChild(el('label', { class: 'chip' }, [inp, el('span', { text: d[1] })]));
        });
        var slots = el('input', { type: 'text', placeholder: '10:00-13:00, 14:30-19:00' });
        slots.value = (row.opens || []).map(function (o, j) { return o + '-' + row.closes[j]; }).join(', ');
        slots.addEventListener('input', function () {
          var parts = slots.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          row.opens = []; row.closes = [];
          parts.forEach(function (p) {
            var m = p.replace(/h/gi, ':').replace(/\s/g, '').match(/^(\d{1,2}):?(\d{2})?-(\d{1,2}):?(\d{2})?$/);
            if (!m) { row.opens.push('xx'); row.closes.push('xx'); return; }
            var pad = function (h, mm) { return ('0' + h).slice(-2) + ':' + (mm || '00'); };
            row.opens.push(pad(m[1], m[2])); row.closes.push(pad(m[3], m[4]));
          });
          markDirty();
        });
        var lbl = el('input', { type: 'text', placeholder: 'Lundi – Samedi' });
        lbl.value = row.days || '';
        lbl.addEventListener('input', function () { row.days = lbl.value; markDirty(); });
        var del = el('button', { type: 'button', class: 'icon', text: '✕', 'aria-label': 'Supprimer' });
        del.addEventListener('click', function () { obj[def.k].splice(i, 1); markDirty(); render(); });
        box.appendChild(el('div', { class: 'list-item' }, [
          el('div', { class: 'list-item__head' }, [el('span', { text: 'Horaires ' + (i + 1) }), del]),
          el('div', { class: 'field' }, [el('label', { text: 'Libellé affiché' }), lbl]),
          el('div', { class: 'field' }, [el('label', { text: 'Jours concernés' }), days]),
          el('div', { class: 'field' }, [el('label', { text: 'Horaires' }), slots, el('small', { text: 'Format : 10:00-13:00, 14:30-19:00 (séparez les plages par une virgule)' })])
        ]));
      });
      var add = el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: '+ Ajouter une ligne d’horaires' });
      add.addEventListener('click', function () { obj[def.k].push({ days: '', schema_days: [], opens: ['10:00'], closes: ['19:00'] }); markDirty(); render(); });
      box.appendChild(add);
    }
    render();
    return el('div', { class: 'field' }, [el('label', { text: def.label }), box]);
  }

  var SETTINGS = [
    { type: 'group', label: 'Coordonnées', fields: [
      { k: 'phone', label: 'Téléphone', type: 'tel' }, { k: 'email', label: 'E-mail de contact', type: 'email' },
      { type: 'group', k: 'address', label: 'Adresse de la boutique', fields: [{ k: 'street', label: 'Rue' }, { k: 'postal_code', label: 'Code postal' }, { k: 'city', label: 'Ville' }] },
      { type: 'group', k: 'geo', label: 'Position sur la carte', help: 'À modifier seulement si la boutique déménage : clic droit sur le lieu dans Google Maps pour copier les coordonnées.', fields: [{ k: 'lat', label: 'Latitude' }, { k: 'lng', label: 'Longitude' }] }] },
    { type: 'group', label: 'Horaires d’ouverture', fields: [{ k: 'hours', type: 'hours', label: '' }] },
    { type: 'group', k: 'social', label: 'Réseaux sociaux', fields: [{ k: 'instagram', label: 'Instagram (lien complet)', type: 'url' }, { k: 'facebook', label: 'Facebook (lien complet)', type: 'url' }] },
    { type: 'group', label: 'Livraison & retours', fields: [
      { type: 'group', k: 'shipping', label: 'Colissimo', fields: [
        { k: 'metro_price', type: 'euro', label: 'France métropolitaine : prix (€)' },
        { k: 'free_threshold', type: 'euro', label: 'Livraison offerte à partir de (€)' },
        { k: 'metro_delay', label: 'France métropolitaine : délai affiché' },
        { k: 'domtom_price', type: 'euro', label: 'DOM-TOM : prix (€)' },
        { k: 'domtom_delay', label: 'DOM-TOM : délai affiché' },
        { k: 'backorder_days', type: 'int', min: 1, label: 'Délai « sur commande » quand le stock est à 0 (jours)' }] },
      { k: 'return_days', type: 'int', min: 14, label: 'Délai de retour (jours, 14 minimum)' }] },
    { type: 'group', k: 'gift', label: 'Emballage cadeau (option du panier)', fields: [
      { k: 'enabled', type: 'bool', label: 'Proposer l’emballage cadeau' },
      { k: 'price', type: 'euro', label: 'Prix (€, 0 = offert)' },
      { k: 'description', label: 'Description affichée au client', placeholder: 'ex. Paquet cadeau Eden Park avec votre message' }] },
    { type: 'group', k: 'legal', label: 'Mentions légales', help: 'Les autres informations (SIRET, TVA…) proviennent du registre du commerce.', fields: [
      { k: 'capital', label: 'Capital social', placeholder: 'ex. 10 000 €' }, { k: 'mediator', type: 'textarea', label: 'Médiateur de la consommation (nom et site web)', rows: 2 },
      { k: 'director', label: 'Directeur de la publication' }] },
    { type: 'group', label: 'Référencement & statistiques', fields: [
      { k: 'description', type: 'textarea', label: 'Description générale de la boutique', rows: 3 },
      { k: 'analytics_id', label: 'Identifiant Google Analytics', placeholder: 'G-XXXXXXXXXX' }] }
  ];
  function renderSettings() {
    if (!state.site) return;
    var s = state.site;
    state.settingsDraft = JSON.parse(JSON.stringify({
      phone: s.phone, email: s.email, address: s.address, geo: s.geo, hours: s.hours, social: s.social, shipping: s.shipping,
      return_days: s.return_days, gift: s.gift || { enabled: false, price: 0, description: '' }, legal: { capital: s.legal.capital, mediator: s.legal.mediator, director: s.legal.director },
      description: s.description, analytics_id: /X{4}/.test(s.analytics_id) ? '' : s.analytics_id
    }));
    var box = $('#settings-form');
    box.innerHTML = '';
    var grid = el('div', { class: 'form-grid' });
    renderFieldsInto(grid, state.settingsDraft, SETTINGS);
    box.appendChild(grid);
  }

  /* ---------- Avis clients ---------- */
  var REVIEW_STATUS = { pending: 'À valider', approved: 'Publié', rejected: 'Masqué' };
  var reviewsCache = [];
  function updateReviewsCount() {
    var n = reviewsCache.filter(function (r) { return r.status === 'pending'; }).length;
    var c = $('#reviews-count');
    c.hidden = !n;
    c.textContent = n;
  }
  function renderReviews() {
    var box = $('#reviews');
    if (!reviewsCache.length) { box.innerHTML = '<p class="empty">Aucun avis pour le moment. Ils apparaîtront ici dès qu’un client en déposera un sur une fiche produit.</p>'; return; }
    box.innerHTML = reviewsCache.map(function (r) {
      var p = state.catalog.products.filter(function (x) { return x.slug === r.slug; })[0];
      var date = new Date(r.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
      var btns = [];
      if (r.status !== 'approved') btns.push('<button type="button" class="btn btn--sm" data-review="approved">Publier</button>');
      if (r.status !== 'rejected') btns.push('<button type="button" class="btn btn--ghost btn--sm" data-review="rejected">Masquer</button>');
      btns.push('<button type="button" class="btn btn--ghost btn--sm danger" data-review="delete">Supprimer</button>');
      return '<div class="order" data-review-id="' + esc(r.id) + '"><div><strong>' + esc(date) + '</strong><br><span class="st st--' + (r.status === 'approved' ? 'livree' : r.status === 'pending' ? 'a_preparer' : 'annulee') + '">' + REVIEW_STATUS[r.status] + '</span></div>' +
        '<div><strong>' + esc(p ? p.name : r.slug) + '</strong><br><span class="stars" style="color:#c99a2e">' + '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) + '</span> · ' + esc(r.name) +
        (r.verified ? ' <span class="tag tag--ok">Achat vérifié</span>' : '') + (r.email ? ' <span class="muted small">(' + esc(r.email) + ')</span>' : '') +
        '<p style="margin:8px 0 0;white-space:pre-line">' + esc(r.text) + '</p></div>' +
        '<div class="order__actions" style="align-self:start">' + btns.join('') + '</div></div>';
    }).join('');
  }
  function loadReviews() {
    return api('GET', '/api/admin/reviews').then(function (d) { reviewsCache = d.reviews; updateReviewsCount(); renderReviews(); })
      .catch(function (ex) { $('#reviews').innerHTML = '<p class="error">' + esc(ex.message) + '</p>'; });
  }
  $('#refresh-reviews').addEventListener('click', loadReviews);
  $('#reviews').addEventListener('click', function (e) {
    var b = e.target.closest('[data-review]');
    if (!b) return;
    var id = b.closest('[data-review-id]').getAttribute('data-review-id');
    var action = b.getAttribute('data-review');
    if (action === 'delete' && !confirm('Supprimer définitivement cet avis ?')) return;
    b.disabled = true;
    var call = action === 'delete' ? api('DELETE', '/api/admin/reviews', { id: id }) : api('PATCH', '/api/admin/reviews', { id: id, status: action });
    call.then(function (d) {
      if (d.publish) setPublish(d.publish);
      toast(action === 'approved' ? 'Avis validé : il sera visible sur le site après « Publier ».' : action === 'delete' ? 'Avis supprimé.' : 'Avis masqué.');
      return loadReviews();
    }).catch(function (ex) { toast(ex.message, true); b.disabled = false; });
  });

  /* ---------- Soldes & promotions ---------- */
  var SALE_FIELDS = [
    { k: 'name', label: 'Nom de la campagne (interne)', placeholder: 'ex. Soldes d’hiver 2027' },
    { k: 'kind', type: 'select', label: 'Type', options: [['promotion', 'Promotion'], ['soldes', 'Soldes (périodes officielles uniquement)']],
      help: 'Le mot « Soldes » n’est autorisé que pendant les soldes officiels (hiver : à partir du 2e mercredi de janvier ; été : à partir du dernier mercredi de juin ; 4 semaines). Les articles doivent avoir été proposés à la vente depuis au moins un mois.' },
    { k: 'percent', type: 'int', min: 1, label: 'Réduction (%)' },
    { k: 'badge', label: 'Étiquette sur les produits (facultatif)', placeholder: 'ex. Soldes, Black Friday…', help: 'Si le prix barré est applicable, l’étiquette affiche le pourcentage (ex. -30 %).' },
    { k: 'scope', type: 'select', label: 'Articles concernés', options: [['all', 'Tout le catalogue'], ['categories', 'Certaines catégories'], ['products', 'Certains produits']] },
    { k: 'categories', type: 'checks', label: 'Catégories (si « Certaines catégories »)', options: function () { return state.catalog.categories.map(function (c) { return [c.slug, c.name]; }); } },
    { k: 'products', type: 'checks', label: 'Produits (si « Certains produits »)', options: function () { return state.catalog.products.map(function (p) { return [p.slug, p.name]; }); } },
    { k: 'starts', type: 'date', label: 'Début' },
    { k: 'ends', type: 'date', label: 'Fin (incluse)' },
    { k: 'banner', label: 'Message dans le bandeau du haut pendant la campagne (facultatif)', placeholder: 'ex. Soldes d’hiver : jusqu’à -30 % sur la collection' },
    { k: 'active', type: 'bool', label: 'Campagne active' }
  ];
  function todayParis() { try { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  function campaignStatus(c) {
    var d = todayParis();
    if (!c.active) return 'désactivée';
    if (!c.starts || !c.ends) return 'dates à compléter';
    if (d < c.starts) return 'à venir (' + c.starts.split('-').reverse().join('/') + ')';
    if (d > c.ends) return 'terminée';
    return 'en cours';
  }
  function outsideOfficial(c) {
    if (c.kind !== 'soldes' || !c.starts || !c.ends) return false;
    return !(state.salesOfficial || []).some(function (p) { return c.starts >= p.starts && c.ends <= p.ends; });
  }
  function renderSales() {
    var box = $('#sales-form');
    box.innerHTML = '<p class="muted">Chargement…</p>';
    api('GET', '/api/admin/sales').then(function (d) {
      state.salesOfficial = d.official;
      state.salesDraft = JSON.parse(JSON.stringify(d.campaigns));
      var fmt = function (p) { return p.starts.split('-').reverse().join('/') + ' → ' + p.ends.split('-').reverse().join('/'); };
      $('#sales-info').innerHTML = '<p class="muted small">Prochaines périodes de soldes officielles : ' + d.official.filter(function (p) { return p.ends >= d.today; }).slice(0, 2).map(fmt).join(' · ') + '</p>';
      box.innerHTML = '';
      box.appendChild(listEl({ c: state.salesDraft }, {
        k: 'c', label: '', addLabel: 'Créer une campagne',
        itemTitle: function (c) { return (c.name || 'Nouvelle campagne') + ' · -' + (c.percent || 0) + ' % · ' + campaignStatus(c) + (outsideOfficial(c) ? ' · ⚠ hors période officielle de soldes' : ''); },
        template: { name: '', kind: 'promotion', percent: 20, badge: '', scope: 'all', categories: [], products: [], starts: todayParis(), ends: '', banner: '', active: true },
        fields: SALE_FIELDS
      }));
      if (!state.salesDraft.length) box.insertBefore(el('p', { class: 'empty', text: 'Aucune campagne. Exemple : « Promotion de rentrée », -20 % sur les polos, du 1er au 15 octobre.' }), box.firstChild);
    }).catch(function (ex) { box.innerHTML = '<p class="error">' + esc(ex.message) + '</p>'; });
  }

  /* ---------- Codes promo ---------- */
  var PROMO_FIELDS = [
    { k: 'code', label: 'Code (ce que le client saisit)', placeholder: 'ex. BIENVENUE10', help: 'Lettres, chiffres ou tirets. Majuscules et minuscules sont équivalentes.' },
    { k: 'type', type: 'select', label: 'Type de réduction', options: [['percent', 'Pourcentage (%)'], ['amount', 'Montant fixe (€)'], ['shipping', 'Livraison offerte']] },
    { k: 'percent', type: 'int', min: 1, label: 'Pourcentage (si type « Pourcentage »)' },
    { k: 'amount', type: 'euro', label: 'Montant en € (si type « Montant fixe »)' },
    { k: 'min_order', type: 'euro', label: 'Montant minimum du panier (€, 0 = aucun)' },
    { k: 'starts', type: 'date', label: 'Valable à partir du (facultatif)' },
    { k: 'ends', type: 'date', label: 'Valable jusqu’au (inclus, facultatif)' },
    { k: 'max_uses', type: 'int', label: 'Nombre d’utilisations maximum (0 = illimité)' },
    { k: 'categories', type: 'checks', label: 'Limiter à certaines catégories', help: 'Aucune case cochée = tout le catalogue.',
      options: function () { return state.catalog.categories.map(function (c) { return [c.slug, c.name]; }); } },
    { k: 'note', label: 'Note interne (facultatif)', placeholder: 'ex. offert aux clients de la boutique' },
    { k: 'exclude_sale', type: 'bool', label: 'Ne pas appliquer aux articles déjà en promotion ou soldés' },
    { k: 'active', type: 'bool', label: 'Code actif' },
    { k: 'reset_uses', type: 'bool', label: 'Remettre le compteur d’utilisations à zéro' }
  ];
  function promoSummary(p) {
    var what = p.type === 'percent' ? '-' + (p.percent || 0) + ' %' : p.type === 'amount' ? '-' + euro(p.amount || 0) : 'livraison offerte';
    var uses = (p.uses || 0) + (p.max_uses ? '/' + p.max_uses : '') + ' utilisation' + ((p.uses || 0) > 1 ? 's' : '');
    return (p.code || 'Nouveau code') + ' · ' + what + ' · ' + uses + (p.active === false ? ' · inactif' : '');
  }
  function renderPromos() {
    var box = $('#promos-form');
    box.innerHTML = '<p class="muted">Chargement…</p>';
    api('GET', '/api/admin/promos').then(function (d) {
      state.promos = d.promos;
      state.promosDraft = JSON.parse(JSON.stringify(d.promos));
      box.innerHTML = '';
      var holder = { promos: state.promosDraft };
      box.appendChild(listEl(holder, {
        k: 'promos', label: '', addLabel: 'Créer un code promo', itemTitle: promoSummary,
        template: { code: '', type: 'percent', percent: 10, amount: 0, min_order: 0, starts: '', ends: '', max_uses: 0, categories: [], note: '', active: true },
        fields: PROMO_FIELDS
      }));
      if (!state.promosDraft.length) box.insertBefore(el('p', { class: 'empty', text: 'Aucun code promo pour l’instant. Exemple : BIENVENUE10 pour -10 % sur la première commande.' }), box.firstChild);
    }).catch(function (ex) { box.innerHTML = '<p class="error">' + esc(ex.message) + '</p>'; });
  }

  /* ---------- Enregistrement des onglets (Pages, Catégories, Réglages, Codes promo) ---------- */
  $$('[data-save]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var what = btn.getAttribute('data-save');
      var req;
      if (what === 'pages') {
        // Journal : adresse et date remplies automatiquement pour les nouveaux articles
        var arts = state.pagesDraft.journal || [];
        for (var a = 0; a < arts.length; a++) {
          if (!String(arts[a].title || '').trim()) { toast('Chaque article du Journal doit avoir un titre.', true); return; }
          if (!arts[a].date) arts[a].date = new Date().toISOString().slice(0, 10);
          if (!arts[a].slug) {
            var sb = slugify(arts[a].title).slice(0, 70) || 'article', sl = sb, k = 2;
            while (arts.some(function (x, j) { return j !== a && x.slug === sl; })) sl = sb + '-' + k++;
            arts[a].slug = sl;
          }
        }
        req = api('PUT', '/api/admin/content', { content: state.pagesDraft });
      }
      if (what === 'settings') {
        var d = state.settingsDraft;
        d.geo = { lat: parseFloat(String(d.geo.lat).replace(',', '.')), lng: parseFloat(String(d.geo.lng).replace(',', '.')) };
        req = api('PUT', '/api/admin/content', { settings: d });
      }
      if (what === 'categories') {
        var cats = state.catsDraft;
        for (var i = 0; i < cats.length; i++) {
          if (!cats[i].name.trim()) { toast('Chaque catégorie doit avoir un nom.', true); return; }
          if (!cats[i].slug) {
            var base = slugify(cats[i].name), slug = base, n = 2;
            while (cats.some(function (c, j) { return j !== i && c.slug === slug; })) slug = base + '-' + n++;
            cats[i].slug = slug;
          }
          if (!cats[i].title) cats[i].title = cats[i].name;
          if (!cats[i].meta_title) cats[i].meta_title = cats[i].name + ' | Eden Park Arcachon';
          if (!cats[i].meta_description) cats[i].meta_description = cats[i].intro || cats[i].title;
          if (!cats[i].image) cats[i].image = null;
        }
        var catalog = JSON.parse(JSON.stringify(state.catalog));
        catalog.categories = cats;
        req = api('PUT', '/api/admin/catalog', { catalog: catalog, what: 'Catégories' }).then(function (r) { state.catalog = catalog; return r; });
      }
      if (what === 'sales') {
        req = api('PUT', '/api/admin/sales', { campaigns: state.salesDraft });
      }
      if (what === 'promos') {
        var bad = state.promosDraft.filter(function (p) { return !String(p.code || '').trim(); });
        if (bad.length) { toast('Chaque code promo doit avoir un nom (ex. BIENVENUE10).', true); return; }
        req = api('PUT', '/api/admin/promos', { promos: state.promosDraft }).then(function (r) { state.promos = r.promos; return r; });
      }
      btn.disabled = true;
      req.then(function (r) {
        if (r.site) state.site = r.site;
        if (r.content) state.content = r.content;
        state.dirty = false;
        if (r.publish) setPublish(r.publish);
        toast(what === 'sales' ? 'Campagnes enregistrées : le panier applique déjà les nouveaux prix. Cliquez sur « Publier » pour mettre à jour l\u2019affichage du site.' : what === 'promos' ? 'Codes promo enregistrés : ils sont actifs immédiatement.' : 'Enregistré. Cliquez sur « Publier » quand vous avez terminé vos modifications.');
        if (what === 'categories') renderCategories();
        if (what === 'settings') renderSettings();
        if (what === 'promos') renderPromos();
        if (what === 'sales') renderSales();
      }).catch(function (ex) { toast(ex.message, true); }).then(function () { btn.disabled = false; });
    });
  });

  /* =====================================================================
     Publication groupée (chaque mise en ligne consomme des crédits Netlify)
     ===================================================================== */
  function setPublish(p) {
    state.publish = p;
    var bar = $('#publishbar');
    var pending = (p && p.pending) || [];
    if (pending.length) {
      bar.innerHTML = '<span class="dot dot--late"></span><span>' + pending.length + ' modification' + (pending.length > 1 ? 's' : '') +
        ' à publier <small>(' + esc(pending.map(function (x) { return x.what; }).join(', ')) + ')</small></span>' +
        '<button type="button" class="btn btn--sm" id="publish-btn">Publier les modifications</button>';
    } else {
      var when = p && p.lastPublished ? new Date(p.lastPublished).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : null;
      bar.innerHTML = '<span class="dot dot--ok"></span><span>Site à jour' + (when ? ' <small>(publié le ' + esc(when) + ')</small>' : '') + '</span>';
    }
  }
  $('#publishbar').addEventListener('click', function (e) {
    if (e.target.id !== 'publish-btn') return;
    if (state.dirty && !confirm('Certaines modifications de cet écran ne sont pas enregistrées et ne seront pas publiées. Continuer ?')) return;
    e.target.disabled = true;
    e.target.textContent = 'Publication…';
    api('POST', '/api/admin/publish').then(function (p) {
      setPublish(p);
      toast('Publication lancée : le site sera à jour dans 1 à 2 minutes.');
    }).catch(function (ex) { toast(ex.message, true); setPublish(state.publish); });
  });
  function loadPublish() {
    return api('GET', '/api/admin/publish').then(setPublish).catch(function () {});
  }

  /* ---------- Démarrage ---------- */
  if (token()) start(); else showLogin();
})();
