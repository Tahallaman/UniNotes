/* UniNotes control panel — client.
   Vanilla ES modules, no build step, no dependencies. */

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  status: null,
  jobs: [],
  settings: { fields: [], values: {}, overridden: [] },
  draft: {},          // setting path → pending value
  tasks: [],
  schedulable: [],
  entries: [],
  summary: null,
  selection: new Set(),
  filters: { search: "", course: "", status: "", missingPretty: false },
  job: null,          // the current or most recent job
  running: false,
  drawerKey: null,
  noteTab: "pretty",
};

// ── API ──────────────────────────────────────────────────────────────────────

async function get(path) {
  const res = await fetch(path, { headers: { "x-uninotes": "1" } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function post(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    // The custom header is the CSRF guard: a cross-origin page cannot set it
    // without a preflight, and the server answers none.
    headers: { "content-type": "application/json", "x-uninotes": "1" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json();
  if (!res.ok) throw new Error(parsed.error || `Request failed (${res.status})`);
  return parsed;
}

// ── Feedback ─────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(message, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === "bad" ? 8000 : 4000);
}

/** Wrap an action so a rejected promise always surfaces instead of vanishing. */
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message, "bad");
    }
  };
}

// ── Navigation ───────────────────────────────────────────────────────────────

document.querySelectorAll(".nav-item").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((t) => t.classList.toggle("current", t === tab));
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("current", p.id === `panel-${tab.dataset.tab}`);
    });
    if (tab.dataset.tab === "library") refreshLibrary();
    if (tab.dataset.tab === "schedule") refreshSchedule();
  });
});

function activeTab() {
  return document.querySelector(".panel.current")?.id ?? "";
}

// ── Run: state line, alerts, primary action ──────────────────────────────────

function renderState() {
  const dot = document.getElementById("state-dot");
  const text = document.getElementById("state-text");
  const meta = document.getElementById("state-meta");
  const job = state.job;

  if (state.running) {
    dot.className = "dot dot-busy";
    text.textContent = job.interactive ? `${job.label} — waiting for you` : `${job.label}…`;
  } else if (job && job.phase === "failed") {
    dot.className = "dot dot-broken";
    text.textContent = `${job.label} failed`;
  } else if (job && job.phase === "cancelled") {
    dot.className = "dot";
    text.textContent = `${job.label} stopped`;
  } else if (job) {
    dot.className = "dot dot-ready";
    text.textContent = `${job.label} finished`;
  } else {
    dot.className = "dot dot-ready";
    text.textContent = "Ready";
  }

  const s = state.status;
  meta.textContent = s ? `notes ${s.providers.notes} · pretty ${s.providers.pretty}` : "";

  document.getElementById("btn-cancel").disabled = !state.running;
  document.getElementById("btn-clear").disabled = state.running;
  document.getElementById("go").disabled = state.running;
}

/**
 * Only failing checks are drawn.
 *
 * Five green ticks confirming that nothing is wrong is five things to read
 * before you find the one that matters. Silence means healthy.
 */
function renderAlerts() {
  const host = document.getElementById("alerts");
  const failing = (state.status?.checks ?? []).filter((c) => !c.ok);

  host.replaceChildren(...failing.map((check) => {
    const alert = el("div", { class: `alert${check.advisory ? " warn" : ""}` });
    alert.append(
      el("span", { class: "alert-label", text: check.label }),
      el("span", { class: "alert-detail", text: check.detail }),
    );
    if (check.fixJob) {
      const fix = el("button", { class: "btn", text: jobLabel(check.fixJob) });
      fix.addEventListener("click", () => startJob(check.fixJob));
      alert.append(fix);
    }
    return alert;
  }));
}

function jobLabel(id) {
  return state.jobs.find((j) => j.id === id)?.label ?? id;
}

document.getElementById("go").addEventListener("click", () => startJob("pipeline"));

// ── Run: the pipeline, step by step ──────────────────────────────────────────

/**
 * One row pattern for everything on this screen: a count (when the row has one),
 * a statement of fact, and the action on the right.
 *
 * `count: null` renders an empty cell rather than omitting it, so rows that
 * measure something and rows that just offer an action still line up.
 */
function renderRow({ count = null, text, note, label, disabled, onAction }) {
  const empty = count === 0;
  const li = el("li", { class: `row${empty ? " quiet" : ""}` });
  li.append(el("span", {
    class: `row-count${empty ? " none" : ""}`,
    text: count === null ? "" : String(count),
  }));

  const main = el("div", { class: "row-main" });
  main.append(el("span", { class: "row-text", text }));
  if (note) main.append(el("span", { class: "row-note", text: note }));
  li.append(main);

  if (label) {
    const button = el("button", { class: "btn", text: label });
    button.disabled = state.running || disabled === true;
    button.addEventListener("click", onAction);
    li.append(button);
  }
  return li;
}

