const STORAGE_KEY = "shortcuts";

const listView = document.getElementById("listView");
const editView = document.getElementById("editView");
const shortcutsList = document.getElementById("shortcutsList");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("searchInput");
const newBtn = document.getElementById("newBtn");
const emptyCreateBtn = document.getElementById("emptyCreateBtn");

const importBtn = document.getElementById("importBtn");
const exportBtn = document.getElementById("exportBtn");
const importFile = document.getElementById("importFile");

const editForm = document.getElementById("editForm");
const editTitle = document.getElementById("editTitle");
const triggerInput = document.getElementById("triggerInput");
const contentEditor = document.getElementById("contentEditor");
const saveBtn = document.getElementById("saveBtn");
const cancelBtn = document.getElementById("cancelBtn");
const backBtn = document.getElementById("backBtn");
const deleteBtn = document.getElementById("deleteBtn");
const toolbar = document.querySelector(".editor-toolbar");

let state = {
  shortcuts: [],
  editingId: null,
  filter: "",
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function loadShortcuts() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  state.shortcuts = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  renderList();
}

async function saveShortcuts() {
  await chrome.storage.local.set({ [STORAGE_KEY]: state.shortcuts });
}

function plainPreview(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || "").trim();
}

function renderList() {
  shortcutsList.innerHTML = "";
  const q = state.filter.trim().toLowerCase();
  const items = state.shortcuts
    .slice()
    .sort((a, b) => a.trigger.localeCompare(b.trigger))
    .filter(
      (s) =>
        !q ||
        s.trigger.toLowerCase().includes(q) ||
        plainPreview(s.html).toLowerCase().includes(q)
    );

  if (state.shortcuts.length === 0) {
    emptyState.classList.remove("hidden");
    shortcutsList.classList.add("hidden");
    return;
  }
  emptyState.classList.add("hidden");
  shortcutsList.classList.remove("hidden");

  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "shortcut-item";
    li.style.cursor = "default";
    li.innerHTML = `<div class="shortcut-preview" style="text-align:center;width:100%">Aucun résultat</div>`;
    shortcutsList.appendChild(li);
    return;
  }

  for (const s of items) {
    const li = document.createElement("li");
    li.className = "shortcut-item";
    li.dataset.id = s.id;

    const pill = document.createElement("span");
    pill.className = "trigger-pill";
    pill.textContent = s.trigger;

    const preview = document.createElement("div");
    preview.className = "shortcut-preview";
    preview.textContent = plainPreview(s.html) || "(vide)";

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.title = "Modifier";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEdit(s.id);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.title = "Supprimer";
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`Supprimer le raccourci "${s.trigger}" ?`)) {
        state.shortcuts = state.shortcuts.filter((x) => x.id !== s.id);
        await saveShortcuts();
        renderList();
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(pill);
    li.appendChild(preview);
    li.appendChild(actions);

    li.addEventListener("click", () => openEdit(s.id));

    shortcutsList.appendChild(li);
  }
}

function openEdit(id) {
  state.editingId = id;
  const s = state.shortcuts.find((x) => x.id === id);
  if (s) {
    editTitle.textContent = "Modifier le raccourci";
    triggerInput.value = s.trigger;
    contentEditor.innerHTML = s.html;
    deleteBtn.classList.remove("hidden");
  } else {
    editTitle.textContent = "Nouveau raccourci";
    triggerInput.value = "";
    contentEditor.innerHTML = "";
    deleteBtn.classList.add("hidden");
  }
  listView.classList.add("hidden");
  editView.classList.remove("hidden");
  setTimeout(() => triggerInput.focus(), 30);
}

function closeEdit() {
  state.editingId = null;
  editView.classList.add("hidden");
  listView.classList.remove("hidden");
}

function sanitizeTrigger(value) {
  return value.trim().replace(/\s+/g, "");
}

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const trigger = sanitizeTrigger(triggerInput.value);
  const html = contentEditor.innerHTML.trim();

  if (!trigger) {
    triggerInput.focus();
    return;
  }
  if (!html) {
    contentEditor.focus();
    return;
  }

  const conflict = state.shortcuts.find(
    (x) => x.trigger.toLowerCase() === trigger.toLowerCase() && x.id !== state.editingId
  );
  if (conflict) {
    alert(`Le mot-clé "${trigger}" existe déjà.`);
    triggerInput.focus();
    return;
  }

  if (state.editingId) {
    const idx = state.shortcuts.findIndex((x) => x.id === state.editingId);
    if (idx >= 0) state.shortcuts[idx] = { ...state.shortcuts[idx], trigger, html };
  } else {
    state.shortcuts.push({ id: uid(), trigger, html, createdAt: Date.now() });
  }

  await saveShortcuts();
  closeEdit();
  renderList();
});

