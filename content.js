(function () {
  if (window.__raccourcisInstalled) return;
  window.__raccourcisInstalled = true;

  const STORAGE_KEY = "shortcuts";
  const LOG = "[Raccourcis]";
  let shortcuts = [];
  let storageReady = false;

  function log(...args) {
    if (window.__raccourcisDebug) console.log(LOG, ...args);
  }
  window.__raccourcisDebug = true;

  if (chrome?.storage?.local) {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      shortcuts = (data && data[STORAGE_KEY]) || [];
      storageReady = true;
      log("chargés:", shortcuts.length, shortcuts.map((s) => s.trigger));
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_KEY]) {
        shortcuts = changes[STORAGE_KEY].newValue || [];
        log("mis à jour:", shortcuts.length, shortcuts.map((s) => s.trigger));
      }
    });
  } else {
    console.warn(LOG, "chrome.storage indisponible — content script peut être hors contexte");
  }

  const DELIMITER_RE = /[\s.,!?;:]/;
  const AUTO_DISMISS_MS = 6000;

  let popupHost = null;
  let popupShadow = null;
  let popupRoot = null;
  let popupTimer = null;
  let popupHideTimer = null;
  let pending = null;
  let dismissed = null;

  function isEditable(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["text", "search", "url", "email", "tel", ""].includes(t);
    }
    return !!el.isContentEditable;
  }

  function findEditableHost(el) {
    if (!el) return null;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el;
    let cur = el.nodeType === 1 ? el : el.parentElement;
    while (cur && cur.nodeType === 1) {
      const ce = cur.getAttribute && cur.getAttribute("contenteditable");
      if (ce === "" || ce === "true" || ce === "plaintext-only") return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function resolveTarget(el) {
    if (!el) {
      const active = document.activeElement;
      el = active;
    }
    if (!el) return null;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el;
    if (el.isContentEditable) return findEditableHost(el) || el;
    return null;
  }

  const BLOCK_TAGS = new Set([
    "P","DIV","H1","H2","H3","H4","H5","H6",
    "LI","BLOCKQUOTE","PRE","TR","TD","TH",
    "SECTION","ARTICLE","HEADER","FOOTER","MAIN",
  ]);

  function textBeforeRange(root, r) {
    let result = "";
    let done = false;
    function visit(node, isRoot) {
      if (done) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (node === r.endContainer) {
          result += node.textContent.substring(0, r.endOffset);
          done = true;
        } else {
          result += node.textContent;
        }
        return;
      }
      if (node.nodeName === "BR") {
        if (node === r.endContainer) { done = true; return; }
        result += "\n";
        return;
      }
      const isBlock = !isRoot && BLOCK_TAGS.has(node.nodeName);
      if (isBlock && result && !result.endsWith("\n")) result += "\n";
      if (node === r.endContainer) {
        const kids = Array.from(node.childNodes).slice(0, r.endOffset);
        for (const k of kids) { visit(k, false); if (done) break; }
        done = true;
        return;
      }
      for (const k of node.childNodes) { visit(k, false); if (done) break; }
    }
    visit(root, true);
    return result;
  }

  function getTextBeforeCaret(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const pos = el.selectionStart ?? el.value.length;
      return el.value.substring(0, pos);
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return "";
    const r = sel.getRangeAt(0);
    let root = el;
    if (!root.contains(r.endContainer)) {
      const host = findEditableHost(r.endContainer);
      if (!host) return "";
      root = host;
    }
    try {
      return textBeforeRange(root, r);
    } catch (_) {
      return "";
    }
  }

  function findMatch(textBefore) {
    if (!textBefore || !shortcuts.length) return null;
    const lastChar = textBefore[textBefore.length - 1];

    if (DELIMITER_RE.test(lastChar)) {
      const m = textBefore.slice(0, -1).match(/(\S+)$/);
      if (!m) return null;
      const word = m[1].toLowerCase();
      const found = shortcuts.find((s) => s.trigger.toLowerCase() === word);
      if (found) return { shortcut: found, mode: "delim" };
      return null;
    }

    const lower = textBefore.toLowerCase();
    for (const s of shortcuts) {
      const t = s.trigger.toLowerCase();
      if (!t) continue;
      if (lower.endsWith(t)) {
        const idx = textBefore.length - t.length;
        const prev = idx > 0 ? textBefore[idx - 1] : "";
        if (idx === 0 || /\W/.test(prev)) {
          return { shortcut: s, mode: "exact" };
        }
      }
    }
    return null;
  }

  function htmlToPlain(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    tmp
      .querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, blockquote")
      .forEach((b) => b.append("\n"));
    return (tmp.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function ensurePopup() {
    if (popupHost && document.documentElement.contains(popupHost)) return;
    popupHost = document.createElement("div");
    popupHost.id = "raccourcis-host";
    popupHost.style.cssText =
      "all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647; pointer-events: none;";
    document.documentElement.appendChild(popupHost);
    popupShadow = popupHost.attachShadow({ mode: "open" });
    popupShadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        .rcx-popup {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, "Helvetica Neue", Arial, sans-serif;
          color: #111827;
          background: #ffffff;
          width: 320px;
          border-radius: 14px;
          box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.06);
          border: 1px solid rgba(15, 23, 42, 0.06);
          overflow: hidden;
          pointer-events: none;
          transform: translateY(-12px) scale(0.98);
          opacity: 0;
          transition: opacity 160ms ease, transform 200ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
        }
        .rcx-popup.show { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
        .rcx-head {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px 8px;
        }
        .rcx-pill {
          background: #eef2ff;
          color: #4f46e5;
          font-weight: 600;
          font-size: 12px;
          padding: 4px 9px;
          border-radius: 6px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          max-width: 160px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .rcx-title { font-size: 12.5px; color: #6b7280; flex: 1; }
        .rcx-close {
          width: 22px; height: 22px;
          display: inline-flex; align-items: center; justify-content: center;
          border-radius: 6px;
          color: #9ca3af;
          cursor: pointer;
          border: none; background: transparent;
          font-size: 16px; line-height: 1;
          padding: 0;
        }
        .rcx-close:hover { background: #f3f4f6; color: #111827; }
        .rcx-preview {
          margin: 0 14px;
          padding: 10px 12px;
          font-size: 13px;
          line-height: 1.45;
          color: #111827;
          background: #f7f8fa;
          border-radius: 8px;
          max-height: 130px;
          overflow: auto;
          word-break: break-word;
        }
        .rcx-preview > *:first-child { margin-top: 0; }
        .rcx-preview > *:last-child { margin-bottom: 0; }
        .rcx-actions {
          display: flex;
          gap: 8px;
          padding: 12px 14px 14px;
        }
        .rcx-btn {
          flex: 1;
          font: inherit;
          padding: 8px 12px;
          border-radius: 8px;
          border: 1px solid transparent;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 80ms ease;
        }
        .rcx-btn:active { transform: translateY(1px); }
        .rcx-btn-primary {
          background: #4f46e5; color: #fff; border-color: #4f46e5;
        }
        .rcx-btn-primary:hover { background: #4338ca; border-color: #4338ca; }
        .rcx-btn-ghost {
          background: #fff; color: #6b7280; border-color: #e5e7eb;
        }
        .rcx-btn-ghost:hover { background: #f7f8fa; color: #111827; }
        .rcx-hint {
          font-size: 11px;
          color: #9ca3af;
          padding: 0 14px 12px;
          text-align: right;
        }
        kbd {
          background: #f3f4f6;
          border: 1px solid #e5e7eb;
          border-bottom-width: 2px;
          border-radius: 4px;
          padding: 1px 5px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 10.5px;
          color: #374151;
        }
      </style>
      <div class="rcx-popup" role="dialog" aria-live="polite">
        <div class="rcx-head">
          <span class="rcx-pill" data-pill></span>
          <span class="rcx-title">Remplacer par&nbsp;:</span>
          <button class="rcx-close" data-close title="Ignorer (Échap)">×</button>
        </div>
        <div class="rcx-preview" data-preview></div>
        <div class="rcx-actions">
          <button class="rcx-btn rcx-btn-ghost" data-cancel>Ignorer</button>
          <button class="rcx-btn rcx-btn-primary" data-confirm>Remplacer</button>
        </div>
        <div class="rcx-hint"><kbd>Tab</kbd> pour remplacer · <kbd>Échap</kbd> pour ignorer</div>
      </div>
    `;
    popupRoot = popupShadow.querySelector(".rcx-popup");
    popupShadow.querySelectorAll("button, .rcx-popup").forEach((el) => {
      el.addEventListener("mousedown", (e) => e.preventDefault());
      el.addEventListener("pointerdown", (e) => e.preventDefault());
    });
    popupShadow.querySelector("[data-confirm]").addEventListener("click", (e) => {
      log("clic sur Remplacer reçu");
      e.preventDefault();
      e.stopPropagation();
      confirmReplacement();
    });
    popupShadow.querySelector("[data-cancel]").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePopup(true);
    });
    popupShadow.querySelector("[data-close]").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePopup(true);
    });
  }

  function captureCaret(target) {
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      return {
        type: "input",
        start: target.selectionStart,
        end: target.selectionEnd,
      };
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && target.contains(sel.anchorNode)) {
      return { type: "ce", range: sel.getRangeAt(0).cloneRange() };
    }
    return null;
  }

  function restoreCaret(target, info) {
    if (!info) return;
    try {
      if (info.type === "input") {
        target.focus();
        target.setSelectionRange(info.start, info.end);
      } else if (info.type === "ce") {
        target.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(info.range);
      }
    } catch (err) {
      console.warn(LOG, "restoreCaret a échoué", err);
    }
  }

  function showPopup(target, shortcut, mode) {
    ensurePopup();
    if (popupHideTimer) {
      clearTimeout(popupHideTimer);
      popupHideTimer = null;
    }
    popupHost.style.display = "";
    const caretInfo = captureCaret(target);
    pending = { target, shortcut, mode, caretInfo };
    popupShadow.querySelector("[data-pill]").textContent = shortcut.trigger;
    popupShadow.querySelector("[data-preview]").innerHTML = shortcut.html;
    requestAnimationFrame(() => popupRoot.classList.add("show"));
    if (popupTimer) clearTimeout(popupTimer);
    popupTimer = setTimeout(hidePopup, AUTO_DISMISS_MS);
    log("popup affichée pour", shortcut.trigger, "mode:", mode);
  }

  function hidePopup(markDismissed) {
    if (popupTimer) {
      clearTimeout(popupTimer);
      popupTimer = null;
    }
    if (popupRoot) popupRoot.classList.remove("show");
    if (popupHideTimer) clearTimeout(popupHideTimer);
    popupHideTimer = setTimeout(() => {
      if (popupHost && popupRoot && !popupRoot.classList.contains("show")) {
        popupHost.style.display = "none";
      }
      popupHideTimer = null;
    }, 240);
    if (markDismissed && pending) {
      try {
        const text = getTextBeforeCaret(pending.target);
        dismissed = { target: pending.target, text };
      } catch (_) {
        dismissed = null;
      }
    }
    pending = null;
  }

  function replaceInInput(el, trigger, plain, mode) {
    const value = el.value;
    const cursor = el.selectionStart ?? value.length;
    const triggerEnd = mode === "delim" ? cursor - 1 : cursor;
    const triggerStart = triggerEnd - trigger.length;
    if (triggerStart < 0) return false;
    const candidate = value.substring(triggerStart, triggerEnd);
    if (candidate.toLowerCase() !== trigger.toLowerCase()) {
      log("candidat ne correspond pas:", candidate, "vs", trigger);
      return false;
    }
    el.focus();
    el.setSelectionRange(triggerStart, triggerEnd);
    // execCommand("insertText") déclenche un vrai InputEvent reconnu par React/Vue/Angular
    if (document.execCommand("insertText", false, plain)) return true;
    // Fallback : contourne le setter React en passant par le prototype natif
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const newVal = value.substring(0, triggerStart) + plain + value.substring(triggerEnd);
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, newVal);
    el.setSelectionRange(triggerStart + plain.length, triggerStart + plain.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function buildRangeBackward(rootEl, fromRange, charsBack, length) {
    const items = [];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) items.push(n);
    if (!items.length) return null;

    let curIdx = -1;
    let curOff = 0;
    const ec = fromRange.endContainer;
    const eo = fromRange.endOffset;
    if (ec.nodeType === Node.TEXT_NODE) {
      curIdx = items.indexOf(ec);
      curOff = eo;
    } else if (eo > 0) {
      const prev = ec.childNodes[eo - 1];
      let cur = prev;
      while (cur && cur.nodeType !== Node.TEXT_NODE) {
        cur = cur.lastChild;
      }
      if (cur) {
        curIdx = items.indexOf(cur);
        curOff = cur.length;
      }
    }
    if (curIdx === -1) return null;

    function walkBack(idx, off, count) {
      while (count > 0) {
        if (off >= count) return { idx, off: off - count };
        count -= off;
        idx--;
        if (idx < 0) return null;
        off = items[idx].length;
      }
      return { idx, off };
    }

    const endPos = walkBack(curIdx, curOff, charsBack);
    if (!endPos) return null;
    const startPos = walkBack(endPos.idx, endPos.off, length);
    if (!startPos) return null;

    const r = document.createRange();
    r.setStart(items[startPos.idx], startPos.off);
    r.setEnd(items[endPos.idx], endPos.off);
    return r;
  }

  function replaceInEditable(target, trigger, html, mode) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      log("replaceInEditable: pas de sélection");
      return false;
    }
    const caretRange = sel.getRangeAt(0).cloneRange();
    const actualRoot = target.contains(caretRange.endContainer)
      ? target
      : findEditableHost(caretRange.endContainer) || target;
    if (!actualRoot.contains(caretRange.endContainer)) {
      log("replaceInEditable: range hors cible", caretRange.endContainer);
      return false;
    }

    const charsBack = mode === "delim" ? 1 : 0;
    const triggerRange = buildRangeBackward(actualRoot, caretRange, charsBack, trigger.length);
    if (!triggerRange) {
      log("buildRangeBackward a échoué");
      return false;
    }
    const found = triggerRange.toString();
    if (found.toLowerCase() !== trigger.toLowerCase()) {
      log("contenu différent:", JSON.stringify(found), "vs", trigger);
      return false;
    }

    target.focus();
    sel.removeAllRanges();
    sel.addRange(triggerRange);

    const plain = htmlToPlain(html);
    const before = (actualRoot.textContent || "");
    const expectedLen = before.length - trigger.length + plain.length;
    const curLen = () => (actualRoot.textContent || "").length;

    // Force les éditeurs qui lisent leur sélection model en cache (CKEditor 5,
    // ProseMirror, Lexical) à se resynchroniser sur la sélection DOM courante
    // AVANT que la prochaine commande ne lise une sélection périmée.
    function setSelection(range) {
      try {
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {}
      try { document.dispatchEvent(new Event("selectionchange")); } catch (_) {}
    }

    // Supprime le trigger restant dans le DOM (re-localisé) et notifie l'éditeur.
    // Utilisé quand un éditeur (CKEditor 5, Zendesk, ...) a inséré le texte au
    // curseur sans honorer notre sélection — le trigger est donc encore présent.
    function cleanupOrphanTrigger() {
      const loc = relocateTrigger(actualRoot, trigger);
      if (!loc) {
        log("cleanup: trigger introuvable");
        return false;
      }
      setSelection(loc);
      // 1. Tente execCommand("delete") qui déclenche un beforeinput natif :
      //    CKEditor 5 / ProseMirror / Lexical le traitent via leur modèle au
      //    lieu d'annuler notre mutation DOM au prochain cycle de rendu.
      try {
        if (document.execCommand("delete", false) && curLen() === expectedLen) {
          log("cleanup via execCommand delete");
          return true;
        }
      } catch (err) {
        log("cleanup execCommand delete a échoué", err);
      }
      // 2. Fallback : suppression DOM directe + InputEvent
      try {
        const loc2 = relocateTrigger(actualRoot, trigger) || loc;
        loc2.deleteContents();
        target.dispatchEvent(new InputEvent("input", {
          inputType: "deleteContentBackward",
          bubbles: true,
        }));
        log("cleanup via DOM direct, len=", curLen(), "attendu=", expectedLen);
      } catch (err) {
        log("cleanup DOM a échoué", err);
        return false;
      }
      return true;
    }

    // Tente une méthode d'insertion. Si l'éditeur a tout bien fait → "ok".
    // S'il a juste appendé le texte sans supprimer le trigger → "appended"
    // (on arrête tout de suite pour éviter d'insérer plusieurs fois).
    function tryInsert(label, fn) {
      try {
        setSelection(triggerRange);
        fn();
      } catch (err) {
        log(label + " a échoué", err);
        return "error";
      }
      const cur = curLen();
      if (cur === expectedLen) {
        log("inséré via " + label);
        return "ok";
      }
      if (cur > before.length) {
        log(label + ": texte inséré sans suppression du trigger (len=" + cur + ", attendu=" + expectedLen + "), cleanup requis");
        return "appended";
      }
      return "noop";
    }

    const methods = [
      ["paste event", () => {
        const dt = new DataTransfer();
        dt.setData("text/html", html);
        dt.setData("text/plain", plain);
        target.dispatchEvent(new ClipboardEvent("paste", {
          bubbles: true, cancelable: true, clipboardData: dt,
        }));
      }],
      ["insertText", () => { document.execCommand("insertText", false, plain); }],
      ["insertHTML", () => { document.execCommand("insertHTML", false, html); }],
      ["beforeinput", () => {
        const dt = new DataTransfer();
        dt.setData("text/html", html);
        dt.setData("text/plain", plain);
        target.dispatchEvent(new InputEvent("beforeinput", {
          inputType: "insertReplacementText",
          data: plain,
          dataTransfer: dt,
          bubbles: true, cancelable: true, composed: true,
        }));
      }],
    ];

    for (const [label, fn] of methods) {
      const r = tryInsert(label, fn);
      if (r === "ok") {
        target.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      if (r === "appended") {
        if (cleanupOrphanTrigger() && curLen() === expectedLen) return true;
        // Cleanup raté : on retourne quand même true pour ne pas re-insérer
        // (l'utilisateur peut effacer le trigger résiduel manuellement).
        return true;
      }
    }

    // Aucune méthode n'a inséré → fallback DOM direct (delete + insert).
    try {
      let workRange = triggerRange;
      if (workRange.collapsed || workRange.toString().toLowerCase() !== trigger.toLowerCase()) {
        workRange = relocateTrigger(actualRoot, trigger) || workRange;
      }
      try { workRange.deleteContents(); } catch (_) {}

      const insertPoint = workRange.cloneRange();
      insertPoint.collapse(true);
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const frag = document.createDocumentFragment();
      let lastNode = null;
      while (tmp.firstChild) {
        lastNode = tmp.firstChild;
        frag.appendChild(lastNode);
      }
      insertPoint.insertNode(frag);
      if (lastNode) {
        const after = document.createRange();
        after.setStartAfter(lastNode);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
      }
      target.dispatchEvent(new InputEvent("input", {
        inputType: "insertText",
        data: plain,
        bubbles: true,
      }));
      log("inséré via DOM direct");
      return true;
    } catch (err) {
      console.warn(LOG, "fallback DOM insert a échoué", err);
      return false;
    }
  }

  function relocateTrigger(root, trigger) {
    const lowerTrigger = trigger.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    let lastMatch = null;
    while ((node = walker.nextNode())) {
      const lower = node.nodeValue.toLowerCase();
      let from = 0;
      let idx;
      while ((idx = lower.indexOf(lowerTrigger, from)) !== -1) {
        lastMatch = { node, idx };
        from = idx + lowerTrigger.length;
      }
    }
    if (!lastMatch) return null;
    const range = document.createRange();
    range.setStart(lastMatch.node, lastMatch.idx);
    range.setEnd(lastMatch.node, lastMatch.idx + trigger.length);
    return range;
  }

  function confirmReplacement() {
    log("confirmReplacement: pending =", !!pending);
    if (!pending) return hidePopup();
    const { target, shortcut, mode, caretInfo } = pending;
    log("cible:", target.tagName, "isCE:", target.isContentEditable, "mode:", mode);
    if (!target || !target.isConnected) {
      log("cible déconnectée");
      return hidePopup();
    }
    restoreCaret(target, caretInfo);
    let ok = false;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      ok = replaceInInput(target, shortcut.trigger, htmlToPlain(shortcut.html), mode);
    } else if (target.isContentEditable) {
      ok = replaceInEditable(target, shortcut.trigger, shortcut.html, mode);
    } else {
      log("cible non gérée:", target);
    }
    log("remplacement", ok ? "OK" : "ÉCHEC", "pour", shortcut.trigger);
    if (ok) recordSavings(shortcut);
    hidePopup();
  }

  const STATS_KEY = "stats";
  const STATS_RETENTION_DAYS = 95;

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function recordSavings(shortcut) {
    if (!chrome?.storage?.local) return;
    const plainLen = htmlToPlain(shortcut.html || "").length;
    const saved = plainLen - (shortcut.trigger || "").length;
    if (saved <= 0) return;
    const key = todayKey();
    chrome.storage.local.get(STATS_KEY, (data) => {
      const stats = (data && data[STATS_KEY]) || {};
      stats[key] = (stats[key] || 0) + saved;
      // Purge des entrées trop anciennes pour éviter de gonfler le storage.
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - STATS_RETENTION_DAYS);
      const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
      for (const k of Object.keys(stats)) {
        if (k < cutoffKey) delete stats[k];
      }
      chrome.storage.local.set({ [STATS_KEY]: stats });
    });
  }

  function handleEditableEvent(rawTarget) {
    const target = resolveTarget(rawTarget);
    if (!target || !isEditable(target)) {
      if (pending) hidePopup();
      return;
    }
    if (!storageReady || !shortcuts.length) return;
    const text = getTextBeforeCaret(target);

    if (dismissed && dismissed.target === target) {
      if (dismissed.text === text) return;
      dismissed = null;
    }

    const match = findMatch(text);
    if (match) {
      log("match:", match.shortcut.trigger, "mode:", match.mode);
      showPopup(target, match.shortcut, match.mode);
    } else if (pending && pending.target === target) {
      hidePopup();
    }
  }

  let detectionTimer = null;

  function scheduleDetection() {
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => {
      detectionTimer = null;
      const target = resolveTarget(document.activeElement);
      if (target && isEditable(target)) handleEditableEvent(target);
    }, 60);
  }

  function immediateMatchAndFill(rawTarget) {
    const target = resolveTarget(rawTarget) || resolveTarget(document.activeElement);
    if (!target || !isEditable(target) || !storageReady || !shortcuts.length) return false;
    const text = getTextBeforeCaret(target);
    const match = findMatch(text);
    if (!match) return false;
    const caretInfo = captureCaret(target);
    pending = { target, shortcut: match.shortcut, mode: match.mode, caretInfo };
    confirmReplacement();
    return true;
  }

  document.addEventListener("selectionchange", scheduleDetection, true);
  document.addEventListener("input", scheduleDetection, true);

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        if (!pending) return;
        e.preventDefault();
        e.stopPropagation();
        hidePopup(true);
      } else if (e.key === "Tab") {
        if (pending) {
          e.preventDefault();
          e.stopPropagation();
          confirmReplacement();
        } else {
          const target = resolveTarget(e.target) || resolveTarget(document.activeElement);
          if (target && isEditable(target)) {
            const text = getTextBeforeCaret(target);
            const match = findMatch(text);
            if (match) {
              e.preventDefault();
              e.stopPropagation();
              immediateMatchAndFill(e.target);
            }
          }
        }
      }
    },
    true
  );

  document.addEventListener(
    "mousedown",
    (e) => {
      if (!pending) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (popupHost && (popupHost.contains(e.target) || path.includes(popupHost))) return;
      hidePopup(true);
    },
    true
  );

  window.addEventListener("blur", () => hidePopup());

  log("content script chargé sur", location.href);
})();