/**
 * Run exactly the lectures sitting at one pipeline stage.
 *
 * The full pipeline would also work, but "Download" on a row reading "2 found on
 * Panopto" should do those two and nothing else. The ids are fetched at click
 * time rather than held in state because a scan may have just added rows the
 * status poll doesn't carry.
 */
const startForStatus = guard(async (status, noun) => {
  const { entries } = await get("/api/library");
  const ids = entries.filter((e) => e.status === status).map((e) => e.id).filter(Boolean);
  if (ids.length === 0) {
    toast(`No ${noun} left at that step.`);
    await refreshStatus();
    return;
  }
  await startJob("selected", { selection: { ids, dirs: [] } });
});

/**
 * The pipeline as its own steps, in order.
 *
 * Written this way because that's how it actually gets used: scan to see what's
 * appeared, then download, then process. The single button above still does the
 * lot for when you don't want to think about it.
 */
function renderStages() {
  const s = state.status;
  if (!s) return;
  const counts = s.lectureCounts ?? {};
  const news = counts.new ?? 0;
  const ready = counts.downloaded ?? 0;
  const failed = counts.error ?? 0;

  document.getElementById("stages").replaceChildren(
    renderRow({
      text: "Check Panopto for new recordings",
      note: "Records what's there. Downloads nothing.",
      label: "Scan",
      onAction: () => startJob("scan"),
    }),
    renderRow({
      count: news,
      text: "found on Panopto, not downloaded yet",
      label: news > 0 ? "Download" : null,
      onAction: () => startForStatus("new", "lectures"),
    }),
    renderRow({
      count: ready,
      text: "downloaded, no notes yet",
      label: ready > 0 ? "Process" : null,
      onAction: () => startForStatus("downloaded", "lectures"),
    }),
    renderRow({
      count: s.pendingPrettyCount,
      text: "lectures without pretty notes",
      label: s.pendingPrettyCount > 0 ? "Prettify" : null,
      onAction: () => startJob("pretty"),
    }),
    renderRow({
      count: failed,
      text: "lectures that failed last time",
      label: failed > 0 ? "Retry" : null,
      onAction: () => startJob("pipeline-retry"),
    }),
  );
}

function renderExtras() {
  const s = state.status;
  if (!s) return;

  document.getElementById("extras").replaceChildren(
    renderRow({
      count: s.incomingCount,
      text: "videos waiting in Incoming/",
      note: "Drop lecture files into Incoming/<CourseCode>/ to process them here.",
      label: s.incomingCount > 0 ? "Process" : null,
      onAction: () => startJob("local"),
    }),
    renderRow({
      text: "Copy notes to Exports/ and the workspace folder",
      label: "Export",
      onAction: () => startJob("export"),
    }),
    renderRow({
      text: "Rewrite every pretty note",
      note: "Replaces the ones you already have.",
      label: "Rewrite all",
      onAction: () => {
        if (!confirm("Rewrite every pretty note?\n\nThe current ones are overwritten.")) return;
        startJob("pretty-force");
      },
    }),
    renderRow({
      text: "Re-run local videos that errored",
      label: "Retry",
      onAction: () => startJob("local-retry"),
    }),
  );
}

/** Short, current state for a setup row — the long version is the alert above. */
function checkNote(id, good, bad) {
  const check = (state.status?.checks ?? []).find((c) => c.id === id);
  if (!check) return undefined;
  return check.ok ? good : bad;
}

function renderSetup() {
  document.getElementById("setup").replaceChildren(
    renderRow({
      text: "Panopto sign-in",
      note: checkNote("panopto-auth", "Session saved.", "No saved session."),
      label: "Sign in",
      onAction: () => startJob("auth-panopto"),
    }),
    renderRow({
      text: "Google sign-in",
      note: checkNote("gemini-auth", "Session saved.", "No saved session."),
      label: "Sign in",
      onAction: () => startJob("auth-gemini"),
    }),
    renderRow({
      text: "Vertex AI connection",
      note: checkNote("adc", "Credentials found.", "No credentials — run gcloud auth application-default login."),
      label: "Test",
      onAction: () => startJob("probe-vertex"),
    }),
    renderRow({
      text: "Gemini browser session",
      note: "Opens tabs to check the saved session still works and that they run in parallel.",
      label: "Test",
      onAction: () => startJob("probe-browser"),
    }),
  );
}

// ── Maintenance (on the Settings tab — destructive things belong there) ──────

