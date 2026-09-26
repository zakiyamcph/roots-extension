// Roots — content script
// Injected on demand (via chrome.scripting.executeScript) into the active tab.
// Scans visible text nodes for Arabic verbs it recognizes, wraps them for the
// hover root/form popover, flags low-frequency vocabulary for the heatmap, and
// exposes a floating action button that toggles diacritics on a selection.
//
// Two isolation strategies are used deliberately:
//  1. The inline word spans live in the page's own DOM (they must flow with
//     the surrounding text), so they only ever touch attribute-scoped classes
//     defined in content.css (e.g. [data-roots-word]) — never bare element
//     selectors — so they cannot leak style onto the host page.
//  2. All the extension's own UI chrome (popover, floating button) renders
//     inside a single Shadow DOM host, fully isolated in both directions from
//     the page's stylesheet.

(function () {
  if (window.__rootsInjected) return;
  window.__rootsInjected = true;

  const DIACRITIC_RE = /[ً-ٰٟۖ-ۭـ]/g;
  // Broad Arabic block, but each character is excluded via lookahead if it's
  // punctuation (Arabic comma/semicolon/question mark etc.) or a digit
  // (Arabic-Indic / Extended) rather than a letter, diacritic, or tatweel —
  // otherwise a trailing comma would stay glued to a word (breaking lexicon
  // lookup) and digits would get heat-flagged as vocabulary.
  const ARABIC_WORD_RE = /(?:(?![\u0600-\u0605\u060C\u061B\u061E\u061F\u0660-\u066D\u06D4\u06DD\u06DE\u06E9\u06F0-\u06F9])[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF])+/g;
  const MAX_WRAPPED_WORDS = 6000; // safety cap for very large pages

  // Includes the four imperfective (present-tense) prefixes ي/ت/ن/ا (the hamza
  // variant أ is already folded to ا by normalize() before stripping runs),
  // alongside attached clitics, the definite article, and common combos.
  // Extra false-positive stems from this are harmless — they simply won't be
  // found in the closed lexicon/frequency lookup.
  const PREFIXES = ["بال", "كال", "فال", "وال", "لل", "ال", "س", "سي", "و", "ف", "ب", "ك", "ل", "ي", "ت", "ن", "ا"];
  const SUFFIXES = ["هما", "كما", "تما", "ون", "ين", "ات", "هم", "هن", "كم", "كن", "نا", "تم", "تن", "ها", "وا", "ة", "ه", "ك", "ي", "ت", "ا"];

  const state = {
    settings: null,
    lexicon: null, // Map<normalizedKey, entry>
    frequency: null, // { high: Set, medium: Set }
    active: false,
    stats: { verbs: 0, advanced: 0 },
  };

  // ---------------------------------------------------------------------
  // Normalization + lightweight affix stripping
  // ---------------------------------------------------------------------

  function stripDiacritics(text) {
    return text.replace(DIACRITIC_RE, "");
  }

  function normalize(word) {
    return stripDiacritics(word)
      .replace(/[إأآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي");
  }

  function candidateStems(word) {
    const candidates = new Set([word]);
    for (const p of PREFIXES) {
      if (word.startsWith(p) && word.length - p.length >= 2) {
        candidates.add(word.slice(p.length));
      }
    }
    const withoutPrefix = [...candidates];
    for (const base of withoutPrefix) {
      for (const s of SUFFIXES) {
        if (base.endsWith(s) && base.length - s.length >= 2) {
          candidates.add(base.slice(0, base.length - s.length));
        }
      }
    }
    return candidates;
  }

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------

  async function loadData() {
    const [lexiconRes, freqRes] = await Promise.all([
      fetch(chrome.runtime.getURL("src/data/lexicon.json")),
      fetch(chrome.runtime.getURL("src/data/frequency.json")),
    ]);
    const lexiconJson = await lexiconRes.json();
    const freqJson = await freqRes.json();

    const lexicon = new Map();
    for (const [key, entry] of Object.entries(lexiconJson.roots)) {
      lexicon.set(normalize(key), { key, ...entry });
    }

    const frequency = {
      high: new Set(freqJson.high.map(normalize)),
      medium: new Set(freqJson.medium.map(normalize)),
    };

    return { lexicon, frequency };
  }

  function lookupLexicon(rawWord) {
    const norm = normalize(rawWord);
    for (const stem of candidateStems(norm)) {
      if (state.lexicon.has(stem)) return state.lexicon.get(stem);
    }
    return null;
  }

  function frequencyTier(rawWord) {
    const norm = normalize(rawWord);
    for (const stem of candidateStems(norm)) {
      if (state.frequency.high.has(stem)) return "high";
      if (state.frequency.medium.has(stem)) return "medium";
    }
    return "low";
  }

  function shouldHeatmap(rawWord, tier) {
    const sensitivity = state.settings.heatmapSensitivity;
    if (tier !== "low") {
      return sensitivity === "high" && tier === "medium";
    }
    if (sensitivity === "low") return normalize(rawWord).length >= 6;
    return true; // medium + high sensitivity flag all low-tier words
  }

  // ---------------------------------------------------------------------
  // DOM scanning
  // ---------------------------------------------------------------------

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "NOSCRIPT", "IFRAME", "CODE", "PRE"]);

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        // closest() includes the element itself, so this also rejects the
        // text child of a span we already wrapped (matters if a scan ever
        // runs twice on the same DOM — otherwise it would nest spans).
        if (parent.closest("[data-roots-ui], [data-roots-word]")) return NodeFilter.FILTER_REJECT;
        if (parent.closest("svg")) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (!ARABIC_WORD_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        ARABIC_WORD_RE.lastIndex = 0;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function buildWordSpan(rawWord) {
    const lexEntry = state.settings.rootVisualizer ? lookupLexicon(rawWord) : null;
    const tier = frequencyTier(rawWord);
    const flagHeat = state.settings.heatmap && !lexEntry && shouldHeatmap(rawWord, tier);

    if (!lexEntry && !flagHeat) return null;

    const span = document.createElement("span");
    span.setAttribute("data-roots-word", "");
    span.dataset.original = rawWord;

    if (lexEntry) {
      const formI = lexEntry.forms.I;
      const vocalized = formI ? formI.verb : rawWord;
      span.setAttribute("data-roots-verb", "");
      span.dataset.rootsKey = lexEntry.key;
      span.dataset.vocalized = vocalized;
      span.dataset.showingVocalized = state.settings.diacritics ? "true" : "false";
      span.textContent = state.settings.diacritics ? vocalized : rawWord;
      state.stats.verbs++;
    } else {
      span.setAttribute("data-roots-heat", "");
      span.dataset.tier = tier;
      span.textContent = rawWord;
      state.stats.advanced++;
    }

    return span;
  }

  function wrapTextNode(node) {
    const text = node.nodeValue;
    ARABIC_WORD_RE.lastIndex = 0;
    let match;
    let lastIndex = 0;
    const frag = document.createDocumentFragment();
    let wrappedAny = false;

    while ((match = ARABIC_WORD_RE.exec(text))) {
      if (wrappedCount >= MAX_WRAPPED_WORDS) break;
      const word = match[0];
      if (word.length < 2) continue;

      const span = buildWordSpan(word);
      if (!span) continue;

      frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      frag.appendChild(span);
      lastIndex = match.index + word.length;
      wrappedAny = true;
      wrappedCount++;
    }

    if (!wrappedAny) return;
    frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    node.replaceWith(frag);
  }

  let wrappedCount = 0;

  function scanPage() {
    wrappedCount = 0;
    state.stats = { verbs: 0, advanced: 0 };
    const nodes = collectTextNodes(document.body);
    for (const node of nodes) {
      if (wrappedCount >= MAX_WRAPPED_WORDS) break;
      wrapTextNode(node);
    }
    reportStats();
  }

  function unwrapPage() {
    const spans = document.querySelectorAll("[data-roots-word]");
    for (const span of spans) {
      span.replaceWith(document.createTextNode(span.dataset.original ?? span.textContent));
    }
  }

  function reportStats() {
    chrome.runtime.sendMessage({ type: "ROOTS_STATS", stats: state.stats }).catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Shadow DOM UI: popover + floating diacritic button
  // ---------------------------------------------------------------------

  let shadowRoot, popoverEl, floatingBtnEl;

  function buildShadowUI() {
    const host = document.createElement("div");
    host.setAttribute("data-roots-ui", "");
    host.style.all = "initial";
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = SHADOW_CSS;
    shadowRoot.appendChild(style);

    popoverEl = document.createElement("div");
    popoverEl.className = "roots-popover";
    popoverEl.hidden = true;
    shadowRoot.appendChild(popoverEl);

    floatingBtnEl = document.createElement("button");
    floatingBtnEl.className = "roots-float-btn";
    floatingBtnEl.type = "button";
    floatingBtnEl.textContent = "🔤 Diacritics";
    floatingBtnEl.hidden = true;
    floatingBtnEl.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
    floatingBtnEl.addEventListener("click", onToggleDiacriticsClick);
    shadowRoot.appendChild(floatingBtnEl);

    popoverEl.addEventListener("mouseenter", () => (popoverPinned = true));
    popoverEl.addEventListener("mouseleave", () => {
      popoverPinned = false;
      hidePopoverSoon();
    });
  }

  function destroyShadowUI() {
    const host = document.querySelector("[data-roots-ui]");
    if (host) host.remove();
    shadowRoot = popoverEl = floatingBtnEl = null;
  }

  function applyTheme() {
    if (!shadowRoot) return;
    shadowRoot.host.setAttribute("data-theme", state.settings.theme);
    shadowRoot.host.setAttribute("data-font", state.settings.fontFamily);
    shadowRoot.host.style.setProperty("--roots-font-scale", state.settings.fontScale);
    document.documentElement.setAttribute("data-roots-theme", state.settings.theme);
  }

  function renderPopover(entry, anchorRect) {
    const rootLetters = entry.root;
    const formsHtml = Object.entries(entry.forms)
      .map(
        ([numeral, f]) => `
        <tr>
          <td class="roots-form-num">${numeral}</td>
          <td class="roots-form-verb">${f.verb}</td>
          <td class="roots-form-translit">${f.transliteration}</td>
          <td class="roots-form-meaning">${escapeHtml(f.meaning)}</td>
        </tr>`
      )
      .join("");

    popoverEl.innerHTML = `
      <div class="roots-popover-header">
        <span class="roots-root-letters">${rootLetters}</span>
        <span class="roots-core-meaning">${escapeHtml(entry.meaningCore)}</span>
      </div>
      <p class="roots-definition">${escapeHtml(entry.definition)}</p>
      <table class="roots-forms-table">
        <thead>
          <tr><th>Form</th><th>Verb</th><th>Translit.</th><th>Meaning</th></tr>
        </thead>
        <tbody>${formsHtml}</tbody>
      </table>
    `;

    positionFloating(popoverEl, anchorRect);
    popoverEl.hidden = false;
  }

  function positionFloating(el, anchorRect) {
    el.hidden = false; // must be visible to measure
    const margin = 8;
    const elRect = el.getBoundingClientRect();
    let top = anchorRect.bottom + margin;
    let left = anchorRect.left;

    if (top + elRect.height > window.innerHeight) {
      top = anchorRect.top - elRect.height - margin;
    }
    if (left + elRect.width > window.innerWidth) {
      left = Math.max(8, window.innerWidth - elRect.width - 8);
    }
    el.style.top = `${Math.max(8, top)}px`;
    el.style.left = `${Math.max(8, left)}px`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  let popoverPinned = false;
  let hideTimer = null;

  function hidePopoverSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!popoverPinned) popoverEl.hidden = true;
    }, 150);
  }

  function onMouseOver(e) {
    const span = e.target.closest?.("[data-roots-verb]");
    if (!span) return;
    const entry = state.lexicon.get(normalize(span.dataset.rootsKey));
    if (!entry) return;
    clearTimeout(hideTimer);
    renderPopover(entry, span.getBoundingClientRect());
  }

  function onMouseOut(e) {
    const span = e.target.closest?.("[data-roots-verb]");
    if (!span) return;
    hidePopoverSoon();
  }

  function onSelectionChange() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      floatingBtnEl.hidden = true;
      return;
    }
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const containerEl = container.nodeType === 1 ? container : container.parentElement;
    if (!containerEl || containerEl.closest("[data-roots-ui]")) return;

    const verbSpans = [...document.querySelectorAll("[data-roots-verb]")].filter((s) => range.intersectsNode(s));
    if (verbSpans.length === 0) {
      floatingBtnEl.hidden = true;
      return;
    }
    floatingBtnEl.dataset.targets = "pending";
    floatingBtnEl.__targets = verbSpans;
    const rect = range.getBoundingClientRect();
    positionFloating(floatingBtnEl, rect);
  }

  function onToggleDiacriticsClick() {
    const targets = floatingBtnEl.__targets || [];
    for (const span of targets) {
      const showing = span.dataset.showingVocalized === "true";
      span.textContent = showing ? span.dataset.original : span.dataset.vocalized;
      span.dataset.showingVocalized = showing ? "false" : "true";
    }
    floatingBtnEl.hidden = true;
  }

  const SHADOW_CSS = `
    :host {
      all: initial;
      --roots-font-scale: 1;
    }
    :host([data-theme="light"]) {
      --bg: #ffffff; --fg: #1a1a1a; --border: #e2e2e2; --accent: #0d5e59; --accent-soft: #e6f3f1;
    }
    :host([data-theme="dark"]) {
      --bg: #1c2321; --fg: #f2f2f2; --border: #3a4341; --accent: #4fd1c5; --accent-soft: #24413d;
    }
    :host([data-theme="sepia"]) {
      --bg: #f4ecd8; --fg: #3b2f22; --border: #dcccaa; --accent: #8a5a2b; --accent-soft: #ead9b6;
    }
    :host([data-font="cairo"]) { --roots-font: "Cairo", "Segoe UI", Tahoma, sans-serif; }
    :host([data-font="amiri"]) { --roots-font: "Amiri", "Traditional Arabic", serif; }
    :host([data-font="system"]) { --roots-font: "Geeza Pro", "Noto Naskh Arabic", Tahoma, sans-serif; }

    .roots-popover {
      position: fixed;
      z-index: 2147483647;
      max-width: 360px;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.22);
      padding: 14px 16px;
      font-family: var(--roots-font);
      direction: rtl;
      font-size: calc(15px * var(--roots-font-scale));
      line-height: 1.9;
      animation: roots-fade-in 120ms ease-out;
    }
    @keyframes roots-fade-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

    .roots-popover-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 8px;
    }
    .roots-root-letters {
      font-size: 1.5em;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: 2px;
    }
    .roots-core-meaning {
      font-size: 0.7em;
      opacity: 0.7;
      direction: ltr;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .roots-definition { margin: 0 0 10px; font-size: 0.95em; }
    .roots-forms-table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
    .roots-forms-table th {
      text-align: right;
      font-size: 0.75em;
      opacity: 0.6;
      font-weight: 600;
      padding: 3px 6px;
      direction: ltr;
      text-align: left;
    }
    .roots-forms-table td { padding: 4px 6px; border-top: 1px solid var(--border); vertical-align: top; }
    .roots-form-num { color: var(--accent); font-weight: 700; direction: ltr; text-align: left; width: 2.2em; }
    .roots-form-verb { font-size: 1.05em; white-space: nowrap; }
    .roots-form-translit { direction: ltr; text-align: left; opacity: 0.75; font-style: italic; white-space: nowrap; }
    .roots-form-meaning { direction: ltr; text-align: left; }

    .roots-float-btn {
      position: fixed;
      z-index: 2147483647;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 999px;
      padding: 6px 14px;
      font-family: var(--roots-font);
      font-size: 13px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      animation: roots-fade-in 120ms ease-out;
    }
    .roots-float-btn:hover { filter: brightness(1.08); }
  `;

  // ---------------------------------------------------------------------
  // Settings application / lifecycle
  // ---------------------------------------------------------------------

  function applySettings(newSettings) {
    state.settings = newSettings;
    applyTheme();
    unwrapPage();
    scanPage();
  }

  async function init(settings) {
    state.settings = settings;
    const { lexicon, frequency } = await loadData();
    state.lexicon = lexicon;
    state.frequency = frequency;

    buildShadowUI();
    applyTheme();
    scanPage();

    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("selectionchange", onSelectionChange);
    state.active = true;
  }

  function teardown() {
    unwrapPage();
    destroyShadowUI();
    document.documentElement.removeAttribute("data-roots-theme");
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    // Reactivating (without a page reload) re-runs this whole file via a
    // fresh executeScript call, which registers a brand-new onMessage
    // listener below. If this instance's own listener stayed registered,
    // both would react to the next ROOTS_INIT broadcast — double shadow
    // hosts, a double DOM scan, double-counted stats. Removing it here
    // ensures exactly one listener is ever live at a time.
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    state.active = false;
    window.__rootsInjected = false;
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    switch (message?.type) {
      case "ROOTS_INIT":
        init(message.settings)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => {
            console.error("[Roots] content script failed to initialize:", err);
            sendResponse({ ok: false, error: err?.message ?? String(err) });
          });
        return true;
      case "ROOTS_TEARDOWN":
        teardown();
        sendResponse({ ok: true });
        return;
      case "ROOTS_SETTINGS_UPDATED":
        if (state.active) applySettings(message.settings);
        sendResponse({ ok: true });
        return;
      default:
        return;
    }
  }

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
})();