deleteBtn.addEventListener("click", async () => {
  if (!state.editingId) return;
  const s = state.shortcuts.find((x) => x.id === state.editingId);
  if (!s) return;
  if (confirm(`Supprimer le raccourci "${s.trigger}" ?`)) {
    state.shortcuts = state.shortcuts.filter((x) => x.id !== state.editingId);
    await saveShortcuts();
    closeEdit();
    renderList();
  }
});

cancelBtn.addEventListener("click", (e) => {
  e.preventDefault();
  closeEdit();
});
backBtn.addEventListener("click", closeEdit);
newBtn.addEventListener("click", () => openEdit(null));
emptyCreateBtn.addEventListener("click", () => openEdit(null));

searchInput.addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderList();
});

toolbar.addEventListener("mousedown", (e) => {
  const target = e.target.closest("[data-cmd]");
  if (!target) return;
  e.preventDefault();
  const cmd = target.dataset.cmd;
  if (target.tagName === "INPUT") return;
  document.execCommand(cmd, false, null);
  contentEditor.focus();
  updateToolbarState();
});

toolbar.addEventListener("input", (e) => {
  const input = e.target.closest('input[type="color"]');
  if (!input) return;
  const cmd = input.dataset.cmd;
  contentEditor.focus();
  document.execCommand(cmd, false, input.value);
});

contentEditor.addEventListener("keyup", updateToolbarState);
contentEditor.addEventListener("mouseup", updateToolbarState);

function updateToolbarState() {
  document.querySelectorAll(".tb[data-cmd]").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    if (btn.tagName === "BUTTON") {
      try {
        if (document.queryCommandState(cmd)) btn.classList.add("active");
        else btn.classList.remove("active");
      } catch (_) {}
    }
  });
}

contentEditor.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  document.execCommand("insertText", false, text);
});

function pad(n) { return String(n).padStart(2, "0"); }

function defaultExportFilename() {
  const d = new Date();
  return `raccourcis-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
}

exportBtn.addEventListener("click", () => {
  if (state.shortcuts.length === 0) {
    alert("Aucun raccourci à exporter.");
    return;
  }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    shortcuts: state.shortcuts.map(({ id, trigger, html, createdAt }) => ({
      id, trigger, html, createdAt,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: defaultExportFilename(), saveAs: true },
    (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        const a = document.createElement("a");
        a.href = url;
        a.download = defaultExportFilename();
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  );
});

importBtn.addEventListener("click", () => {
  importFile.value = "";
  importFile.click();
});

importFile.addEventListener("change", async () => {
  const file = importFile.files && importFile.files[0];
  if (!file) return;
  let data;
  try {
    const text = await file.text();
    data = JSON.parse(text);
  } catch (err) {
    alert("Fichier illisible : " + err.message);
    return;
  }
  const incoming = Array.isArray(data) ? data : data && data.shortcuts;
  if (!Array.isArray(incoming)) {
    alert("Format invalide : aucun tableau de raccourcis trouvé.");
    return;
  }
  const valid = incoming.filter(
    (s) => s && typeof s.trigger === "string" && typeof s.html === "string" && s.trigger.trim()
  );
  if (!valid.length) {
    alert("Aucun raccourci valide trouvé dans ce fichier.");
    return;
  }

  let mode = "merge";
  if (state.shortcuts.length > 0) {
    const replace = confirm(
      `Importer ${valid.length} raccourci(s) depuis "${file.name}" ?\n\n` +
        "OK   → Remplacer tous les raccourcis existants\n" +
        "Annuler → Fusionner (les doublons seront écrasés)"
    );
    mode = replace ? "replace" : "merge";
  }

  if (mode === "replace") {
    state.shortcuts = valid.map((s) => ({
      id: s.id || uid(),
      trigger: sanitizeTrigger(s.trigger),
      html: s.html,
      createdAt: s.createdAt || Date.now(),
    }));
  } else {
    const byTrigger = new Map(
      state.shortcuts.map((s) => [s.trigger.toLowerCase(), s])
    );
    for (const s of valid) {
      const trigger = sanitizeTrigger(s.trigger);
      if (!trigger) continue;
      const key = trigger.toLowerCase();
      const existing = byTrigger.get(key);
      const merged = {
        id: existing ? existing.id : s.id || uid(),
        trigger,
        html: s.html,
        createdAt: existing ? existing.createdAt : s.createdAt || Date.now(),
      };
      byTrigger.set(key, merged);
    }
    state.shortcuts = Array.from(byTrigger.values());
  }

  await saveShortcuts();
  renderList();
  alert(`${valid.length} raccourci(s) importé(s).`);
});

loadShortcuts();