function renderMaintenance() {
  const s = state.status;
  const list = document.getElementById("maintenance");
  if (!s) return;

  const items = [
    {
      count: s.lock.held && !s.lock.alive ? 1 : 0,
      text: "stale lock left by a run that didn't finish",
      note: s.lock.held && !s.lock.alive ? `PID ${s.lock.pid} is no longer running` : undefined,
      label: "Clear",
      action: "clear-lock",
      confirm: null,
    },
    {
      count: s.temp.orphanParts,
      text: "split video parts kept for resuming",
      note: `temp/ is currently ${formatBytes(s.temp.bytes)}`,
      label: "Delete",
      action: "clean-temp",
      confirm:
        "Delete the leftover split parts?\n\n" +
        "They're what lets an interrupted lecture resume. Without them, those lectures " +
        "split and upload again from part 1.",
    },
    {
      count: s.temp.checkpoints,
      text: "checkpoints from unfinished lectures",
      label: "Clear",
      action: "clear-checkpoints",
      confirm:
        "Clear all resume checkpoints?\n\n" +
        "Every part already generated for an unfinished lecture will be generated again.",
    },
  ];

  list.replaceChildren(...items.map((item) => renderRow({
    count: item.count,
    text: item.text,
    note: item.note,
    label: item.count > 0 ? item.label : null,
    onAction: guard(async () => {
      if (item.confirm && !confirm(item.confirm)) return;
      const result = await post("/api/maintenance", { action: item.action });
      toast(result.message);
      await refreshStatus();
    }),
  })));
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

const startJob = guard(async (jobId, extra = {}) => {
  await post("/api/jobs/start", { jobId, ...extra });
  // Jump to Run so the output is visible — a job started from the Library would
  // otherwise look like it did nothing.
  document.querySelector('.nav-item[data-tab="run"]').click();
});

document.getElementById("btn-cancel").addEventListener("click", guard(async () => {
  if (!confirm("Stop the running job?\n\nParts already finished are checkpointed and will be reused.")) return;
  await post("/api/jobs/cancel");
}));

document.getElementById("btn-clear").addEventListener("click", guard(async () => {
  await post("/api/jobs/clear");
}));

// ── Console ──────────────────────────────────────────────────────────────────

function consoleEl() { return document.getElementById("console"); }

function resetConsole(message = "Output appears here while something is running.") {
  consoleEl().replaceChildren(el("p", { class: "console-idle", text: message }));
}

/** Log lines arrive pre-formatted from the CLI; pull the level out for colour. */
const LINE = /^\[([^\]]+)\]\s+\[(DEBUG|INFO|WARN|ERROR)\]\s+(?:\[([^\]]*)\]\s+)?([\s\S]*)$/;

function appendLine(line) {
  const box = consoleEl();
  box.querySelector(".console-idle")?.remove();

  const row = el("div");
  const match = LINE.exec(line.text);

  if (line.stream === "system") {
    row.className = "t-system";
    row.textContent = line.text;
  } else if (match) {
    const [, timestamp, level, context, message] = match;
    row.append(el("span", { class: "t-time", text: timestamp.slice(11, 19) }));
    if (context) row.append(el("span", { class: "t-ctx", text: `${context}  ` }));
    row.append(el("span", {
      class: level === "ERROR" ? "t-error" : level === "WARN" ? "t-warn" : "",
      text: message,
    }));
  } else {
    if (line.stream === "stderr") row.className = "t-error";
    row.textContent = line.text;
  }

  box.append(row);

  // Cap the DOM independently of the server's buffer — thousands of nodes make
  // scrolling stutter long before memory becomes a problem.
  while (box.childElementCount > 1200) box.firstElementChild.remove();

  if (document.getElementById("autoscroll").checked) box.scrollTop = box.scrollHeight;
}

// ── Live event stream ────────────────────────────────────────────────────────

function connectEvents() {
  const source = new EventSource("/api/events");

  source.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "snapshot") {
      resetConsole();
      data.lines.forEach(appendLine);
      state.job = data.current ?? data.last;
      state.running = data.current?.phase === "running";
      renderRunTab();
    } else if (data.type === "log") {
      appendLine(data.line);
    } else if (data.type === "job") {
      state.job = data.job;
      state.running = data.job.phase === "running";
      renderRunTab();
      if (!state.running) {
        // Counts, health and the library all change as a result of a finished run.
        refreshStatus();
        if (activeTab() === "panel-library") refreshLibrary();
      }
    } else if (data.type === "cleared") {
      resetConsole();
    }
  });

  source.addEventListener("error", () => {
    // EventSource reconnects on its own; the snapshot on reconnect resyncs state.
    document.getElementById("state-meta").textContent = "lost contact with the server";
  });
}

