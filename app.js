// M.E.C.A. — Moxfield x EDHREC Collection Analyser
// Logique de l'application. Dépend de la constante globale I18N
// (voir i18n.js, chargé avant ce fichier).

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config & état
  // ---------------------------------------------------------------------
  const DB_NAME = "moxfield_edhrec_cache";
  const DB_VERSION = 3;
  const STORE_CARDS = "cards";
  const STORE_COMMANDERS = "commanders";
  const STORE_SESSION = "session";
  const STORE_IMAGES = "images";
  const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 jours
  const FETCH_CONCURRENCY = 18; // requêtes cartes en parallèle pendant l'analyse principale (EDHREC tolère bien cette charge ; au-delà de ~24-25 le risque de 429 augmente sans gain net)
  const REFINE_CONCURRENCY = 6; // requêtes commandants en parallèle pour le top N
  const MAX_RETRIES = 2; // nouvelles tentatives sur échec réseau transitoire

  const EDHREC_BASE = "https://json.edhrec.com";
  const COPY_ICON = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="7" width="10" height="10" rx="1.4"/><path d="M4.5 13.2H3.8A1.3 1.3 0 0 1 2.5 11.9V3.8A1.3 1.3 0 0 1 3.8 2.5h8.1a1.3 1.3 0 0 1 1.3 1.3v.7"/></svg>';
  const COPY_ICON_CHECK = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10.5l3.8 3.8L16 6"/></svg>';

  // ---------------------------------------------------------------------
  // i18n
  // ---------------------------------------------------------------------
  const LANG_KEY = "moxedh_lang";

  let currentLang = "fr";
  try {
    currentLang = localStorage.getItem(LANG_KEY) === "en" ? "en" : "fr";
  } catch (e) {}

  function t(key, vars) {
    const dict = I18N[currentLang] || I18N.fr;
    let str = dict[key] != null ? dict[key] : (I18N.fr[key] != null ? I18N.fr[key] : key);
    if (vars) {
      for (const k in vars) str = str.split("{" + k + "}").join(vars[k]);
    }
    return str;
  }

  function applyI18n() {
    document.documentElement.setAttribute("lang", currentLang);
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
  }

  let db = null;
  let collection = new Map(); // slug -> { name, qty }
  let allCommanders = []; // résultats agrégés
  let lastFetchResults = []; // résultats bruts de la dernière analyse (pour ré-agréger après un retry)
  let lastMinSample = 0;
  let progressStateKey = "progress.idle";
  let lastNotFoundItems = [];
  let currentFileLabel = null; // { fileName, count, restored }
  let lastSessionInfo = null; // { fileName, count }

  const $ = (id) => document.getElementById(id);

  const els = {
    dropzone: $("dropzone"),
    fileInput: $("fileInput"),
    fileChip: $("fileChip"),
    minSample: $("minSample"),
    excludeTopN: $("excludeTopN"),
    excludeTopNStatus: $("excludeTopNStatus"),
    startBtn: $("startBtn"),
    restoreSessionBtn: $("restoreSessionBtn"),
    clearCacheBtn: $("clearCacheBtn"),
    setupError: $("setupError"),
    progressPanel: $("progressPanel"),
    progressLabel: $("progressLabel"),
    progressCount: $("progressCount"),
    progressFill: $("progressFill"),
    progressLog: $("progressLog"),
    statsStrip: $("statsStrip"),
    statCards: $("statCards"),
    statFound: $("statFound"),
    statCommanders: $("statCommanders"),
    statOwnedCommanders: $("statOwnedCommanders"),
    statCache: $("statCache"),
    statNotFound: $("statNotFound"),
    notFoundPanel: $("notFoundPanel"),
    notFoundSummary: $("notFoundSummary"),
    notFoundList: $("notFoundList"),
    retryAllBtn: $("retryAllBtn"),
    resultsTitle: $("resultsTitle"),
    resultsNote: $("resultsNote"),
    filterBar: $("filterBar"),
    sortSelect: $("sortSelect"),
    ownedFilter: $("ownedFilter"),
    colorFilter: $("colorFilter"),
    colorFilterMode: $("colorFilterMode"),
    colorFilterClear: $("colorFilterClear"),
    results: $("results"),
  };

  // ---------------------------------------------------------------------
  // IndexedDB cache
  // ---------------------------------------------------------------------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const _db = req.result;
        if (!_db.objectStoreNames.contains(STORE_CARDS)) {
          _db.createObjectStore(STORE_CARDS, { keyPath: "slug" });
        }
        if (!_db.objectStoreNames.contains(STORE_COMMANDERS)) {
          _db.createObjectStore(STORE_COMMANDERS, { keyPath: "slug" });
        }
        if (!_db.objectStoreNames.contains(STORE_SESSION)) {
          _db.createObjectStore(STORE_SESSION, { keyPath: "key" });
        }
        if (!_db.objectStoreNames.contains(STORE_IMAGES)) {
          _db.createObjectStore(STORE_IMAGES, { keyPath: "name" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(store, key) {
    return new Promise((resolve) => {
      if (!db) return resolve(null);
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  function idbSet(store, value) {
    return new Promise((resolve) => {
      if (!db) return resolve(null);
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  function idbDelete(store, key) {
    return new Promise((resolve) => {
      if (!db) return resolve(false);
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  function idbCount(store) {
    return new Promise((resolve) => {
      if (!db) return resolve(0);
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  }

  function idbClearAll() {
    return new Promise((resolve) => {
      if (!db) return resolve(false);
      const tx = db.transaction([STORE_CARDS, STORE_COMMANDERS, STORE_SESSION, STORE_IMAGES], "readwrite");
      tx.objectStore(STORE_CARDS).clear();
      tx.objectStore(STORE_COMMANDERS).clear();
      tx.objectStore(STORE_SESSION).clear();
      tx.objectStore(STORE_IMAGES).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  // ---------------------------------------------------------------------
  // CSV parsing (gère les champs entre guillemets, virgules internes, etc.)
  // ---------------------------------------------------------------------
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  }

  function findColumnIndex(header, candidates) {
    const lower = header.map((h) => h.trim().toLowerCase());
    for (const cand of candidates) {
      const idx = lower.indexOf(cand);
      if (idx !== -1) return idx;
    }
    // fallback: contient
    for (const cand of candidates) {
      const idx = lower.findIndex((h) => h.includes(cand));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  function baseSlugify(s) {
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // accents
    s = s.toLowerCase();
    // apostrophes et points retirés sans être remplacés par un tiret
    // (ex : "G.F." -> "gf", pas "g-f", pour matcher la convention EDHREC)
    s = s.replace(/[',’.]/g, "");
    s = s.replace(/[^a-z0-9]+/g, "-");
    s = s.replace(/^-+|-+$/g, "");
    return s;
  }

  function slugify(name) {
    // cartes double-face : on ne garde que la face avant pour la clé locale
    return baseSlugify(name.split(" // ")[0]);
  }

  // Renvoie les slugs candidats pour une carte, face par face. Utile pour
  // les cartes double-face / split où EDHREC indexe parfois la seconde
  // face plutôt que la première (ex : "Welcome to . . . // Jurassic Park"
  // est référencée sous "jurassic-park").
  function candidateSlugs(name) {
    const faces = name.split(" // ");
    const slugs = [];
    for (const f of faces) {
      const s = baseSlugify(f);
      if (s && !slugs.includes(s)) slugs.push(s);
    }
    return slugs.length ? slugs : [baseSlugify(name)];
  }

  function parseMoxfieldCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error(t("error.emptyCsv"));
    const header = rows[0];
    const nameIdx = findColumnIndex(header, ["name", "card name", "card"]);
    const qtyIdx = findColumnIndex(header, ["count", "quantity", "qty"]);
    if (nameIdx === -1) throw new Error(t("error.noNameColumn"));

    const map = new Map();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rawName = (r[nameIdx] || "").trim();
      if (!rawName) continue;
      const qty = qtyIdx !== -1 ? (parseInt(r[qtyIdx], 10) || 1) : 1;
      const slug = slugify(rawName);
      if (!slug) continue;
      if (map.has(slug)) {
        map.get(slug).qty += qty;
      } else {
        map.set(slug, { name: rawName, qty, slug });
      }
    }
    return map;
  }

  // ---------------------------------------------------------------------
  // Fetch EDHREC en direct (avec cache + concurrence limitée)
  // ---------------------------------------------------------------------
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Toute requête réseau passe par ici : évite qu'une requête bloquée
  // (Scryfall lent, Wi-Fi capricieux…) ne fasse tourner un spinner à
  // l'infini ou ne bloque un worker de l'analyse en masse.
  const FETCH_TIMEOUT_MS = 9000;
  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms || FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveEdhrecSlugViaScryfall(name) {
    try {
      const url = "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name);
      const res = await fetchWithTimeout(url);
      if (!res.ok) return null;
      const json = await res.json();
      const edhrecUrl = json.related_uris && json.related_uris.edhrec;
      if (!edhrecUrl) return null;
      const m = edhrecUrl.match(/\/cards\/([^/?#]+)/);
      return m ? m[1] : null;
    } catch (err) {
      return null;
    }
  }

  async function fetchCardPageRaw(slug) {
    const url = EDHREC_BASE + "/pages/cards/" + encodeURIComponent(slug) + ".json";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout(url);
        if (res.status === 404) return { data: null, notFound: true };
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        return { data: json, notFound: false };
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        return { data: null, notFound: false, error: String(err) };
      }
    }
  }

  // Tente la page carte EDHREC via le slug local (en essayant chaque face
  // pour les cartes double-face). Les candidats sont interrogés en
  // parallèle (au lieu d'un essai séquentiel candidat par candidat) : pour
  // une carte double-face non trouvée sous sa première face, on ne paie
  // plus deux allers-retours l'un après l'autre (jusqu'à 2× le temps
  // d'attente/timeout), juste un seul, le temps du plus lent des deux.
  // Le repli réseau via Scryfall (related_uris.edhrec) n'est déclenché
  // que lorsque useScryfallFallback est explicitement demandé (bouton
  // "réessayer" individuel) : l'activer pour chaque carte non trouvée
  // pendant l'analyse en masse (jetons, émblèmes, produits scellés qui ne
  // seront de toute façon jamais indexés) multiplierait les requêtes
  // réseau et ralentirait l'analyse de collections volumineuses.
  async function fetchCardPage(slug, cardName, useScryfallFallback) {
    const cached = await idbGet(STORE_CARDS, slug);
    if (cached && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) {
      return { data: cached.data, fromCache: true, notFound: cached.notFound || false };
    }

    const candidates = cardName ? candidateSlugs(cardName) : [slug];
    if (!candidates.includes(slug)) candidates.unshift(slug);

    const attempts = await Promise.all(candidates.map((candidate) => fetchCardPageRaw(candidate)));
    const hit = attempts.find((r) => r.data);
    if (hit) {
      await idbSet(STORE_CARDS, { slug, data: hit.data, notFound: false, fetchedAt: Date.now() });
      return { data: hit.data, fromCache: false, notFound: false };
    }
    const lastResult = attempts[attempts.length - 1] || { data: null, notFound: true };

    if (useScryfallFallback && cardName) {
      const triedSet = new Set(candidates);
      const altSlug = await resolveEdhrecSlugViaScryfall(cardName);
      if (altSlug && !triedSet.has(altSlug)) {
        const alt = await fetchCardPageRaw(altSlug);
        if (alt.data) {
          await idbSet(STORE_CARDS, { slug, data: alt.data, notFound: false, fetchedAt: Date.now(), viaScryfall: true });
          return { data: alt.data, fromCache: false, notFound: false, viaScryfall: true };
        }
      }
    }

    await idbSet(STORE_CARDS, { slug, data: null, notFound: true, fetchedAt: Date.now() });
    return { data: null, fromCache: false, notFound: true, error: lastResult.error };
  }

  async function fetchCommanderPage(slug) {
    const cached = await idbGet(STORE_COMMANDERS, slug);
    if (cached && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) {
      return cached.data;
    }
    const url = EDHREC_BASE + "/pages/commanders/" + encodeURIComponent(slug) + ".json";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) return null;
        const json = await res.json();
        await idbSet(STORE_COMMANDERS, { slug, data: json, fetchedAt: Date.now() });
        return json;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        return null;
      }
    }
  }

  async function runPool(items, worker, concurrency, onProgress) {
    let idx = 0;
    let done = 0;
    const results = new Array(items.length);

    async function next() {
      while (idx < items.length) {
        const my = idx++;
        try {
          results[my] = await worker(items[my], my);
        } catch (err) {
          // Une carte en échec (réseau, erreur inattendue…) ne doit jamais
          // interrompre le reste de l'analyse.
          results[my] = { error: String(err) };
        }
        done++;
        if (onProgress) onProgress(done, items.length, items[my]);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, next);
    await Promise.all(workers);
    return results;
  }

  // ---------------------------------------------------------------------
  // Agrégation & scoring
  // ---------------------------------------------------------------------
  function extractCommanderLists(cardJson) {
    try {
      const lists = cardJson.container.json_dict.cardlists || [];
      const out = [];
      for (const l of lists) {
        if (l.tag === "topcommanders" || l.tag === "newcommanders") {
          for (const cv of l.cardviews || []) {
            if (cv.num_decks && cv.potential_decks) out.push(cv);
          }
        }
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function extractGlobalRate(cardJson) {
    try {
      const c = cardJson.container.json_dict.card;
      if (c && c.num_decks && c.potential_decks) {
        return c.num_decks / c.potential_decks;
      }
    } catch (e) {}
    return null;
  }

  // EDHREC inclut "legal_commander": true directement dans les données de la
  // carte elle-même quand elle est éligible comme commandant (créature
  // légendaire, planeswalker autorisé type Daretti, etc.) — champ absent
  // sinon. C'est la source de vérité, pas une inférence par co-occurrence.
  function extractLegalCommander(cardJson) {
    try {
      return cardJson.container.json_dict.card.legal_commander === true;
    } catch (e) {
      return false;
    }
  }

  const WUBRG_ORDER = ["W", "U", "B", "R", "G"];
  function sortColorIdentity(colors) {
    return Array.from(new Set(colors)).sort(
      (a, b) => WUBRG_ORDER.indexOf(a) - WUBRG_ORDER.indexOf(b)
    );
  }

  function aggregate(cardResults, minSample) {
    // commanderSlug -> { name, url, colorIdentity, totalLift, totalDecksSample, matches: [] }
    const byCommander = new Map();

    for (const { slug, name, qty, data } of cardResults) {
      if (!data) continue;
      const globalRate = extractGlobalRate(data);
      if (!globalRate || globalRate <= 0) continue;
      const commanders = extractCommanderLists(data);
      const ownCardColors = extractColorIdentity(data);

      for (const cv of commanders) {
        if (cv.potential_decks < minSample) continue;
        const ownRate = cv.num_decks / cv.potential_decks;
        const lift = ownRate / globalRate;
        if (!isFinite(lift) || lift <= 0) continue;

        const key = cv.sanitized || cv.slug || cv.name;
        if (!byCommander.has(key)) {
          byCommander.set(key, {
            slug: key,
            name: cv.name,
            url: "https://edhrec.com" + (cv.url || "/commanders/" + key),
            totalLift: 0,
            totalDecksSample: 0,
            colorIdentitySet: new Set(),
            matches: [],
          });
        }
        const entry = byCommander.get(key);
        entry.totalLift += lift;
        entry.totalDecksSample = Math.max(entry.totalDecksSample, cv.potential_decks || 0);
        for (const col of ownCardColors) entry.colorIdentitySet.add(col);
        entry.matches.push({
          cardName: name,
          cardUrl: "https://edhrec.com/cards/" + slug,
          qty,
          lift,
          ownRate,
          numDecks: cv.num_decks,
          potentialDecks: cv.potential_decks,
        });
      }
    }

    const arr = Array.from(byCommander.values());
    for (const e of arr) {
      e.matches.sort((a, b) => b.lift - a.lift);
      e.isOwned = collection.has(e.slug);
      // Identité couleur inférée par défaut : union des couleurs des cartes
      // de ta collection associées. C'est une approximation (le vrai commandant
      // peut avoir des couleurs non représentées si tu n'as aucune carte dans
      // cette couleur pour lui) — remplacée par la valeur exacte, au fur et à
      // mesure de l'affichage, via refineVisibleColors().
      e.colorIdentity = sortColorIdentity(Array.from(e.colorIdentitySet));
    }
    arr.sort((a, b) => b.totalLift - a.totalLift);
    return arr;
  }

  function extractColorIdentity(commanderJson) {
    try {
      return commanderJson.container.json_dict.card.color_identity || [];
    } catch (e) {
      return [];
    }
  }

  // Le rang EDHREC global d'un commandant est un champ numérique direct :
  // container.json_dict.card.rank (confirmé par inspection de la réponse
  // JSON réelle). On garde un repli par regex sur l'ensemble de la réponse
  // au cas où ce chemin changerait ou serait absent pour certaines cartes.
  function extractCommanderRank(commanderJson) {
    try {
      const direct = commanderJson.container.json_dict.card.rank;
      if (typeof direct === "number" && !isNaN(direct)) return direct;
    } catch (e) {
      /* repli ci-dessous */
    }
    try {
      const json = JSON.stringify(commanderJson);
      const m = json.match(/"rank"\s*:\s*(\d+)/) || json.match(/Rank #([\d,]+)/);
      if (!m) return null;
      const n = parseInt(m[1].replace(/,/g, ""), 10);
      return isNaN(n) ? null : n;
    } catch (e) {
      return null;
    }
  }

  // Remplace l'identité couleur inférée (approximative) par la valeur exacte,
  // mais SEULEMENT pour les commandants actuellement affichés à l'écran — pas
  // question de faire une requête par commandant sur toute la liste (des
  // milliers potentiellement). Chaque nouvelle page ("voir plus") déclenche
  // son propre lot, sans jamais re-fetcher un commandant déjà résolu.
  const colorFetchInFlight = new Set();
  function refineVisibleColors(list) {
    const targets = list.filter((c) => !c.colorExact && !colorFetchInFlight.has(c.slug));
    if (targets.length === 0) return;
    targets.forEach((c) => colorFetchInFlight.add(c.slug));
    runPool(targets, async (entry) => {
      const data = await fetchCommanderPage(entry.slug);
      colorFetchInFlight.delete(entry.slug);
      if (!data) return;
      entry.colorIdentity = extractColorIdentity(data);
      entry.colorExact = true;
      if (entry.edhrecRank === undefined) entry.edhrecRank = extractCommanderRank(data);
      const cardEl = els.results.querySelector('.commander-card[data-slug="' + cssEscape(entry.slug) + '"]');
      if (!cardEl) return;
      const pipsEl = cardEl.querySelector(".cc-pips");
      if (pipsEl) {
        pipsEl.innerHTML = renderPips(entry.colorIdentity);
      }
      const metaEl = cardEl.querySelector(".cc-meta");
      if (metaEl) {
        metaEl.innerHTML = buildMetaHtml(entry);
      }
    }, REFINE_CONCURRENCY, null);
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------
  const PIP_CODES = ["W", "U", "B", "R", "G"];
  function renderPips(colorIdentity) {
    const list = (colorIdentity || []).filter((c) => PIP_CODES.includes(c));
    if (list.length === 0) {
      return `<span class="pip pip-c" title="${t("pip.colorless")}"></span>`;
    }
    return list.map((col) => `<span class="pip pip-${col}"></span>`).join("");
  }

  let visibleCommanderCount = 40;
  const COMMANDER_PAGE_SIZE = 40;
  let colorFilterSet = new Set(); // identité couleur sélectionnée

  function commanderMatchesColorFilter(c) {
    if (colorFilterSet.size === 0) return true;
    const ids = new Set((c.colorIdentity || []).filter((x) => PIP_CODES.includes(x)));
    if (colorFilterSet.has("C")) return ids.size === 0;

    const mode = els.colorFilterMode.value;
    if (mode === "subset") {
      // Le commandant ne doit utiliser AUCUNE couleur en dehors de la sélection
      for (const col of ids) if (!colorFilterSet.has(col)) return false;
      return true;
    }
    if (mode === "atleast") {
      // Le commandant doit contenir AU MOINS toutes les couleurs sélectionnées
      for (const col of colorFilterSet) if (!ids.has(col)) return false;
      return true;
    }
    // "exact" (défaut) : correspondance stricte, ni plus ni moins
    if (ids.size !== colorFilterSet.size) return false;
    for (const col of ids) if (!colorFilterSet.has(col)) return false;
    return true;
  }

  function buildMetaHtml(c) {
    const scoreHtml = `<span class="cc-meta-num">${c.totalLift.toFixed(1)}</span>`;
    const metaBits = [];
    if (c.edhrecRank) {
      const rankHtml = `<span class="cc-meta-num">#${c.edhrecRank.toLocaleString(currentLang === "en" ? "en-US" : "fr-FR")}</span>`;
      metaBits.push(t("cc.rankMeta", { rank: rankHtml }));
    }
    if (c.totalDecksSample) {
      const deckHtml = `<span class="cc-meta-num">${c.totalDecksSample.toLocaleString(currentLang === "en" ? "en-US" : "fr-FR")}</span>`;
      metaBits.push(t("cc.deckCountMeta", { n: deckHtml }));
    }
    metaBits.push(t("cc.scoreMeta", { score: scoreHtml }));
    return metaBits.join(" · ");
  }

  let renderToken = 0;

  // Avance dans baseList (déjà filtrée/triée, mais PAS encore filtrée par
  // rang) en ne vérifiant le rang EDHREC que des commandants réellement
  // nécessaires pour remplir la page — jamais l'ensemble des candidats.
  // Se relance par lots de COMMANDER_PAGE_SIZE jusqu'à réunir assez de
  // commandants acceptés (ou épuiser la liste).
  async function collectAcceptedList(baseList, targetCount, excludeTopN, myToken) {
    const accepted = [];
    let idx = 0;
    while (accepted.length < targetCount && idx < baseList.length) {
      const batchEnd = Math.min(idx + COMMANDER_PAGE_SIZE, baseList.length);
      const batch = baseList.slice(idx, batchEnd);
      const unknown = batch.filter((c) => c.edhrecRank === undefined);
      if (unknown.length > 0) {
        els.excludeTopNStatus.style.display = "block";
        await ensureCommanderRanks(unknown, (done, total) => {
          if (myToken === renderToken) {
            els.excludeTopNStatus.textContent = t("settings.excludeTopNProgress", { done, total });
          }
        });
        if (myToken !== renderToken) return null; // un rendu plus récent a pris le relais
      }
      for (let i = idx; i < batchEnd && accepted.length < targetCount; i++) {
        const c = baseList[i];
        if (!c.edhrecRank || c.edhrecRank > excludeTopN) accepted.push(c);
      }
      idx = batchEnd;
    }
    els.excludeTopNStatus.style.display = "none";
    return { accepted, exhausted: idx >= baseList.length };
  }

  async function renderResults() {
    const myToken = ++renderToken;
    const sortBy = els.sortSelect.value;
    const filter = els.ownedFilter.value;

    let baseList = allCommanders.slice();
    if (filter === "owned") baseList = baseList.filter((c) => c.isOwned);
    if (filter === "missing") baseList = baseList.filter((c) => !c.isOwned);
    if (colorFilterSet.size > 0) baseList = baseList.filter(commanderMatchesColorFilter);

    if (sortBy === "matches") {
      baseList.sort((a, b) => b.matches.length - a.matches.length);
    } else {
      baseList.sort((a, b) => b.totalLift - a.totalLift);
    }

    const excludeTopN = Math.max(0, parseInt(els.excludeTopN.value, 10) || 0);

    let visibleList, hasMore, lazyMode;
    if (excludeTopN <= 0) {
      visibleList = baseList.slice(0, visibleCommanderCount);
      hasMore = baseList.length > visibleCommanderCount;
      lazyMode = false;
    } else {
      lazyMode = true;
      const result = await collectAcceptedList(baseList, visibleCommanderCount, excludeTopN, myToken);
      if (!result) return; // un rendu plus récent a pris le relais entre-temps
      visibleList = result.accepted;
      hasMore = !result.exhausted;
    }

    if (myToken !== renderToken) return; // idem, sécurité supplémentaire

    els.results.innerHTML = "";

    if (visibleList.length === 0) {
      els.results.innerHTML = `<p class="empty-note">${t("empty.note")}</p>`;
      return;
    }

    visibleList.forEach((c, i) => {
      const card = document.createElement("div");
      card.className = "commander-card" + (c.isOwned ? " owned" : "");
      card.dataset.slug = c.slug;

      const pips = renderPips(c.colorIdentity);

      const stampValue = c.matches.length;
      const stampUnit = c.matches.length > 1 ? t("stamp.unitPlural") : t("stamp.unitSingular");

      const INITIAL_VISIBLE = 30;
      const rowHtml = (m, idx) =>
        `<div class="row"><span class="row-name"><a class="card-hover-link" href="${m.cardUrl}" target="_blank" rel="noopener" data-card="${escapeHtml(m.cardName)}" data-commander-slug="${escapeHtml(c.slug)}" data-match-index="${idx}">${escapeHtml(m.cardName)}</a><button type="button" class="copy-btn" data-copy-text="${escapeHtml(m.cardName)}" title="${t("copy.btn")}" aria-label="${t("copy.btn")}">${COPY_ICON}</button></span><span class="lift">×${m.lift.toFixed(1)}</span></div>`;

      const matchRows = c.matches.map((m, idx) => (idx < INITIAL_VISIBLE ? rowHtml(m, idx) : "")).join("");
      const restRows = c.matches.map((m, idx) => (idx >= INITIAL_VISIBLE ? rowHtml(m, idx) : "")).join("");
      const restCount = Math.max(0, c.matches.length - INITIAL_VISIBLE);

      const metaHtml = buildMetaHtml(c);

      card.innerHTML = `
        <div class="tab"></div>
        <div class="cc-body">
          <div class="cc-head">
            <span class="cc-rank">N°${i + 1}</span>
            <h3 class="cc-name"><a class="card-hover-link" href="${c.url}" target="_blank" rel="noopener" data-card="${escapeHtml(c.name)}">${escapeHtml(c.name)}</a><button type="button" class="copy-btn" data-copy-text="${escapeHtml(c.name)}" title="${t("copy.btn")}" aria-label="${t("copy.btn")}">${COPY_ICON}</button></h3>
            <span class="cc-pips">${pips}</span>
            ${c.isOwned ? `<span class="cc-owned-flag">${t("cc.owned")}</span>` : ""}
          </div>
          <div class="cc-meta">${metaHtml}</div>
          <button class="cc-cards-toggle" type="button">${t("cc.toggleShow")}</button>
          <div class="cc-cards-list">
            ${matchRows}
            ${restCount > 0 ? `<div class="cc-cards-rest">${restRows}</div><button class="cc-cards-more" type="button">${t("cc.moreCards", { n: restCount })}</button>` : ""}
          </div>
        </div>
        <div class="stamp"><span class="n">${stampValue}</span><span class="u">${stampUnit}</span></div>
      `;

      const toggle = card.querySelector(".cc-cards-toggle");
      const listEl = card.querySelector(".cc-cards-list");
      toggle.addEventListener("click", () => {
        listEl.classList.toggle("show");
        toggle.textContent = listEl.classList.contains("show")
          ? t("cc.toggleHide")
          : t("cc.toggleShow");
      });

      const moreBtn = card.querySelector(".cc-cards-more");
      if (moreBtn) {
        moreBtn.addEventListener("click", () => {
          card.querySelector(".cc-cards-rest").classList.add("show");
          moreBtn.remove();
        });
      }

      els.results.appendChild(card);
    });

    // Charge l'identité couleur exacte uniquement pour ce qui est affiché
    // à l'écran ; les commandants déjà résolus (cache mémoire ou page
    // précédente) ne redéclenchent aucune requête.
    refineVisibleColors(visibleList);

    if (hasMore) {
      const remaining = baseList.length - visibleCommanderCount;
      const loadMoreBtn = document.createElement("button");
      loadMoreBtn.className = "btn secondary load-more-btn";
      loadMoreBtn.type = "button";
      loadMoreBtn.textContent = lazyMode
        ? t("cc.moreCommandersLazy")
        : t("cc.moreCommanders", { a: Math.min(COMMANDER_PAGE_SIZE, remaining), b: remaining });
      loadMoreBtn.addEventListener("click", () => {
        visibleCommanderCount += COMMANDER_PAGE_SIZE;
        renderResults();
      });
      els.results.appendChild(loadMoreBtn);
    }
  }

  function scryfallSearchUrl(name) {
    return "https://scryfall.com/search?q=" + encodeURIComponent('!"' + name + '"');
  }

  function renderNotFoundList(notFoundItems) {
    if (notFoundItems.length === 0) {
      lastNotFoundItems = [];
      els.notFoundPanel.style.display = "none";
      els.notFoundList.innerHTML = "";
      return;
    }
    els.notFoundPanel.style.display = "block";
    els.notFoundSummary.textContent = t("notfound.summary", { n: notFoundItems.length });
    const sorted = notFoundItems.slice().sort((a, b) => a.name.localeCompare(b.name));
    lastNotFoundItems = sorted;
    els.notFoundList.innerHTML = sorted
      .map(
        (it, idx) => `
        <li data-slug="${escapeHtml(it.slug)}">
          <a class="card-hover-link" href="${scryfallSearchUrl(it.name)}" target="_blank" rel="noopener" data-card="${escapeHtml(it.name)}" data-notfound-index="${idx}">${escapeHtml(it.name)}</a>
          <button class="retry-card-btn" type="button" title="${t("retry.title")}" aria-label="${t("retry.title")}"><span class="retry-icon">↻</span></button>
          <span class="retry-status"></span>
        </li>`
      )
      .join("");
  }

  async function retryNotFoundCard(li) {
    const slug = li.dataset.slug;
    const nameLink = li.querySelector("a");
    const name = nameLink.dataset.card;
    const btn = li.querySelector(".retry-card-btn");
    const status = li.querySelector(".retry-status");

    btn.disabled = true;
    btn.classList.add("spinning");
    status.textContent = "";

    await idbDelete(STORE_CARDS, slug);
    const { data, notFound } = await fetchCardPage(slug, name, true);

    btn.classList.remove("spinning");
    btn.blur();

    const idx = lastFetchResults.findIndex((r) => r.slug === slug);
    if (idx !== -1) lastFetchResults[idx].data = data;

    if (data && !notFound) {
      renderNotFoundList(lastNotFoundItems.filter((it) => it.slug !== slug));
      els.statNotFound.textContent = lastNotFoundItems.length;
      // Ré-agrège avec la carte nouvellement trouvée et rafraîchit l'affichage
      allCommanders = aggregate(lastFetchResults, lastMinSample);
      visibleCommanderCount = COMMANDER_PAGE_SIZE;
      renderResults();
    } else {
      btn.disabled = false;
      status.textContent = t("retry.stillNotFound");
    }
  }

  els.notFoundList.addEventListener("click", (e) => {
    const btn = e.target.closest(".retry-card-btn");
    if (!btn) return;
    retryNotFoundCard(btn.closest("li"));
  });

  const RETRY_ALL_CONCURRENCY = 4;
  let retryAllRunning = false;

  async function retryAllNotFound() {
    if (retryAllRunning || lastNotFoundItems.length === 0) return;
    retryAllRunning = true;
    const items = lastNotFoundItems.slice();
    const originalLabel = els.retryAllBtn.textContent;
    els.retryAllBtn.disabled = true;

    const results = await runPool(
      items,
      async (item) => {
        await idbDelete(STORE_CARDS, item.slug);
        return fetchCardPage(item.slug, item.name, true);
      },
      RETRY_ALL_CONCURRENCY,
      (done, total) => {
        els.retryAllBtn.textContent = t("retry.allProgress", { done, total });
      }
    );

    const stillNotFound = [];
    const fetchIndexBySlug = new Map(lastFetchResults.map((r, idx) => [r.slug, idx]));
    items.forEach((item, idx) => {
      const r = results[idx];
      const ok = r && !r.error && r.data && !r.notFound;
      const fetchIdx = fetchIndexBySlug.get(item.slug);
      if (ok) {
        if (fetchIdx !== undefined) lastFetchResults[fetchIdx].data = r.data;
      } else {
        stillNotFound.push(item);
      }
    });

    allCommanders = aggregate(lastFetchResults, lastMinSample);
    visibleCommanderCount = COMMANDER_PAGE_SIZE;
    renderResults();
    renderNotFoundList(stillNotFound);
    els.statNotFound.textContent = stillNotFound.length;
    updateClearCacheVisibility();

    els.retryAllBtn.disabled = false;
    els.retryAllBtn.textContent = originalLabel;
    retryAllRunning = false;
  }

  els.retryAllBtn.addEventListener("click", retryAllNotFound);

  // ---------------------------------------------------------------------
  // Copie du nom de carte
  // ---------------------------------------------------------------------
  function copyCardName(btn) {
    const text = btn.dataset.copyText || "";
    if (!text) return;
    const done = () => {
      btn.innerHTML = COPY_ICON_CHECK;
      btn.classList.add("copied");
      clearTimeout(btn._copyResetTimer);
      btn._copyResetTimer = setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.classList.remove("copied");
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (err) {
      /* copie impossible : on ignore silencieusement */
    }
  }

  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    copyCardName(btn);
  });

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Progress UI
  // ---------------------------------------------------------------------
  const LOG_MAX_LINES = 60;

  function logLine(msg) {
    const p = document.createElement("div");
    p.textContent = msg;
    els.progressLog.prepend(p);
    while (els.progressLog.children.length > LOG_MAX_LINES) {
      els.progressLog.removeChild(els.progressLog.lastChild);
    }
  }

  // ---------------------------------------------------------------------
  // Orchestration principale
  // ---------------------------------------------------------------------
  async function startAnalysis() {
    els.setupError.textContent = "";
    if (collection.size === 0) {
      els.setupError.textContent = t("error.noFile");
      return;
    }

    const minSample = Math.max(0, parseInt(els.minSample.value, 10) || 0);

    els.startBtn.disabled = true;
    els.progressPanel.classList.add("show");
    els.statsStrip.classList.add("show");
    els.progressLog.innerHTML = "";

    const items = Array.from(collection.values());
    let fromCache = 0;
    let found = 0;
    const notFoundItems = [];
    const seenCommanders = new Set();
    const ownedCommanderSlugs = new Set();

    progressStateKey = "progress.fetching"; els.progressLabel.textContent = t("progress.fetching");

    // Les mises à jour du panneau de progression sont throttlées : avec une
    // concurrence réseau élevée, de nombreuses requêtes se terminent dans
    // la même poignée de millisecondes, et repeindre 7-8 nœuds DOM (dont un
    // prepend dans le journal) à chaque fois ralentit inutilement le thread
    // principal — donc l'analyse elle-même. On ne redessine qu'au maximum
    // une fois tous les 100ms, avec une mise à jour finale garantie.
    let lastProgressPaint = 0;
    const PROGRESS_UI_THROTTLE_MS = 100;

    const results = await runPool(
      items,
      async (item) => {
        const { data, fromCache: fc, notFound } = await fetchCardPage(item.slug, item.name);
        if (fc) fromCache++;
        if (data && !notFound) {
          found++;
          // Source de vérité : le champ "legal_commander" fourni par EDHREC
          // sur la carte elle-même (couvre les créatures légendaires, mais
          // aussi les planeswalkers-commandants type Daretti, etc.) — pas une
          // inférence par co-occurrence avec d'autres cartes.
          if (extractLegalCommander(data)) ownedCommanderSlugs.add(item.slug);
          for (const cv of extractCommanderLists(data)) {
            if (cv.potential_decks >= minSample) {
              seenCommanders.add(cv.sanitized || cv.slug || cv.name);
            }
          }
        } else {
          notFoundItems.push({ name: item.name, slug: item.slug });
        }
        return { slug: item.slug, name: item.name, qty: item.qty, data };
      },
      FETCH_CONCURRENCY,
      (done, total, item) => {
        const now = Date.now();
        const isLast = done === total;
        if (!isLast && now - lastProgressPaint < PROGRESS_UI_THROTTLE_MS) return;
        lastProgressPaint = now;
        els.progressCount.textContent = done + " / " + total;
        els.progressFill.style.width = Math.round((done / total) * 100) + "%";
        logLine("→ " + item.name);
        els.statCards.textContent = total;
        els.statFound.textContent = found;
        els.statCache.textContent = fromCache;
        els.statCommanders.textContent = seenCommanders.size;
        els.statOwnedCommanders.textContent = ownedCommanderSlugs.size;
        els.statNotFound.textContent = notFoundItems.length;
      }
    );

    lastFetchResults = results;
    lastMinSample = minSample;

    // Pré-chauffe le cache d'images en tâche de fond (non bloquant, faible
    // concurrence) : les cartes de la collection importée sont exactement
    // celles qui vont apparaître dans les résultats et être survolées
    // ensuite pour l'aperçu. Volontairement non "await" pour ne pas
    // retarder l'affichage des résultats.
    prewarmImageCache(items.map((it) => it.name));

    progressStateKey = "progress.aggregating"; els.progressLabel.textContent = t("progress.aggregating");
    allCommanders = aggregate(results, minSample);

    els.statCommanders.textContent = allCommanders.length;
    els.statOwnedCommanders.textContent = ownedCommanderSlugs.size;
    els.statNotFound.textContent = notFoundItems.length;
    progressStateKey = "progress.done"; els.progressLabel.textContent = t("progress.done");
    els.progressFill.style.width = "100%";

    renderNotFoundList(notFoundItems);

    els.resultsTitle.style.display = "block";
    els.resultsNote.style.display = "block";
    els.filterBar.classList.add("show");

    visibleCommanderCount = COMMANDER_PAGE_SIZE;
    renderResults();
    updateClearCacheVisibility();
    els.resultsTitle.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------------------------------------------------------------------
  // Événements UI
  // ---------------------------------------------------------------------
  function updateFileChipLabel() {
    if (!currentFileLabel) return;
    els.fileChip.textContent = t(
      currentFileLabel.restored ? "file.uniqueCardsRestored" : "file.uniqueCards",
      { file: currentFileLabel.fileName, count: currentFileLabel.count }
    );
  }

  function updateRestoreBtnLabel() {
    if (!lastSessionInfo) return;
    els.restoreSessionBtn.textContent = t("session.restoreLabel", {
      file: lastSessionInfo.fileName,
      count: lastSessionInfo.count,
    });
  }

  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        collection = parseMoxfieldCsv(reader.result);
        els.fileChip.style.display = "inline-block";
        currentFileLabel = { fileName: file.name, count: collection.size, restored: false };
        updateFileChipLabel();
        els.startBtn.disabled = false;
        els.setupError.textContent = "";
        saveSession(file.name);
      } catch (err) {
        els.setupError.textContent = t("error.readError", { msg: err.message });
        els.startBtn.disabled = true;
      }
    };
    reader.readAsText(file);
  }

  async function saveSession(fileName) {
    await idbSet(STORE_SESSION, {
      key: "lastCollection",
      fileName,
      items: Array.from(collection.values()),
      savedAt: Date.now(),
    });
  }

  async function updateClearCacheVisibility() {
    const [a, b] = await Promise.all([idbCount(STORE_CARDS), idbCount(STORE_COMMANDERS)]);
    els.clearCacheBtn.style.display = a + b > 0 ? "inline-block" : "none";
  }

  async function checkForSavedSession() {
    const saved = await idbGet(STORE_SESSION, "lastCollection");
    if (saved && saved.items && saved.items.length > 0) {
      els.restoreSessionBtn.style.display = "inline-block";
      lastSessionInfo = { fileName: saved.fileName, count: saved.items.length };
      updateRestoreBtnLabel();
    }
    updateClearCacheVisibility();
  }

  els.restoreSessionBtn.addEventListener("click", async () => {
    const saved = await idbGet(STORE_SESSION, "lastCollection");
    if (!saved || !saved.items) return;
    collection = new Map(saved.items.map((it) => [it.slug, it]));
    els.fileChip.style.display = "inline-block";
    currentFileLabel = { fileName: saved.fileName, count: collection.size, restored: true };
    updateFileChipLabel();
    els.startBtn.disabled = false;
    els.setupError.textContent = "";
  });

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
  ["dragover", "dragenter"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove("drag"); })
  );
  els.dropzone.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

  const MIN_SAMPLE_KEY = "moxedh_min_sample";
  try {
    const savedMinSample = localStorage.getItem(MIN_SAMPLE_KEY);
    if (savedMinSample !== null && savedMinSample !== "") {
      els.minSample.value = savedMinSample;
    }
  } catch (e) {}
  els.minSample.addEventListener("change", () => {
    try { localStorage.setItem(MIN_SAMPLE_KEY, els.minSample.value); } catch (e) {}
  });

  const RANK_FETCH_CONCURRENCY = 8;

  // Récupère le rang EDHREC réel des commandants qui ne l'ont pas encore
  // (mise en cache via fetchCommanderPage, donc peu coûteux la fois
  // suivante). N'affecte que les commandants passés en paramètre : c'est
  // renderResults() qui décide lesquels sont réellement nécessaires
  // (seulement ceux qui pourraient apparaître sur la page courante), pas
  // l'ensemble des commandants candidats de l'analyse.
  async function ensureCommanderRanks(commanders, onProgress) {
    const missing = commanders.filter((c) => c.edhrecRank === undefined);
    if (missing.length === 0) return;
    await runPool(
      missing,
      async (c) => {
        const data = await fetchCommanderPage(c.slug);
        c.edhrecRank = data ? extractCommanderRank(data) : null;
        // Autant en profiter : cette page contient aussi l'identité couleur
        // exacte, ce qui évite une requête séparée pour refineVisibleColors.
        if (data && !c.colorExact) {
          c.colorIdentity = extractColorIdentity(data);
          c.colorExact = true;
        }
      },
      RANK_FETCH_CONCURRENCY,
      onProgress
    );
  }

  const EXCLUDE_TOP_N_KEY = "moxedh_exclude_top_n";
  try {
    const savedExcludeTopN = localStorage.getItem(EXCLUDE_TOP_N_KEY);
    if (savedExcludeTopN !== null && savedExcludeTopN !== "") {
      els.excludeTopN.value = savedExcludeTopN;
    }
  } catch (e) {}
  els.excludeTopN.addEventListener("change", () => {
    try { localStorage.setItem(EXCLUDE_TOP_N_KEY, els.excludeTopN.value); } catch (e) {}
    if (allCommanders.length) {
      visibleCommanderCount = COMMANDER_PAGE_SIZE;
      renderResults();
    }
  });

  els.startBtn.addEventListener("click", startAnalysis);
  // Le re-rendu (mise à jour du DOM/layout) est différé au tick suivant :
  // sur certains navigateurs mobiles, mettre à jour la mise en page
  // pendant que le picker natif du <select> se referme peut le faire
  // se rouvrir tout seul juste après (visible en tapant le dernier
  // élément de la liste puis en changeant de valeur plusieurs fois).
  els.sortSelect.addEventListener("change", () => {
    setTimeout(() => { visibleCommanderCount = COMMANDER_PAGE_SIZE; renderResults(); }, 0);
  });
  els.ownedFilter.addEventListener("change", () => {
    setTimeout(() => { visibleCommanderCount = COMMANDER_PAGE_SIZE; renderResults(); }, 0);
  });

  function updateColorFilterClearVisibility() {
    els.colorFilterClear.style.display = colorFilterSet.size > 0 ? "inline-block" : "none";
  }

  els.colorFilterMode.addEventListener("change", () => {
    if (colorFilterSet.size > 0) {
      setTimeout(() => { visibleCommanderCount = COMMANDER_PAGE_SIZE; renderResults(); }, 0);
    }
  });

  document.querySelectorAll(".color-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const color = btn.dataset.color;
      const pressed = btn.getAttribute("aria-pressed") === "true";
      if (pressed) {
        colorFilterSet.delete(color);
        btn.setAttribute("aria-pressed", "false");
      } else {
        // "Incolore" et les couleurs sont mutuellement exclusifs : une
        // identité ne peut pas être à la fois vide et colorée.
        if (color === "C") {
          colorFilterSet.clear();
          document.querySelectorAll(".color-toggle").forEach((b) => b.setAttribute("aria-pressed", "false"));
        } else if (colorFilterSet.has("C")) {
          colorFilterSet.delete("C");
          els.colorFilter.querySelector('[data-color="C"]').setAttribute("aria-pressed", "false");
        }
        colorFilterSet.add(color);
        btn.setAttribute("aria-pressed", "true");
      }
      updateColorFilterClearVisibility();
      visibleCommanderCount = COMMANDER_PAGE_SIZE;
      renderResults();
    });
  });

  els.colorFilterClear.addEventListener("click", () => {
    colorFilterSet.clear();
    document.querySelectorAll(".color-toggle").forEach((b) => b.setAttribute("aria-pressed", "false"));
    updateColorFilterClearVisibility();
    visibleCommanderCount = COMMANDER_PAGE_SIZE;
    renderResults();
  });
  els.clearCacheBtn.addEventListener("click", async () => {
    await idbClearAll();
    imageUrlMemCache.clear();
    els.restoreSessionBtn.style.display = "none";
    els.clearCacheBtn.style.display = "none";
    logLine(t("log.cacheCleared"));
  });

  // -------------------------------------------------------------------
  // Aperçu carte au survol (desktop) / au premier tap (mobile)
  // -------------------------------------------------------------------
  const cardPreview = $("cardPreview");
  const cardPreviewFrame = $("cardPreviewFrame");
  const cardPreviewImg = $("cardPreviewImg");
  const cardPreviewBackdrop = $("cardPreviewBackdrop");
  const cardPreviewMeta = $("cardPreviewMeta");
  const cardPreviewHint = $("cardPreviewHint");
  const cpPrevBtn = $("cpPrevBtn");
  const cpNextBtn = $("cpNextBtn");
  const supportsHover =
    window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  let armedLink = null;
  let currentPreviewUrl = null;
  let navMode = null; // "commander" | "notfound" | null
  let navCommanderSlug = null;
  let navIndex = -1;

  let previewToken = 0;
  const imageUrlMemCache = new Map(); // nom de carte -> URL CDN Scryfall résolue (cache mémoire, session)
  const IMAGE_URL_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 jours

  // Résout le nom d'une carte vers ses URLs d'image directes sur le CDN
  // Scryfall (cards.scryfall.io), au lieu de réinterroger à chaque survol
  // le point d'entrée /cards/named?...&format=image (recherche floue +
  // redirection, soumis aux limites de débit de l'API Scryfall). Le
  // résultat ({small, large}) est mis en cache en mémoire puis dans
  // IndexedDB : au bout d'un moment de défilement, la grande majorité des
  // cartes déjà vues se résolvent instantanément sans requête réseau, ce
  // qui évite le "cadre blanc" observé après une longue session de survol.
  // On récupère à la fois "small" (léger, affiché en premier pour un
  // rendu quasi instantané) et "large" (qualité finale, chargée en
  // arrière-plan puis substituée une fois prête).
  async function resolveScryfallImageUrl(name) {
    if (imageUrlMemCache.has(name)) return imageUrlMemCache.get(name);

    const cached = await idbGet(STORE_IMAGES, name);
    if (cached && (cached.small || cached.url) && Date.now() - cached.fetchedAt < IMAGE_URL_MAX_AGE_MS) {
      // Compat avec les anciennes entrées de cache (avant l'ajout du
      // couple small/large) qui ne stockaient qu'un champ "url".
      const urls = { small: cached.small || cached.url, large: cached.large || cached.url };
      imageUrlMemCache.set(name, urls);
      return urls;
    }

    try {
      const apiUrl = "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name);
      const res = await fetchWithTimeout(apiUrl);
      if (!res.ok) return null;
      const json = await res.json();
      const faceImages = json.image_uris || (json.card_faces && json.card_faces[0] && json.card_faces[0].image_uris);
      if (!faceImages) return null;
      const large = faceImages.large || faceImages.normal || faceImages.png;
      const small = faceImages.small || large;
      if (!large && !small) return null;
      const urls = { small, large: large || small };
      imageUrlMemCache.set(name, urls);
      idbSet(STORE_IMAGES, { name, small: urls.small, large: urls.large, fetchedAt: Date.now() });
      return urls;
    } catch (err) {
      return null;
    }
  }

  const IMAGE_PREWARM_CONCURRENCY = 4; // discret : ne doit pas concurrencer les requêtes prioritaires (cartes/commandants)

  // Pré-résout en arrière-plan (faible concurrence, non bloquant) les
  // images des cartes fournies. Appelé juste après l'analyse principale
  // avec les noms de la collection importée : ce sont précisément les
  // cartes qui apparaîtront dans les listes de résultats (matches de
  // commandants, cartes non trouvées), donc les plus susceptibles d'être
  // survolées ensuite. Au moment du survol, resolveScryfallImageUrl
  // trouve déjà l'entrée en cache mémoire/IndexedDB : plus de requête
  // réseau visible, l'aperçu s'affiche immédiatement.
  async function prewarmImageCache(names) {
    const uniqueNames = Array.from(new Set(names));
    await runPool(uniqueNames, (name) => resolveScryfallImageUrl(name), IMAGE_PREWARM_CONCURRENCY);
  }

  cardPreviewImg.addEventListener("load", () => {
    cardPreviewImg.classList.add("loaded");
    cardPreviewFrame.classList.add("loaded");
  });
  cardPreviewImg.addEventListener("error", () => {
    const token = previewToken;
    const failedSrc = cardPreviewImg.src;
    const attempt = parseInt(cardPreviewImg.dataset.retryCount || "0", 10);
    if (attempt < 2 && failedSrc) {
      // Une image CDN peut occasionnellement échouer sans que le lien soit
      // mauvais (Wi-Fi capricieux, hoquet ponctuel) : on retente avec un
      // backoff progressif avant d'abandonner.
      cardPreviewImg.dataset.retryCount = String(attempt + 1);
      setTimeout(() => {
        if (token !== previewToken) return; // une autre carte a été survolée entre-temps
        cardPreviewImg.src = failedSrc;
      }, 400 * (attempt + 1));
      return;
    }
    cardPreviewFrame.classList.add("loaded"); // arrête le spinner même en cas d'échec définitif
  });

  let previewLoadTimer = null;
  function renderPreviewFor(name, url) {
    previewToken++;
    const token = previewToken;
    clearTimeout(previewLoadTimer);
    cardPreviewImg.dataset.retryCount = "0";
    cardPreviewImg.classList.remove("loaded");
    cardPreviewFrame.classList.remove("loaded");
    cardPreviewImg.removeAttribute("src");
    cardPreviewImg.alt = name;
    currentPreviewUrl = url;

    // Si la carte est déjà résolue (cache mémoire, typiquement pré-chauffé
    // en arrière-plan via prewarmImageCache), on saute le débounce :
    // aucune requête réseau à protéger, autant afficher tout de suite.
    const delay = imageUrlMemCache.has(name) ? 0 : 90;

    // Léger débounce avant de lancer la requête réseau : protège aussi
    // bien un survol rapide sur toute une liste qu'un clic répété sur les
    // flèches de navigation de l'aperçu (même carte affichée plusieurs
    // fois par seconde sinon).
    previewLoadTimer = setTimeout(() => {
      resolveScryfallImageUrl(name).then((urls) => {
        if (token !== previewToken) return; // une autre carte a été affichée entre-temps
        if (!urls) {
          cardPreviewFrame.classList.add("loaded"); // pas d'image trouvée, on arrête le spinner
          return;
        }
        // Affichage progressif : la vignette "small" (légère) apparaît en
        // premier pour un rendu quasi instantané, puis on la remplace par
        // "large" une fois celle-ci chargée en arrière-plan — sans jamais
        // faire attendre l'utilisateur devant un cadre vide.
        cardPreviewImg.src = urls.small;
        if (urls.large && urls.large !== urls.small) {
          const hiRes = new Image();
          hiRes.onload = () => {
            if (token !== previewToken) return; // carte changée entre-temps
            cardPreviewImg.src = urls.large;
          };
          hiRes.src = urls.large;
        }
      });
    }, delay);
  }

  function updatePreviewNavUI() {
    cardPreviewHint.textContent = t(navMode === "notfound" ? "preview.hintScryfall" : "preview.hint");

    if (navMode === "commander" && navCommanderSlug && navIndex >= 0) {
      const commander = allCommanders.find((c) => c.slug === navCommanderSlug);
      if (commander) {
        if (!supportsHover) cardPreview.classList.add("has-nav");
        cpPrevBtn.disabled = navIndex <= 0;
        cpNextBtn.disabled = navIndex >= commander.matches.length - 1;
        const m = commander.matches[navIndex];
        cardPreviewMeta.innerHTML = t("preview.meta", {
          name: escapeHtml(m.cardName),
          lift: '<span class="cp-lift">' + m.lift.toFixed(1) + "</span>",
          i: navIndex + 1,
          n: commander.matches.length,
        });
        return;
      }
    }
    if (navMode === "notfound" && navIndex >= 0 && lastNotFoundItems.length) {
      if (!supportsHover) cardPreview.classList.add("has-nav");
      cpPrevBtn.disabled = navIndex <= 0;
      cpNextBtn.disabled = navIndex >= lastNotFoundItems.length - 1;
      cardPreviewMeta.innerHTML = t("preview.notfoundMeta", {
        name: escapeHtml(lastNotFoundItems[navIndex].name),
        i: navIndex + 1,
        n: lastNotFoundItems.length,
      });
      return;
    }
    cardPreview.classList.remove("has-nav");
    cardPreviewMeta.innerHTML = "";
  }

  function navigatePreview(delta) {
    if (navIndex < 0) return;
    const newIndex = navIndex + delta;

    if (navMode === "commander" && navCommanderSlug) {
      const commander = allCommanders.find((c) => c.slug === navCommanderSlug);
      if (!commander || newIndex < 0 || newIndex >= commander.matches.length) return;
      navIndex = newIndex;
      const m = commander.matches[navIndex];
      renderPreviewFor(m.cardName, m.cardUrl);
      updatePreviewNavUI();
    } else if (navMode === "notfound") {
      if (newIndex < 0 || newIndex >= lastNotFoundItems.length) return;
      navIndex = newIndex;
      const it = lastNotFoundItems[navIndex];
      renderPreviewFor(it.name, scryfallSearchUrl(it.name));
      updatePreviewNavUI();
    }
  }

  cpPrevBtn.addEventListener("click", (e) => { e.stopPropagation(); navigatePreview(-1); });
  cpNextBtn.addEventListener("click", (e) => { e.stopPropagation(); navigatePreview(1); });

  // Clic sur l'image agrandie elle-même = ouvre sa page (EDHREC ou Scryfall
  // selon le contexte), sauf si le clic vise une des flèches de navigation.
  cardPreviewFrame.addEventListener("click", (e) => {
    if (e.target.closest(".cp-arrow")) return;
    if (currentPreviewUrl) window.open(currentPreviewUrl, "_blank", "noopener");
  });

  function showCardPreview(link, touchMode) {
    const name = link.dataset.card;

    if (link.dataset.commanderSlug) {
      navMode = "commander";
      navCommanderSlug = link.dataset.commanderSlug;
      navIndex = link.dataset.matchIndex != null ? parseInt(link.dataset.matchIndex, 10) : -1;
    } else if (link.dataset.notfoundIndex != null) {
      navMode = "notfound";
      navCommanderSlug = null;
      navIndex = parseInt(link.dataset.notfoundIndex, 10);
    } else {
      navMode = null;
      navCommanderSlug = null;
      navIndex = -1;
    }

    renderPreviewFor(name, link.href);
    updatePreviewNavUI();

    cardPreview.classList.add("show");
    cardPreview.classList.toggle("touch-mode", !!touchMode);
    cardPreviewBackdrop.classList.toggle("touch-active", !!touchMode);
    cardPreviewBackdrop.classList.add("show");
  }

  function hideCardPreview() {
    cardPreview.classList.remove("show", "touch-mode", "has-nav");
    cardPreviewBackdrop.classList.remove("show", "touch-active");
    armedLink = null;
    navMode = null;
    navCommanderSlug = null;
    navIndex = -1;
  }

  // Délégation d'événements sur tout le document : les liens de cartes sont
  // recréés dynamiquement à la fois dans les résultats et dans la liste des
  // cartes non trouvées.
  let hoverTimer = null;
  document.body.addEventListener("mouseover", (e) => {
    if (!supportsHover) return;
    const link = e.target.closest(".card-hover-link");
    if (!link) return;
    clearTimeout(hoverTimer);
    // Petit délai pour éviter de lancer une requête d'image par carte
    // survolée lors d'un passage rapide de la souris sur toute une liste.
    hoverTimer = setTimeout(() => showCardPreview(link, false), 100);
  });
  document.body.addEventListener("mouseout", (e) => {
    if (!supportsHover) return;
    const link = e.target.closest(".card-hover-link");
    if (link) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
      hideCardPreview();
    }
  });
  document.body.addEventListener("click", (e) => {
    if (supportsHover) return; // souris réelle : le survol suffit, clic = navigation normale
    const link = e.target.closest(".card-hover-link");
    if (!link) return;
    if (armedLink === link) {
      // deuxième tap sur la même carte : on laisse la navigation se faire
      armedLink = null;
      hideCardPreview();
      return;
    }
    e.preventDefault();
    armedLink = link;
    showCardPreview(link, true);
  });
  cardPreviewBackdrop.addEventListener("click", hideCardPreview);

  // -------------------------------------------------------------------
  // Thème sombre (défaut) / clair
  // -------------------------------------------------------------------
  const themeToggle = $("themeToggle");
  function applyTheme(light) {
    if (light) document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    themeToggle.setAttribute("aria-pressed", light ? "true" : "false");
    const label = t(light ? "theme.toDark" : "theme.toLight");
    themeToggle.title = label;
    themeToggle.setAttribute("aria-label", label);
  }
  applyTheme(document.documentElement.getAttribute("data-theme") === "light");
  themeToggle.addEventListener("click", () => {
    const light = document.documentElement.getAttribute("data-theme") !== "light";
    applyTheme(light);
    try { localStorage.setItem("moxedh_theme", light ? "light" : "dark"); } catch (e) {}
  });

  // -------------------------------------------------------------------
  // Langue FR / EN
  // -------------------------------------------------------------------
  const langToggle = $("langToggle");
  function applyLang() {
    document.title = "M.E.C.A — Moxfield x EDHREC Collection Analyser";
    applyI18n();
    langToggle.setAttribute("aria-pressed", currentLang === "en" ? "true" : "false");
    const nextLabel = t("lang.switchTo");
    langToggle.title = nextLabel;
    langToggle.setAttribute("aria-label", nextLabel);
    applyTheme(document.documentElement.getAttribute("data-theme") === "light");
    updateFileChipLabel();
    updateRestoreBtnLabel();
    els.progressLabel.textContent = t(progressStateKey);
    if (allCommanders.length) renderResults();
    if (lastNotFoundItems.length) renderNotFoundList(lastNotFoundItems);
    if (cardPreview.classList.contains("show")) updatePreviewNavUI();
  }
  langToggle.addEventListener("click", () => {
    currentLang = currentLang === "en" ? "fr" : "en";
    try { localStorage.setItem(LANG_KEY, currentLang); } catch (e) {}
    applyLang();
  });
  applyLang();

  openDb().then((_db) => {
    db = _db;
    checkForSavedSession();
  }).catch(() => {
    els.setupError.textContent = t("error.noIndexedDb");
  });
})();