function renderRunTab() {
  renderState();
  renderAlerts();
  renderStages();
  renderExtras();
  renderSetup();
  renderMaintenance();
}

// ── Library ──────────────────────────────────────────────────────────────────

const refreshLibrary = guard(async () => {
  const data = await get("/api/library");
  state.entries = data.entries;
  state.summary = data.summary;

  const courses = document.getElementById("lib-course");
  const keepCourse = courses.value;
  courses.replaceChildren(
    el("option", { value: "", text: "All courses" }),
    ...data.summary.courses.map((c) => el("option", { value: c, text: c })),
  );
  courses.value = keepCourse;

  const statuses = document.getElementById("lib-status");
  const keepStatus = statuses.value;
  statuses.replaceChildren(
    el("option", { value: "", text: "Any status" }),
    ...Object.keys(data.summary.byStatus).sort().map((s) =>
      el("option", { value: s, text: `${s} (${data.summary.byStatus[s]})` })),
  );
  statuses.value = keepStatus;

  renderLibrary();
});

function visibleEntries() {
  const { search, course, status, missingPretty } = state.filters;
  const needle = search.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (course && e.courseCode !== course) return false;
    if (status && e.status !== status) return false;
    if (missingPretty && !(e.hasRaw && !e.hasPretty)) return false;
    if (needle && !`${e.title} ${e.courseCode}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

const STATUS_TONE = {
  complete: "is-done",
  error: "is-error",
  processing: "is-work",
  downloading: "is-work",
  processed: "is-work",
  downloaded: "is-work",
  // Deliberately not is-error. A recording skipped for being empty is the tool
  // working, not failing, and colouring it red sends you looking for a fault.
  blank: "is-muted",
};

function renderLibrary() {
  const entries = visibleEntries();
  const body = document.getElementById("lib-body");
  const summary = state.summary;

  document.getElementById("lib-summary").textContent = summary
    ? `${entries.length} of ${summary.total} lectures · ${summary.missingPretty} without pretty notes`
    : "";

  body.replaceChildren(...entries.map((entry) => {
    const tr = el("tr");
    tr.classList.toggle("picked", state.selection.has(entry.key));

    const box = el("input");
    box.type = "checkbox";
    box.checked = state.selection.has(entry.key);
    box.addEventListener("change", () => {
      if (box.checked) state.selection.add(entry.key);
      else state.selection.delete(entry.key);
      renderLibrary();
    });
    tr.append(el("td", { class: "c-check" }, box));

    const cell = el("td");
    const title = el("button", { class: "title-link", text: entry.title });
    title.addEventListener("click", () => openDrawer(entry.key));
    cell.append(title);
    if (entry.errorMessage) {
      // The blank status stores its reason in the same column as a failure, but
      // it is an explanation, not a fault — so it reads as a note, not an alarm.
      const tone = entry.status === "blank" ? "row-hint" : "row-err";
      cell.append(el("div", { class: tone, text: truncate(entry.errorMessage, 150) }));
    }
    if (entry.checkpoint) {
      cell.append(el("div", {
        class: "row-hint",
        text: `can resume — ${entry.checkpoint.done} of ${entry.checkpoint.total} parts done`,
      }));
    }
    if (entry.status === "on-disk") {
      cell.append(el("div", { class: "row-hint", text: "on disk, not in the database" }));
    }
    tr.append(cell);

    tr.append(el("td", { class: "c-course", text: entry.courseCode }));

    const status = el("span", { class: `status ${STATUS_TONE[entry.status] ?? ""}` });
    status.append(el("span", { class: "dot" }), document.createTextNode(entry.status));
    status.querySelector(".dot").style.background = "currentColor";
    tr.append(el("td", { class: "c-status" }, status));

    const files = el("span", { class: "files" });
    files.append(
      el("span", { class: entry.hasRaw ? "yes" : "no", text: "raw" }),
      document.createTextNode("  "),
      el("span", { class: entry.hasPretty ? "yes" : "no", text: "pretty" }),
    );
    tr.append(el("td", { class: "c-files" }, files));
    tr.append(el("td", { class: "c-when", text: formatWhen(entry.updatedAt) }));

    return tr;
  }));

  document.getElementById("lib-empty").hidden = entries.length > 0;

  document.getElementById("lib-actions").hidden = state.selection.size === 0;
  document.getElementById("lib-count").textContent =
    `${state.selection.size} selected`;

  const shown = entries.map((e) => e.key);
  document.getElementById("lib-all").checked =
    shown.length > 0 && shown.every((k) => state.selection.has(k));
}

document.getElementById("lib-search").addEventListener("input", (e) => {
  state.filters.search = e.target.value;
  renderLibrary();
});
document.getElementById("lib-course").addEventListener("change", (e) => {
  state.filters.course = e.target.value;
  renderLibrary();
});
document.getElementById("lib-status").addEventListener("change", (e) => {
  state.filters.status = e.target.value;
  renderLibrary();
});
document.getElementById("lib-missing").addEventListener("change", (e) => {
  state.filters.missingPretty = e.target.checked;
  renderLibrary();
});
document.getElementById("lib-all").addEventListener("change", (e) => {
  const shown = visibleEntries().map((entry) => entry.key);
  if (e.target.checked) shown.forEach((k) => state.selection.add(k));
  else shown.forEach((k) => state.selection.delete(k));
  renderLibrary();
});

document.getElementById("lib-actions").addEventListener("click", guard(async (event) => {
  const action = event.target.dataset?.sel;
  if (!action) return;

  const selected = state.entries.filter((e) => state.selection.has(e.key));
  const ids = selected.map((e) => e.id).filter(Boolean);

  switch (action) {
    case "clear":
      state.selection.clear();
      renderLibrary();
      return;

    case "process":
      if (ids.length === 0) {
        toast("None of these are tracked in the database, so there's nothing to process.", "bad");
        return;
      }
      await startJob("selected", { selection: { ids, dirs: [] } });
      return;

    case "prettify": {
      const withRaw = selected.filter((e) => e.hasRaw);
      if (withRaw.length === 0) {
        toast("None of these have raw notes to prettify yet.", "bad");
        return;
      }
      await startJob("prettify-selected", { selection: { ids: [], dirs: withRaw.map((e) => e.lectureDir) } });
      return;
    }

    case "reset":
      toast((await post("/api/lectures/reset", { ids })).message);
      break;

    case "ignore":
      toast((await post("/api/lectures/ignore", { keys: selected.map((e) => e.key) })).message);
      break;

    case "forget":
      if (!confirm(
        `Remove ${ids.length} lecture(s) from the database?\n\n` +
        `Note files on disk are kept. Panopto lectures will be found again on the next scan.`,
      )) return;
      toast((await post("/api/lectures/forget", { ids })).message);
      break;
  }

  state.selection.clear();
  await refreshLibrary();
  await refreshStatus();
}));

// ── Drawer ───────────────────────────────────────────────────────────────────

function openDrawer(key) {
  state.drawerKey = key;
  const entry = state.entries.find((e) => e.key === key);
  if (!entry) return;

  document.getElementById("drawer-title").textContent = entry.title;
  document.getElementById("drawer-sub").textContent =
    `${entry.courseCode} · ${entry.status} · ${entry.source}`;

  const facts = document.getElementById("drawer-meta");
  facts.replaceChildren();
  const fact = (label, value) => {
    if (!value) return;
    facts.append(el("dt", { text: label }));
    facts.append(el("dd", {}, typeof value === "string" ? document.createTextNode(value) : value));
  };

  fact("Folder", entry.lectureDir || "not written yet");
  fact("Updated", formatWhen(entry.updatedAt, true));
  if (entry.errorMessage) fact(entry.status === "blank" ? "Skipped" : "Error", entry.errorMessage);
  if (entry.checkpoint) fact("Resume", `${entry.checkpoint.done} of ${entry.checkpoint.total} parts checkpointed`);
  if (entry.panoptoUrl) fact("Panopto", link(entry.panoptoUrl, "Open recording"));
  if (entry.geminiChatUrl) fact("Gemini", link(entry.geminiChatUrl, "Open conversation"));
  if (entry.rawBytes) fact("Raw", formatBytes(entry.rawBytes));
  if (entry.prettyBytes) fact("Pretty", formatBytes(entry.prettyBytes));

  const actions = el("div", { class: "fact-actions" });
  if (entry.lectureDir) {
    const open = el("button", { class: "btn", text: "Open folder" });
    open.addEventListener("click", guard(() => post("/api/lectures/open", { key: entry.key })));
    actions.append(open);
  }
  if (entry.hasRaw) {
    const pretty = el("button", { class: "btn", text: "Rewrite pretty notes" });
    pretty.addEventListener("click", guard(async () => {
      closeDrawer();
      await startJob("prettify-selected", { selection: { ids: [], dirs: [entry.lectureDir] } });
    }));
    actions.append(pretty);
  }
  if (entry.id) {
    const process = el("button", { class: "btn", text: "Process this lecture" });
    process.addEventListener("click", guard(async () => {
      closeDrawer();
      await startJob("selected", { selection: { ids: [entry.id], dirs: [] } });
    }));
    actions.append(process);
  }
  facts.append(actions);

  document.getElementById("drawer").hidden = false;
  loadNotes();
}

function closeDrawer() {
  document.getElementById("drawer").hidden = true;
  state.drawerKey = null;
}

document.getElementById("drawer").addEventListener("click", (event) => {
  if (event.target.dataset?.close !== undefined) closeDrawer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("drawer").hidden) closeDrawer();
});
document.querySelectorAll(".drawer-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.noteTab = tab.dataset.note;
    document.querySelectorAll(".drawer-tab").forEach((t) => t.classList.toggle("current", t === tab));
    loadNotes();
  });
});

async function loadNotes() {
  const target = document.getElementById("drawer-notes");
  if (!state.drawerKey) return;
  target.replaceChildren(el("p", { class: "console-idle", text: "Loading…" }));
  try {
    const data = await get(`/api/notes?key=${encodeURIComponent(state.drawerKey)}&which=${state.noteTab}`);
    target.replaceChildren(renderMarkdown(data.content));
  } catch (err) {
    target.replaceChildren(el("p", { class: "console-idle", text: err.message }));
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

function currentValue(path) {
  return path in state.draft ? state.draft[path] : state.settings.values[path];
}

function setDraft(path, value) {
  if (value === state.settings.values[path]) delete state.draft[path];
  else state.draft[path] = value;
  renderSettings();
}

function renderSettings() {
  const host = document.getElementById("settings-form");
  const groups = [];
  for (const field of state.settings.fields) {
    let group = groups.find((g) => g.name === field.group);
    if (!group) groups.push((group = { name: field.group, fields: [] }));
    group.fields.push(field);
  }

  host.replaceChildren(...groups.map((group) => {
    const section = el("section", { class: "set-group" });
    section.append(el("h2", { text: group.name }));
    const list = el("div", { class: "set-list" });
    group.fields.forEach((field) => list.append(renderSetting(field)));
    section.append(list);
    return section;
  }));

  const changed = Object.keys(state.draft);
  document.getElementById("settings-bar").hidden = changed.length === 0;
  document.getElementById("settings-changed").textContent =
    changed.length === 1 ? "1 unsaved change" : `${changed.length} unsaved changes`;
}

function renderSetting(field) {
  // A setting whose feature is switched off is shown but not editable — leaving
  // it live invites you to configure something that isn't going to happen.
  const inactive = field.dependsOn !== undefined && currentValue(field.dependsOn) === false;
  const wrap = el("div", { class: `set${inactive ? " set-off" : ""}` });
  const dirty = field.path in state.draft;
  const overridden = state.settings.overridden.includes(field.path);

  const name = el("div", { class: "set-name", text: field.label });
  if (dirty) name.append(el("span", { class: "changed", text: "unsaved" }));
  else if (overridden) name.append(el("span", { class: "overridden", text: "changed from default" }));
  wrap.append(name);

  const control = el("div", { class: "set-control" });
  const value = currentValue(field.path);

  if (field.type === "bool" || (field.type === "enum" && field.options.length === 2 && !field.options.includes(""))) {
    const options = field.type === "bool" ? [true, false] : field.options;
    const toggle = el("div", { class: "toggle" });
    options.forEach((option) => {
      const button = el("button", { text: field.type === "bool" ? (option ? "on" : "off") : option });
      button.classList.toggle("on", value === option);
      button.addEventListener("click", () => setDraft(field.path, option));
      toggle.append(button);
    });
    control.append(toggle);
  } else if (field.type === "enum") {
    const select = el("select", { class: "field" });
    field.options.forEach((option) => {
      select.append(el("option", { value: option, text: option === "" ? "model default" : option }));
    });
    select.value = value ?? "";
    select.addEventListener("change", () => setDraft(field.path, select.value));
    control.append(select);
  } else if (field.type === "int" && field.slider) {
    const range = el("input");
    range.type = "range";
    range.min = field.min;
    range.max = field.max;
    range.value = value;
    const readout = el("span", { class: "set-num", text: String(value) });
    range.addEventListener("input", () => { readout.textContent = range.value; });
    range.addEventListener("change", () => setDraft(field.path, Number(range.value)));
    control.append(range, readout);
  } else if (field.type === "int") {
    const input = el("input", { class: "field" });
    input.type = "number";
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    input.value = value;
    input.addEventListener("change", () => setDraft(field.path, Number(input.value)));
    control.append(input);
    if (field.path === "segmentSeconds") {
      control.append(el("span", { class: "set-help", text: `${Math.round(Number(value) / 60)} minutes` }));
    }
  } else if (field.type === "prompt") {
    // Committed on blur, not per keystroke: setDraft re-renders the whole form,
    // which on a textarea would put the caret back at the end after every letter.
    const area = el("textarea", { class: "field field-grow prompt-box" });
    // Sized to the prompt rather than fixed: a six-line grounding block in a
    // fourteen-row box is mostly empty, and a twenty-five-rule prettifier list in
    // one is a third visible. Clamped at both ends, and still resizable by hand.
    area.rows = Math.min(24, Math.max(8, String(value ?? "").split("\n").length + 2));
    area.spellcheck = false;
    area.value = value ?? "";
    area.addEventListener("change", () => setDraft(field.path, area.value));
    control.append(area);
  } else {
    const input = el("input", { class: "field field-grow" });
    input.type = "text";
    input.value = value ?? "";
    // A blank box says nothing about what belongs in it. The placeholder carries
    // the shape of the answer, which for a Panopto host or a bucket name is most
    // of what a first-time user needs.
    if (field.placeholder) input.placeholder = field.placeholder;
    input.addEventListener("change", () => setDraft(field.path, input.value));
    control.append(input);
  }

  if (inactive) {
    control.querySelectorAll("input, select, button, textarea").forEach((node) => { node.disabled = true; });
  }

  wrap.append(control);
  if (field.caution) wrap.append(el("div", { class: "set-help caution", text: field.caution }));
  else if (field.help) wrap.append(el("div", { class: "set-help", text: field.help }));
  return wrap;
}

document.getElementById("settings-save").addEventListener("click", guard(async () => {
  const result = await post("/api/settings", { values: state.draft });
  state.settings = result.settings;
  state.draft = {};
  renderSettings();
  toast(result.message);
  await refreshStatus();
}));

document.getElementById("settings-revert").addEventListener("click", () => {
  state.draft = {};
  renderSettings();
});

document.getElementById("settings-reset").addEventListener("click", guard(async () => {
  if (!confirm("Return every setting to the defaults in config.ts?")) return;
  const result = await post("/api/settings/reset");
  state.settings = result.settings;
  state.draft = {};
  renderSettings();
  toast(result.message);
  await refreshStatus();
}));

// ── Schedule ─────────────────────────────────────────────────────────────────

const refreshSchedule = guard(async () => {
  const data = await get("/api/schedule");
  state.tasks = data.tasks;
  state.schedulable = data.schedulable;
  renderSchedule();
});

function renderSchedule() {
  // Populated here rather than only after a /api/schedule fetch: the bootstrap
  // response already carries the job list, and querying Task Scheduler takes long
  // enough that the dropdown would otherwise sit visibly empty on first open.
  const select = document.getElementById("sched-job");
  const previous = select.value;
  select.replaceChildren(...state.schedulable.map((j) => el("option", { value: j.id, text: j.label })));
  select.value = previous || "pipeline";

  const list = document.getElementById("sched-list");
  if (state.tasks.length === 0) {
    list.replaceChildren(el("li", { class: "nothing", text: "No scheduled runs. Add one below." }));
    return;
  }

  list.replaceChildren(...state.tasks.map((task) => {
    const off = /disabled/i.test(task.status ?? "");
    const li = el("li", { class: `row${off || !task.exists ? " quiet" : ""}` });

    li.append(el("span", { class: "row-count", text: task.time || "—" }));

    const main = el("div", { class: "row-main" });
    main.append(el("span", { class: "row-text", text: task.jobLabel }));
    main.append(el("span", {
      class: "row-note",
      text: !task.exists
        ? "missing from Task Scheduler — remove it here"
        : off
          ? "paused"
          : `${frequencyWord(task.frequency)}${task.nextRun ? ` · next ${task.nextRun}` : ""}`,
    }));
    li.append(main);

    const buttons = el("div", { class: "selected-actions" });
    if (task.exists && task.jobId !== "unknown") {
      const toggle = el("button", { class: "btn", text: off ? "Resume" : "Pause" });
      toggle.addEventListener("click", guard(async () => {
        state.tasks = (await post("/api/schedule/toggle", { name: task.name, enabled: off })).tasks;
        renderSchedule();
      }));
      const now = el("button", { class: "btn", text: "Run now" });
      now.addEventListener("click", guard(async () => {
        toast((await post("/api/schedule/run", { name: task.name })).message);
      }));
      buttons.append(toggle, now);
    }
    const remove = el("button", { class: "link-btn danger", text: "Remove" });
    remove.addEventListener("click", guard(async () => {
      if (!confirm(`Remove the scheduled run at ${task.time}?`)) return;
      state.tasks = (await post("/api/schedule/delete", { name: task.name })).tasks;
      renderSchedule();
      toast("Scheduled run removed.");
    }));
    buttons.append(remove);

    li.append(buttons);
    return li;
  }));
}

function frequencyWord(frequency) {
  return { DAILY: "every day", HOURLY: "every hour", WEEKLY: "every week" }[frequency] ?? frequency.toLowerCase();
}

document.getElementById("sched-add").addEventListener("click", guard(async () => {
  const result = await post("/api/schedule/create", {
    jobId: document.getElementById("sched-job").value,
    time: document.getElementById("sched-time").value,
    frequency: document.getElementById("sched-freq").value,
  });
  state.tasks = result.tasks;
  renderSchedule();
  toast("Scheduled run added.");
}));

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", guard(async () => {
    const preset = button.dataset.preset;
    const jobId = document.getElementById("sched-job").value || "pipeline";
    const requests = preset === "hourly"
      ? [{ jobId, time: "00:00", frequency: "HOURLY" }]
      : preset.split(",").map((slot) => ({
          jobId,
          time: `${slot.slice(0, 2)}:${slot.slice(2)}`,
          frequency: "DAILY",
        }));

    let created = 0;
    const problems = [];
    for (const request of requests) {
      try {
        state.tasks = (await post("/api/schedule/create", request)).tasks;
        created++;
      } catch (err) {
        problems.push(err.message);
      }
    }
    renderSchedule();
    if (created > 0) toast(`Added ${created} scheduled run(s).`);
    else toast(problems.join(" ") || "Nothing added.", "bad");
  }));
});

// ── Markdown ─────────────────────────────────────────────────────────────────

/**
 * A deliberately small renderer for note files.
 *
 * Everything is escaped before any markup is produced. Note content is model
 * output written to disk, and this page has controls that start jobs and delete
 * scheduled tasks — treating those files as trusted HTML would be an injection
 * hole with real consequences.
 */
function renderMarkdown(source) {
  const container = el("div");
  let text = source;

  // Frontmatter is metadata, not prose — show it as a block rather than letting
  // the --- fences render as horizontal rules with loose YAML between them.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (frontmatter) {
    container.append(el("div", { class: "frontmatter", text: frontmatter[1] }));
    text = text.slice(frontmatter[0].length);
  }

  const html = [];
  const lines = text.split(/\r?\n/);
  let listType = null;
  let inCode = false;
  let codeLines = [];

  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };
  const openList = (type) => { if (listType !== type) { closeList(); html.push(`<${type}>`); listType = type; } };

  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isTableRule = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
  const tableCells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Tables, because the prettifier's output uses them heavily — without this
    // every table renders as a wall of pipe characters.
    if (!inCode && isTableRow(raw) && isTableRule(lines[i + 1] ?? "")) {
      closeList();
      const header = tableCells(raw);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(tableCells(lines[i++]));
      i--;
      html.push(
        "<table>",
        `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`,
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`,
        "</table>",
      );
      continue;
    }

    if (/^\s*```/.test(raw)) {
      if (inCode) {
        html.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeLines.push(raw); continue; }

    const line = raw.trimEnd();
    if (line.trim() === "") { closeList(); continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); html.push("<hr>"); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { closeList(); html.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) { openList("ul"); html.push(`<li>${inline(bullet[1])}</li>`); continue; }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) { openList("ol"); html.push(`<li>${inline(numbered[1])}</li>`); continue; }

    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && codeLines.length) html.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
  closeList();

  const body = el("div");
  body.innerHTML = html.join("");
  container.append(body);
  return container;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Links are rebuilt from escaped text, and only http(s) targets are allowed —
    // a javascript: URL would otherwise survive escaping intact.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
    .replace(/\[(\d{1,2}:[0-5]\d(?::[0-5]\d)?)\]/g, '<span class="ts">[$1]</span>');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function el(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.value !== undefined) node.value = options.value;
  if (options.title) node.title = options.title;
  node.append(...children);
  return node;
}

function link(href, text) {
  const a = el("a", { text });
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  return a;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatWhen(iso, absolute = false) {
  if (!iso) return "—";
  // SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC without a marker; without the Z
  // the browser reads it as local time and everything looks hours out.
  const date = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return iso;
  if (absolute) return date.toLocaleString();

  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

// ── Boot ─────────────────────────────────────────────────────────────────────

const refreshStatus = guard(async () => {
  state.status = await get("/api/status");
  renderRunTab();
});

const boot = guard(async () => {
  const data = await get("/api/bootstrap");
  state.status = data.status;
  state.jobs = data.jobs;
  state.settings = data.settings;
  state.tasks = data.tasks;
  state.schedulable = data.schedulable;

  renderRunTab();
  renderSettings();
  renderSchedule();
  connectEvents();
  await refreshLibrary();

  // Counts change from outside the panel too — a scheduled run, a video dropped
  // into Incoming/ — so poll rather than only refreshing after our own actions.
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 5000);
});

boot();
