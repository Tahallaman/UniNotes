/* UniNotes control panel — client.
   Vanilla ES modules, no build step, no dependencies. */

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  status: null,
  jobs: [],
  settings: { fields: [], values: {}, overridden: [] },
  /**
   * Which settings groups are expanded. Session-only and deliberately so —
   * where you were up to in a form is not a fact about your notes pipeline, and
   * every group starts closed so the page is an index rather than a wall.
   */
  settingsOpen: new Set(),
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
  preview: null,     // last naming preview, or null before the first one
  termProblems: [],  // validation messages keyed to a term id
  stopped: false,    // the server was shut down from here; nothing will answer again
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
      text: "Copy notes to Exports/",
      label: "Export",
      onAction: () => startJob("export"),
    }),
    renderRow({
      text: "Copy pretty notes to your study folder",
      note: s.workspace?.enabled
        ? `Filed by week into ${s.workspace.root}`
        : "Switch on Settings → Second copy to use this.",
      label: "Copy",
      disabled: !s.workspace?.enabled,
      onAction: () => startJob("sync-workspace"),
    }),
    renderRow({
      text: "Check where those copies would land",
      note: "Lists every destination path. Writes nothing.",
      label: "Preview",
      disabled: !s.workspace?.enabled,
      onAction: () => startJob("sync-workspace-dry"),
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

/**
 * Start a job, and by default go and watch it.
 *
 * `stay` is for the ones you fire off and carry on around: fetching a video is
 * a download you asked for and then forget about, and throwing you onto the Run
 * tab to watch a progress log loses your place in the list you were working
 * through. Those get a line of toast instead, and the library refreshes itself
 * when the job finishes, so the row you pressed turns into "play" on its own.
 */
const startJob = guard(async (jobId, { stay = false, toast: message = "", ...extra } = {}) => {
  await post("/api/jobs/start", { jobId, ...extra });
  if (stay) {
    if (message) toast(message);
    return;
  }
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

let eventSource = null;

function connectEvents() {
  const source = new EventSource("/api/events");
  eventSource = source;

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
    // Losing the stream is expected after a shutdown we asked for, and saying
    // "lost contact" over the top of "Stopped" would read like a fault.
    if (state.stopped) return;
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
    tr.append(el("td", { class: "c-video" }, videoControl(entry)));

    // The date the list is now ordered by, so the order is legible rather than
    // something you have to take on trust. Its source is in the tooltip: a date
    // read off a title is a guess, and knowing which ones are guesses is what
    // tells you where to look when a lecture is in the wrong place.
    const shown = formatLectureDate(entry.lectureDate);
    tr.append(el("td", { class: "c-date" }, el("span", {
      class: shown ? "lecture-date" : "lecture-date none",
      text: shown ?? "no date",
      title: shown
        ? `${entry.lectureDate} — from ${entry.dateSource}`
        : "No date found. Open the lecture to set one.",
    })));

    // The week, and enough of why to act on it being wrong: a lecture with no
    // date shows the gap rather than an empty cell you'd read as "week unknown,
    // nothing to be done about it".
    const week = el("span", {
      class: entry.week === null ? "week none" : "week",
      text: entry.week === null ? (entry.lectureDate ? "—" : "no date") : `Week ${entry.week}`,
      title: entry.lectureDate
        ? `${entry.lectureDate} (from ${entry.dateSource})${entry.termLabel ? ` · ${entry.termLabel}` : " · outside every term"}`
        : "No date found. Open the lecture to set one.",
    });
    tr.append(el("td", { class: "c-week" }, week));

    tr.append(el("td", { class: "c-watched" }, watchedControl(entry)));
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

/**
 * Watch, or fetch something to watch, straight from the row.
 *
 * A column rather than a button two clicks deep in the drawer. Playing a lecture
 * against its notes is the most useful thing the panel does and it was the least
 * findable: nothing in the list said a recording existed, or could, so it was
 * only ever discovered by opening a lecture and reading the buttons. Here it
 * sits beside Notes in the list you already scan, in the same shape — a couple
 * of quiet words per row, one of which lights up when it's live.
 */
function videoControl(entry) {
  if (!canWatch(entry)) {
    return el("span", {
      class: "video-na",
      text: "—",
      title: "The player syncs notes to the recording, so it needs notes first.",
    });
  }

  if (entry.hasVideo) {
    const play = el("button", {
      class: "video-link ready",
      text: "play",
      title: "Watch this lecture with its notes beside it",
    });
    play.addEventListener("click", () => openDrawer(entry.key, true));
    return play;
  }

  if (!entry.id || !entry.lectureDir || !entry.panoptoUrl) {
    return el("span", {
      class: "video-na",
      text: "—",
      title: "No Panopto recording to fetch for this one.",
    });
  }

  const fetchVideo = el("button", {
    class: "video-link",
    text: "fetch",
    title: "Download the recording so you can watch it against these notes",
  });
  fetchVideo.addEventListener("click", guard(() =>
    startJob("fetch-video", {
      selection: { ids: [entry.id], dirs: [] },
      stay: true,
      toast: "Fetching the recording — this row turns into “play” when it lands.",
    }),
  ));
  return fetchVideo;
}

/**
 * The Watched tick for one lecture.
 *
 * Applied optimistically and put back if the write fails, so ticking a box feels
 * immediate. Nothing else is re-rendered: a full renderLibrary() here would
 * rebuild the row under the pointer mid-click for no visible gain.
 *
 * A folder with no database row has nowhere to record this, so it gets a dash
 * that says why rather than a box that silently forgets.
 */
function watchedControl(entry) {
  if (!entry.id) {
    return el("span", {
      class: "watched-na",
      text: "—",
      title: "Not tracked in the database, so this can't be saved.",
    });
  }

  const box = el("input");
  box.type = "checkbox";
  box.className = "watched-box";
  showWatched(box, entry);
  box.addEventListener("change", async () => {
    const wanted = box.checked;
    const wasAt = entry.resumeAt;
    entry.watched = wanted;
    // Unticking is "start again", and the server clears the position to match —
    // see setWatched. Mirrored here so the box doesn't sit showing a dash for the
    // few hundred milliseconds before the answer comes back.
    if (!wanted) entry.resumeAt = null;
    showWatched(box, entry);
    try {
      await post("/api/lectures/watched", { ids: [entry.id], watched: wanted });
    } catch (err) {
      entry.watched = !wanted;
      entry.resumeAt = wasAt;
      showWatched(box, entry);
      toast(err.message, "bad");
    }
  });
  return box;
}

/** Below this, a position is a lecture you opened, not one you got into. */
const RESUME_MIN = 15;

/** How far through, 0–1, or null when there's nothing recorded to divide. */
function watchFraction(entry) {
  const at = Number(entry.resumeAt);
  const length = Number(entry.videoSeconds);
  if (!(at > 0) || !(length > 0)) return null;
  return Math.min(1, at / length);
}

/** Started and not finished — the state the box has no tick for. */
function partWatched(entry) {
  return !entry.watched && Number(entry.resumeAt) >= RESUME_MIN;
}

/**
 * Put a lecture's watched state on its box, in all three of them.
 *
 * A checkbox has a third look and this is exactly what it is for: a dash says
 * "some of it", where an empty box would claim you had never opened the thing.
 * The tooltip carries the numbers, since a dash on its own says how much only
 * in the sense that it says "not all".
 */
function showWatched(box, entry) {
  box.checked = entry.watched;
  box.indeterminate = partWatched(entry);
  const fraction = watchFraction(entry);
  box.title = entry.watched
    ? "Watched — click to clear"
    : !box.indeterminate
      ? "Mark as watched"
      : fraction === null
        ? `In progress — picks up at ${clockText(entry.resumeAt)}`
        : `${Math.round(fraction * 100)}% watched — picks up at ${clockText(entry.resumeAt)}`;
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

/**
 * Open a lecture.
 *
 * The side panel always, unless you asked to watch. Opening straight into the
 * full-window player because a video happened to be cached took the decision
 * away from you: the panel is how you get at the folder, the date, the week and
 * every per-lecture action, and it was unreachable for exactly the lectures you
 * had done the most with. Watching is now a thing you press.
 */
function openDrawer(key, play = false) {
  state.drawerKey = key;
  const entry = state.entries.find((e) => e.key === key);
  if (!entry) return;

  document.getElementById("drawer-title").textContent = entry.title;

  const facts = document.getElementById("drawer-meta");
  facts.replaceChildren();
  const fact = (label, value) => {
    if (!value) return;
    facts.append(el("dt", { text: label }));
    facts.append(el("dd", {}, typeof value === "string" ? document.createTextNode(value) : value));
  };

  // These three were the header's second line until it cost more than it told.
  fact("Course", entry.courseCode);
  fact("Status", entry.status);
  fact("Source", entry.source);
  fact("Folder", entry.lectureDir || "not written yet");
  fact("Updated", formatWhen(entry.updatedAt, true));
  if (entry.id) fact("Date", dateControl(entry));
  if (entry.week !== null) fact("Week", `${entry.termLabel} · week ${entry.week}`);
  else if (entry.lectureDate) fact("Week", "Its date falls outside every term you've set up.");
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
  // The player is notes synced to a recording, so a lecture with no notes has
  // nothing to sync and nothing to watch them against. Gating both the download
  // and the playback on that keeps the feature from looking broken on a row it
  // was never going to work for.
  if (canWatch(entry)) {
    if (entry.hasVideo) {
      // Solid: once there's a video, watching it is the thing you came for.
      const play = el("button", { class: "btn btn-solid", text: "Play video" });
      play.addEventListener("click", () => openDrawer(entry.key, true));
      actions.append(play);
    } else if (entry.id && entry.lectureDir && entry.panoptoUrl) {
      // Offered rather than automatic: fetching a video is a browser-driven
      // download measured in gigabytes, so it happens when you ask for it.
      const fetchVideo = el("button", { class: "btn", text: "Fetch video for the player" });
      fetchVideo.addEventListener("click", guard(async () => {
        closeDrawer();
        await startJob("fetch-video", {
          selection: { ids: [entry.id], dirs: [] },
          stay: true,
          toast: "Fetching the recording — the lecture gets a “play” link when it lands.",
        });
      }));
      actions.append(fetchVideo);
    }
  }
  facts.append(actions);

  // No tab is forced on the way in. Pretty is where a lecture opens, here and
  // in the player alike — it is the readable version and the one you want in
  // front of you — and after that the tab is simply the one you last chose,
  // which is the behaviour of every other pane in the panel.
  //
  // The transcript stands on its own — it's a file beside the notes, so the tab
  // is offered whether or not there's a video to sync it to.
  const transcriptTab = document.querySelector('.drawer-tab[data-note="transcript"]');
  transcriptTab.hidden = !entry.hasCaptions;
  if (!entry.hasCaptions && state.noteTab === "transcript") state.noteTab = "pretty";
  document.querySelectorAll(".drawer-tab").forEach((t) =>
    t.classList.toggle("current", t.dataset.note === state.noteTab),
  );

  document.getElementById("drawer").hidden = false;
  setupPlayer(entry, play);
  loadNotes();
}

/**
 * Is there anything to watch this lecture against?
 *
 * The player is notes synced to a recording. Without notes there is no sync, no
 * highlight, nothing to click to seek by — just a video in a panel, which is
 * what the Panopto link already gives you.
 */
function canWatch(entry) {
  return entry.hasRaw || entry.hasPretty;
}

/**
 * The date a lecture's week is derived from, and a box to correct it.
 *
 * The only manual input in an otherwise automatic chain, so it says where the
 * current value came from: "from title" is a guess worth checking, "from
 * panopto" rarely is. Clearing the box gives the guess back rather than leaving
 * the lecture dateless.
 */
function dateControl(entry) {
  const wrap = el("div", { class: "date-edit" });

  const input = el("input", { class: "field" });
  input.type = "date";
  input.value = entry.lectureDate ?? "";
  input.addEventListener("change", guard(async () => {
    const value = input.value || null;
    const result = await post("/api/lectures/date", { id: entry.id, date: value });
    toast(result.message);
    await refreshLibrary();
    const updated = state.entries.find((e) => e.key === entry.key);
    // Reopened in whatever mode it was in — correcting a date shouldn't throw
    // you out of the player you were watching in. The tab looks after itself.
    if (updated) openDrawer(updated.key, player.active);
    refreshPreview();
  }));
  wrap.append(input);

  wrap.append(el("span", {
    class: "date-source",
    text: entry.lectureDate
      ? entry.dateOverride ? "set by you" : `from ${entry.dateSource}`
      : "nothing to go on — set one",
  }));

  if (entry.dateOverride) {
    const clear = el("button", { class: "link-btn", text: "Use the detected date" });
    clear.addEventListener("click", guard(async () => {
      toast((await post("/api/lectures/date", { id: entry.id, date: null })).message);
      await refreshLibrary();
      const updated = state.entries.find((e) => e.key === entry.key);
      if (updated) openDrawer(updated.key);
      refreshPreview();
    }));
    wrap.append(clear);
  }

  return wrap;
}

function closeDrawer() {
  document.getElementById("drawer").hidden = true;
  state.drawerKey = null;
  teardownPlayer();
}

// closest(), not the target itself: the close button is an icon, so a click in
// the middle of it lands on a <path> and never on the element carrying
// data-close. It worked while the icon was small enough that most of the button
// was padding, which is not a thing to depend on.
document.getElementById("drawer").addEventListener("click", (event) => {
  if (event.target.closest?.("[data-close]")) closeDrawer();
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

/**
 * Put new content in the notes pane, without it reading as a scroll.
 *
 * Replacing the children resets scrollTop to 0, and the browser reports that as
 * a scroll like any other — which is how switching from Pretty to Transcript
 * used to switch Following off and leave you to press it again. Stamping the
 * swap first is what tells the scroll handler the movement was ours.
 */
function swapNotes(target, node) {
  player.reloadAt = performance.now();
  target.replaceChildren(node);
}

/**
 * Where you were in each tab of each lecture.
 *
 * Following puts you wherever the video is, which is the whole point of it. With
 * it off, the tabs are three documents you are reading by hand, and throwing
 * each one back to the top every time you glance at another is the behaviour of
 * something that has not been paying attention.
 *
 * Session-only, and per lecture as well as per tab: it is a reading position,
 * not a fact worth writing to disk.
 */
const scrollMemory = new Map();

function scrollKey() {
  return `${state.drawerKey}::${state.noteTab}`;
}

function rememberScroll() {
  if (state.drawerKey) scrollMemory.set(scrollKey(), notesEl.scrollTop);
}

/** Clamped by the browser, so a shorter document just lands at its end. */
function restoreScroll() {
  const remembered = scrollMemory.get(scrollKey());
  if (!remembered) return;
  player.reloadAt = performance.now();
  notesEl.scrollTop = remembered;
}

async function loadNotes() {
  const target = document.getElementById("drawer-notes");
  if (!state.drawerKey) return;
  swapNotes(target, el("p", { class: "console-idle", text: "Loading…" }));
  try {
    if (state.noteTab === "transcript") {
      const vtt = await getText(`/api/subtitles?key=${encodeURIComponent(state.drawerKey)}`);
      swapNotes(target, renderTranscript(vtt));
    } else {
      const data = await get(`/api/notes?key=${encodeURIComponent(state.drawerKey)}&which=${state.noteTab}`);
      swapNotes(target, renderMarkdown(data.content));
    }
    // Re-stamps the groups and, while Following, centres the new tab on wherever
    // the video has got to — so a switch lands you at the same moment, not at
    // the top of a different document.
    syncNotes();
    // Not following, so nothing has claimed a position: put you back where you
    // left this tab.
    if (!player.active || !player.follow) restoreScroll();
  } catch (err) {
    swapNotes(target, el("p", { class: "console-idle", text: err.message }));
  }
}

/** Plain-text GET. /api/subtitles answers with WebVTT, not JSON. */
async function getText(path) {
  const res = await fetch(path, { headers: { "x-uninotes": "1" } });
  const body = await res.text();
  if (!res.ok) throw new Error(body || `Request failed (${res.status})`);
  return body;
}

// ── Transcript ───────────────────────────────────────────────────────────────

/** "HH:MM:SS.mmm" → seconds. NaN if it isn't one. */
function vttTime(value) {
  const m = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/**
 * WebVTT → the same shape of document the notes tabs produce.
 *
 * Each cue becomes a block carrying its own timestamp chip, so the existing sync
 * machinery picks it up unchanged — one cue per group means the highlight tracks
 * the transcript line by line, which is exactly what a transcript is for.
 *
 * Consecutive cues are merged while they're short, because Panopto's
 * auto-transcript breaks on breath rather than on sense, and a wall of two-second
 * fragments is unreadable. The merged block keeps the *first* cue's time, so
 * clicking it still lands where that sentence began.
 */
function renderTranscript(vtt) {
  const container = el("div", { class: "transcript" });
  const cues = [];

  for (const block of vtt.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0 || /^WEBVTT/.test(lines[0])) continue;
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;

    const [from] = lines[timingIndex].split("-->");
    const start = vttTime(from);
    if (!Number.isFinite(start)) continue;

    const text = lines.slice(timingIndex + 1).join(" ").trim();
    if (text) cues.push({ start, text });
  }

  if (cues.length === 0) {
    container.append(el("p", { class: "console-idle", text: "This transcript has no readable lines." }));
    return container;
  }

  container.append(el("p", {
    class: "transcript-note",
    text: "Auto-generated by Panopto. Expect the odd mangled name or term.",
  }));

  const MERGE_UNDER = 220;
  const merged = [];
  for (const cue of cues) {
    const last = merged[merged.length - 1];
    if (last && last.text.length < MERGE_UNDER) last.text += ` ${cue.text}`;
    else merged.push({ start: cue.start, text: cue.text });
  }

  const html = merged
    .map((cue) => `<p><span class="ts">[${escapeHtml(clockText(cue.start))}]</span> ${escapeHtml(cue.text)}</p>`)
    .join("");

  const body = el("div");
  body.innerHTML = html;
  container.append(body);
  return container;
}

// ── Player ───────────────────────────────────────────────────────────────────

/**
 * The video and the notes, kept in step.
 *
 * One rule shapes the whole thing: **scrolling is passive, clicking is active.**
 * Reading ahead while a lecture plays must never drag the video somewhere, so no
 * scroll handler ever seeks — only a click does. The reverse direction, the
 * video moving the notes, is opt-in and switches itself off the moment you
 * scroll, because a page that scrolls out from under you while you're reading it
 * is worse than one that never scrolls at all.
 *
 * The video is the local file, not Panopto. Panopto's pages send
 * `frame-ancestors 'self' https:` and so refuse to embed in a page served over
 * http://127.0.0.1, and its embed API exposes only a polled current time. A file
 * served by our own server seeks exactly and works offline. See src/gui/video.ts.
 */
const player = {
  /** False when the drawer has no video, which disables every handler below. */
  active: false,
  /**
   * Whether the notes and the video are tied together at all.
   *
   * Off, this is just the notes with a video beside them: nothing highlights,
   * nothing scrolls itself, and a click is a click rather than a seek. Worth
   * having as one switch because the sync is an opinion about how you read, and
   * sometimes you only want to read.
   */
  sync: true,
  /** [{ time, blocks }] in document order — one entry per distinct timestamp. */
  groups: [],
  /** Index into groups of whatever is playing now, or -1 before the first. */
  current: -1,
  follow: true,
  /** When we last scrolled the notes ourselves, so we don't read it as yours. */
  autoScrollAt: 0,
  /** And where we scrolled it to — the surer half of the same test. */
  autoScrollTo: -1,
  /**
   * When the pane's contents were last replaced.
   *
   * A swap resets scrollTop to 0 and the browser reports that as a scroll, which
   * is neither you scrolling away nor a position worth remembering.
   */
  reloadAt: 0,
  /** Measured narrowest sensible notes column, in px — the drag floor. */
  notesFit: 0,
  /**
   * The lead-in window a click opened, as [from, until) in seconds.
   *
   * Clicking a note seeks a couple of seconds *before* its timestamp, which by
   * the plain rule ("last group at or before now") lights up the previous group
   * — you click one paragraph and a different one highlights. So a click pins
   * its own group for exactly the run-up it asked for. Bounded at both ends, not
   * just the top: scrubbing away during those seconds has to break the pin, or
   * the highlight would sit frozen wherever the click left it.
   */
  pinFrom: 0,
  pinUntil: 0,
  /** The lecture whose position is being recorded, or null for one with no row. */
  lectureId: null,
  /** Where to pick up once the file reports its length. 0 means from the top. */
  resumeTo: 0,
  /**
   * Seconds the file runs ahead of its transcript. See toVideo/toTranscript.
   *
   * Held here rather than read from the entry each time because it is consulted
   * on every timeupdate, and because it changes under you while you nudge it.
   */
  offset: 0,
  /** The lecture whose transcript is attached, so it can be re-fetched shifted. */
  captionsKey: "",
  /** When the position was last written, so playing doesn't write every frame. */
  savedAt: 0,
};

const videoEl = document.getElementById("player-video");
const notesEl = document.getElementById("drawer-notes");

/** Blocks that can carry a time. Deliberately not nested in each other. */
const TIME_BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr";
const HEADINGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

/** "12:34" or "1:02:03" → seconds. Null if it isn't one. */
function parseClock(text) {
  const bits = text.trim().split(":").map((n) => parseInt(n, 10));
  if (bits.length < 2 || bits.some((n) => !Number.isFinite(n))) return null;
  if (bits.length === 2) return bits[0] * 60 + bits[1];
  if (bits.length === 3) return bits[0] * 3600 + bits[1] * 60 + bits[2];
  return null;
}

/**
 * The two clocks a lecture has, and the very short list of things that cross.
 *
 * Panopto can trim the front of a recording for playback and cut its transcript
 * to the trimmed version, then hand you the *untrimmed* file to download. Those
 * two then disagree by however much was cut — seconds usually, four minutes on a
 * bad one.
 *
 * Which side of that anything sits on is decided by what it was made from, and
 * almost everything was made from the file:
 *
 *   FILE time — the video, and the notes, whose timestamps come from the model
 *     reading this same recording. Measured on the lecture that prompted all
 *     this: the notes put a quotation at 10:59 and the transcript has it at
 *     07:01, and it is the notes that agree with the picture. The Transcript tab
 *     and the subtitles are file time too, because `serveCaptions` shifts the
 *     WebVTT before either sees it.
 *
 *   TRANSCRIPT time — the saved reel, whose spans are cut server-side from the
 *     unshifted cues, and the position Explain sends, which the server looks up
 *     in those same cues.
 *
 * So everything on screen shares one clock and needs no conversion at all; the
 * crossings are the reel and Explain, and nothing else. This started out
 * converting the notes as well, on the assumption that a timestamp is a
 * timestamp — which put every click four minutes late on exactly the lectures
 * the offset was added for.
 */
function toVideo(transcriptSeconds) {
  return Math.max(0, transcriptSeconds + player.offset);
}

function toTranscript(videoSeconds) {
  return Math.max(0, videoSeconds - player.offset);
}

function clockText(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const pad = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(s / 3600);
  const rest = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
}

/** The seconds a block's own timestamp names, or null. Ranges give their start. */
function ownTime(block) {
  const chip = block.querySelector(".ts");
  if (!chip) return null;
  const first = chip.textContent.replace(/[[\]]/g, "").split(/[-–—]/)[0];
  return parseClock(first);
}

/**
 * Give every block a time and a group, and return the groups.
 *
 * Most blocks carry no timestamp of their own — the model stamps the start of a
 * point and then writes several bullets under it — so unstamped blocks inherit
 * from the stamped one above. Headings are the exception: a heading introduces
 * what follows, so it takes the time of the next stamped block instead. Without
 * that, entering a new section leaves its title highlighted with the section you
 * just left, which reads as if the highlight is lagging.
 */
function stampTimes(root) {
  const blocks = [...root.querySelectorAll(TIME_BLOCKS)];
  const times = blocks.map(ownTime);

  for (let i = 0; i < blocks.length; i++) {
    if (times[i] !== null || !HEADINGS.has(blocks[i].tagName)) continue;
    for (let j = i + 1; j < blocks.length; j++) {
      if (times[j] !== null) { times[i] = times[j]; break; }
    }
  }

  let carry = null;
  for (let i = 0; i < times.length; i++) {
    if (times[i] === null) times[i] = carry;
    else carry = times[i];
  }

  const groups = [];
  blocks.forEach((block, i) => {
    if (times[i] === null) return;
    const last = groups[groups.length - 1];
    if (last && last.time === times[i]) last.blocks.push(block);
    else groups.push({ time: times[i], blocks: [block] });
    block.dataset.t = String(times[i]);
    // The index, not just the time: two groups can share a timestamp if the
    // model repeats one, and a click has to know which of them you meant.
    block.dataset.g = String(groups.length - 1);
  });

  return groups;
}

/** Re-read the notes now showing and hook them to the video. */
function syncNotes() {
  notesEl.removeAttribute("data-synced");
  player.groups = [];
  player.current = -1;
  player.pinUntil = 0;
  if (!player.active) return;

  player.groups = stampTimes(notesEl);
  if (player.groups.length === 0 || !player.sync) return;

  // Only now does anything become clickable, so notes with no timestamps in them
  // never grow a pointer cursor over text that would do nothing.
  notesEl.dataset.synced = "";
  highlightAt(videoEl.currentTime);
}

/**
 * Put the passage being spoken in the middle of the pane.
 *
 * The whole group, not its first block: a point can run to a heading and a dozen
 * bullets, and centring only the opening line leaves the rest of what's being
 * said pushed below the fold. A group taller than the pane can't be centred
 * without hiding its start, so that one centres its first block instead and lets
 * the rest run on below.
 *
 * Runs only when the group changes, so following along doesn't mean re-centring
 * four times a second.
 */
function centreOnGroup(group) {
  const pane = notesEl.getBoundingClientRect();
  const first = group.blocks[0].getBoundingClientRect();
  const last = group.blocks[group.blocks.length - 1].getBoundingClientRect();

  const top = first.top - pane.top + notesEl.scrollTop;
  const bottom = last.bottom - pane.top + notesEl.scrollTop;
  const anchor = bottom - top <= pane.height * 0.8
    ? (top + bottom) / 2
    : top + first.height / 2;

  player.autoScrollAt = performance.now();
  notesEl.scrollTop = anchor - pane.height / 2;
  // Where we left it. The scroll event arrives later, and on a busy frame later
  // can be longer than any timing window worth guessing at — so the handler
  // recognises our own scroll by position rather than only by the clock.
  player.autoScrollTo = notesEl.scrollTop;
}

function setCurrentGroup(index, scroll) {
  if (index === player.current) return;
  if (player.current >= 0) {
    for (const block of player.groups[player.current].blocks) block.classList.remove("now");
  }
  player.current = index;
  if (index < 0) return;

  for (const block of player.groups[index].blocks) block.classList.add("now");
  if (scroll && player.follow) centreOnGroup(player.groups[index]);
}

function highlightAt(seconds) {
  if (!player.sync || player.groups.length === 0) return;
  if (seconds >= player.pinFrom && seconds < player.pinUntil) return;
  player.pinUntil = 0;

  let index = -1;
  for (let i = 0; i < player.groups.length; i++) {
    if (player.groups[i].time <= seconds) index = i;
  }
  setCurrentGroup(index, true);
}

/**
 * Turn the whole sync on or off.
 *
 * Off leaves the notes exactly as they read anywhere else in the panel — no
 * highlight, no self-scrolling, no click-to-seek — while the video plays on
 * beside them. Following is a setting *of* the sync, so it greys out rather than
 * staying available as a control that would do nothing.
 */
function setSync(on) {
  player.sync = on;
  const button = document.getElementById("player-sync");
  button.setAttribute("aria-pressed", String(on));
  button.querySelector(".chip-label").textContent = on ? "Synced" : "Not synced";
  document.getElementById("player-follow").disabled = !on;

  if (on) {
    if (player.groups.length > 0) notesEl.dataset.synced = "";
    highlightAt(videoEl.currentTime);
    return;
  }

  notesEl.removeAttribute("data-synced");
  if (player.current >= 0) {
    for (const block of player.groups[player.current].blocks) block.classList.remove("now");
  }
  // Forgotten, not remembered: switching back on should light up wherever the
  // video has got to by then, not wherever it was when you switched off.
  player.current = -1;
  player.pinUntil = 0;
}

function setFollow(on) {
  player.follow = on;
  const button = document.getElementById("player-follow");
  button.setAttribute("aria-pressed", String(on));
  // The label says what the button will do, not only what is true now: once you
  // have scrolled away, "jump back" is the thing you're looking for.
  button.querySelector(".chip-label").textContent = on ? "Following" : "Jump to now";
  button.title = on
    ? "The notes scroll themselves to keep up with the video"
    : "Scroll back to where the video has got to, and follow along again";
}

function jumpToNow() {
  if (player.current < 0) return;
  centreOnGroup(player.groups[player.current]);
}

function seekTo(seconds, groupIndex) {
  // Read before the seek, because seeking is itself enough to change it.
  const playing = !videoEl.paused;
  // The lead-in buys you the run-up to a point you're about to *hear*. Paused,
  // there's nothing to hear: the frame is the whole answer, and starting two
  // seconds early shows the slide before the one you pointed at.
  const lead = playing ? Number(state.settings.values["player.seekLeadIn"] ?? 2) : 0;
  // No conversion. Whatever is in the notes pane — the notes, or the Transcript
  // tab, which is served already shifted — carries the video's own clock.
  videoEl.currentTime = Math.max(0, seconds - lead);
  setFollow(true);

  if (groupIndex >= 0) {
    player.pinFrom = videoEl.currentTime;
    player.pinUntil = seconds;
    // No scroll: you clicked it, so it is already under your eye. Recentring
    // the page on the thing you just pointed at only moves it away from you.
    setCurrentGroup(groupIndex, false);
  }

  // Only if it was already running. A click in the notes while the video is
  // paused is reading, not watching — you're working through the points and
  // moving the picture along with you, and having it start talking every time
  // you click a line means reaching for pause as often as you click.
  //
  // Autoplay policy can still refuse, in which case the seek has happened and
  // you press play yourself.
  if (playing) videoEl.play().catch(() => {});
}

function setupPlayer(entry, play) {
  const body = document.getElementById("drawer-body");
  body.dataset.side = state.settings.values["player.notesSide"] === "left" ? "left" : "right";

  teardownPlayer();
  // Opt-in. A cached video is not by itself a request to watch one.
  if (!play || !entry.hasVideo || !canWatch(entry)) return;

  // Folded away every time a lecture opens rather than remembered: you come here
  // to watch, and the facts are two seconds away when you want them.
  document.getElementById("drawer").dataset.details = "off";
  const details = document.getElementById("drawer-details");
  details.hidden = false;
  details.querySelector(".head-btn-label").textContent = "Details";
  fullscreenBtn.hidden = false;
  body.dataset.player = "on";

  // Measure the fit — the floor for dragging. It's in ch, so it depends on the
  // font and can only be read off a laid-out pane; pinning the width to the fit
  // expression for one measurement is the cheapest honest way to get it.
  body.style.setProperty("--notes-width", "var(--notes-fit)");
  const fit = document.querySelector(".notes-pane").getBoundingClientRect().width;
  body.style.removeProperty("--notes-width");
  player.notesFit = Math.round(Math.min(fit, body.getBoundingClientRect().width - PANE_MIN));

  // Clamped on the way in, not just on the way out: a width saved on a wide
  // monitor would otherwise leave no room for the video on a laptop.
  const saved = Number(state.settings.values["player.notesWidth"]) || 0;
  applyNotesWidth(saved ? clampNotesWidth(saved) : defaultNotesWidth());
  document.getElementById("player-pane").hidden = false;
  player.active = true;
  setFollow(true);
  setSync(state.settings.values["player.sync"] !== false);
  document.getElementById("player-clock").textContent = "00:00";
  // Set before the file loads, and applied by the loadedmetadata handler — the
  // length is what says whether this position is "part-way" or "the end", and
  // that isn't known until the browser has read the file.
  player.lectureId = entry.id;
  player.resumeTo = Number(entry.resumeAt) || 0;
  player.savedAt = 0;
  // Before the src and before the track: both the notes and the transcript are
  // read through it, and a lecture that opens with the previous one's offset
  // would put every timestamp in the wrong place until you touched something.
  setOffset(Number(entry.captionOffset) || 0, { save: false });
  videoEl.src = `/api/video?key=${encodeURIComponent(entry.key)}`;
  applySubtitles(entry);

  // Offered rather than hidden when Vertex isn't set up: the refusal names what
  // to configure, which is more use than a button that quietly isn't there.
  const explainOff = state.settings.values["explain.enabled"] === false;
  document.getElementById("player-explain").hidden = explainOff;
  document.getElementById("player-explain-open").hidden = explainOff;

  // Same treatment for the same reason: a button that names what to configure
  // is more use than one that quietly isn't there. Whatever was saved for this
  // lecture is fetched now, so the button knows whether it is a build or a play
  // before you press it.
  const reelOff = state.settings.values["highlights.enabled"] === false;
  document.getElementById("player-highlights").hidden = reelOff;
  document.getElementById("player-highlights-open").hidden = reelOff;
  if (!reelOff) loadReel(entry.key);

  // A tab strip is only a tab strip while both tabs exist. With one feature
  // switched off the dock goes back to being the other one, named.
  document.getElementById("dock-tab-explain").hidden = explainOff;
  document.getElementById("dock-tab-highlights").hidden = reelOff;
  dockTab(explainOff && !reelOff ? "highlights" : "explain");
  // The conversation belongs to this lecture from the moment it opens, not from
  // the first question. Set lazily, arming "send the whole lecture" before
  // asking anything looked like a fresh lecture and cleared itself.
  explain.key = entry.key;
}

/**
 * Attach this lecture's transcript to the video as a caption track.
 *
 * Same origin, which is the reason the file is fetched from Panopto and stored
 * rather than linked: a cross-origin <track> needs CORS headers Panopto doesn't
 * send, and fails silently when they're missing.
 */
function applySubtitles(entry) {
  for (const old of [...videoEl.querySelectorAll("track")]) old.remove();

  const cc = document.getElementById("player-cc");
  cc.hidden = !entry.hasCaptions;
  // An offset is a correction *to* a transcript, so without one there is nothing
  // to correct and the box would be a control over nothing.
  document.getElementById("player-offset").hidden = !entry.hasCaptions;
  player.captionsKey = entry.hasCaptions ? entry.key : "";
  if (!entry.hasCaptions) return;

  const track = document.createElement("track");
  track.kind = "captions";
  track.label = "Panopto transcript";
  track.srclang = "en";
  track.src = `/api/subtitles?key=${encodeURIComponent(entry.key)}`;
  // Bound to the element rather than the TextTrack object: the track's cues
  // aren't parsed yet, and addEventListener on textTracks[0] here would attach
  // to something that is replaced when the file loads.
  track.addEventListener("load", () => {
    videoEl.textTracks[0]?.addEventListener("cuechange", paintCues);
    paintCues();
  });
  videoEl.append(track);

  setSubtitles(state.settings.values["player.subtitles"] === true);
}

/**
 * Size the subtitles, as a share of the picture's height.
 *
 * Relative to the video rather than fixed, because the player is resizable: a
 * size chosen against a half-window video is wrong the moment you drag the
 * divider or go full screen. Browsers size their own captions this way for the
 * same reason.
 *
 * 100 is roughly what a browser draws unaided (about 5% of the height); the
 * default of 31 is the "well under half of that" this started out wanting.
 */
function applyCueSize(percent) {
  const size = Math.min(100, Math.max(12, Number(percent) || 31));
  const frame = document.querySelector(".player-frame");
  if (!frame) return;
  const height = frame.getBoundingClientRect().height || 400;
  frame.style.setProperty("--cue-px", `${Math.max(9, Math.round(height * 0.05 * (size / 100)))}px`);
}

/**
 * Put whatever is being said now into our own subtitle element.
 *
 * One <span> per cue rather than one for the block, so each line gets its own
 * box and a two-line cue doesn't come out as one wide ragged slab.
 */
function paintCues() {
  const box = document.getElementById("player-cues");
  const track = videoEl.textTracks[0];
  const active = track ? [...(track.activeCues ?? [])] : [];
  box.replaceChildren(
    // .text keeps WebVTT's own markup; textContent on a span discards it, which
    // is what we want — a stray <v Speaker> tag should not print as characters.
    ...active.map((cue) => el("span", { text: cue.text.replace(/<[^>]+>/g, "").trim() })),
  );
}

/** Bounds and step for the A− / A+ pair. Matches player.subtitleSize's schema. */
const CUE_MIN = 12;
const CUE_MAX = 100;
const CUE_STEP = 3;

function currentCueSize() {
  return Math.min(CUE_MAX, Math.max(CUE_MIN, Number(state.settings.values["player.subtitleSize"]) || 31));
}

function setSubtitles(on) {
  const cc = document.getElementById("player-cc");
  cc.setAttribute("aria-pressed", String(on));
  // "hidden", not "showing": the cues still fire cuechange, which is all we
  // want from the browser — the drawing is ours. Every track, because a lecture
  // only ever has one but a stale one from the previous lecture showing through
  // would be worse than none.
  for (const track of videoEl.textTracks) track.mode = on ? "hidden" : "disabled";

  const box = document.getElementById("player-cues");
  box.hidden = !on;
  if (on) { applyCueSize(currentCueSize()); paintCues(); }
  else box.replaceChildren();

  // The size control only exists while there is something to size. Hidden with
  // the Subtitles chip itself, so a lecture with no transcript shows neither.
  const hide = !on || cc.hidden;
  for (const id of ["player-cc-smaller", "player-cc-bigger"]) {
    document.getElementById(id).hidden = hide;
  }
  refreshCueButtons();
}

/** Titles carry the live value; there is no room in the bar for a readout. */
function refreshCueButtons() {
  const size = currentCueSize();
  const smaller = document.getElementById("player-cc-smaller");
  const bigger = document.getElementById("player-cc-bigger");
  smaller.disabled = size <= CUE_MIN;
  bigger.disabled = size >= CUE_MAX;
  smaller.title = `Smaller subtitles — currently ${size}% of the browser's default`;
  bigger.title = `Bigger subtitles — currently ${size}% of the browser's default`;
}

/**
 * Step the subtitle size, applying it now and saving it shortly after.
 *
 * Applied before the round trip and debounced on the way out: this is a control
 * you press three or four times in a row while looking at the result, and one
 * POST per press would put a queue of writes behind a decision you're still
 * making.
 */
let cueSaveTimer = null;
function stepCueSize(delta) {
  const size = Math.min(CUE_MAX, Math.max(CUE_MIN, currentCueSize() + delta));
  state.settings.values["player.subtitleSize"] = size;
  applyCueSize(size);
  refreshCueButtons();

  clearTimeout(cueSaveTimer);
  cueSaveTimer = setTimeout(
    guard(async () => {
      const result = await post("/api/settings", { values: { "player.subtitleSize": size } });
      state.settings = result.settings;
      renderSettings();
    }),
    500,
  );
}

document.getElementById("player-cc-smaller").addEventListener("click", () => stepCueSize(-CUE_STEP));
document.getElementById("player-cc-bigger").addEventListener("click", () => stepCueSize(CUE_STEP));

// ── Lining the transcript up with the picture ────────────────────────────────

/** Twenty minutes either way. The server clamps to the same number. */
const OFFSET_MAX = 1200;

/**
 * Set how far the file runs ahead of its transcript, and remember it.
 *
 * Applied to the running player immediately and saved without waiting, because
 * this is a control you judge by ear: you nudge it a second, listen to whether
 * the subtitle now matches the mouth, and nudge again. A debounce would make the
 * thing you are listening for arrive after you had moved on.
 *
 * `save: false` is for opening a lecture, where the number came out of the
 * database in the first place and writing it back would be a round trip to say
 * nothing.
 */
function setOffset(seconds, { save = true } = {}) {
  const was = player.offset;
  const raw = Number(seconds);
  const at = Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, Math.round((Number.isFinite(raw) ? raw : 0) * 10) / 10));
  player.offset = at;
  showOffset();
  showClock();
  if (!save) return;

  if (was !== at) {
    // The cues carry times, and a TextTrack the browser has already parsed can't
    // be shifted — so the corrected file has to be fetched again. The Transcript
    // tab is that same file, so it is re-read too when it is the one showing;
    // the notes are unaffected, being in the video's own clock already.
    reloadCaptions();
    if (state.noteTab === "transcript") loadNotes();
    renderReel();
  }

  const id = player.lectureId;
  if (!id) return;
  const entry = state.entries.find((e) => e.id === id);
  if (entry) entry.captionOffset = at;
  post("/api/lectures/offset", { id, seconds: at }).catch(() => {});
}

/** Re-fetch the transcript with the current offset baked into its timings. */
function reloadCaptions() {
  const track = videoEl.querySelector("track");
  if (!track || !player.captionsKey) return;
  const on = document.getElementById("player-cc").getAttribute("aria-pressed") === "true";
  // Cache-busted: the URL is otherwise identical and the browser would reuse
  // what it already has, which is the file shifted by the previous number.
  track.src = `/api/subtitles?key=${encodeURIComponent(player.captionsKey)}&at=${Date.now()}`;
  setSubtitles(on);
}

/** "90", "-4", "1:30" — all reasonable things to type into the box. */
function readOffset(text) {
  const value = text.trim();
  if (value.includes(":")) {
    const sign = value.startsWith("-") ? -1 : 1;
    const parsed = parseClock(value.replace(/^[-+]/, ""));
    return parsed === null ? null : sign * parsed;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The box, and whether it is currently doing anything. */
function showOffset() {
  const label = document.getElementById("player-offset");
  label.classList.toggle("set", Math.abs(player.offset) >= 0.05);

  const box = document.getElementById("align-value");
  // Left alone while it has the caret: overwriting what someone is typing with a
  // rounded version of itself is the classic way to make a box unusable.
  if (document.activeElement !== box) box.value = String(player.offset);
}

// On change rather than on every keystroke: each one re-fetches the transcript,
// and typing "90" would spend a request on "9" along the way.
document.getElementById("align-value").addEventListener("change", (event) => {
  const parsed = readOffset(event.target.value);
  // Unreadable goes back to what it was rather than to zero. Zero is a real
  // setting here, and quietly adopting it would throw away a correction over a
  // typo.
  if (parsed === null) { showOffset(); return; }
  setOffset(parsed);
});

// Enter to apply without leaving the box, since the thing you check afterwards
// is the video rather than anything else on the page.
document.getElementById("align-value").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); event.target.blur(); }
});

// The size is a share of the picture, so it has to be recomputed whenever the
// picture changes shape — dragging the divider, going full screen, resizing the
// window. One observer covers all three.
new ResizeObserver(() => {
  if (player.active) applyCueSize(currentCueSize());
}).observe(document.querySelector(".player-frame"));

function teardownPlayer() {
  // First, while there is still a lecture id and a video to read a position off.
  // Called from setupPlayer too, so this is also what records where you got to
  // in the lecture you are leaving when you open the next one.
  saveProgress(true);
  player.lectureId = null;
  player.resumeTo = 0;
  player.active = false;
  player.groups = [];
  player.current = -1;
  player.pinUntil = 0;
  document.getElementById("drawer-body").dataset.player = "off";
  document.getElementById("drawer-details").hidden = true;
  document.getElementById("drawer-fullscreen").hidden = true;
  document.getElementById("player-cc").hidden = true;
  document.getElementById("player-cc-smaller").hidden = true;
  document.getElementById("player-cc-bigger").hidden = true;
  const cueBox = document.getElementById("player-cues");
  cueBox.hidden = true;
  cueBox.replaceChildren();
  document.getElementById("player-explain").hidden = true;
  document.getElementById("player-explain-open").hidden = true;
  document.getElementById("player-highlights").hidden = true;
  document.getElementById("player-highlights-open").hidden = true;
  document.getElementById("player-pane").hidden = true;

  // The reel goes with the lecture, like the conversation does. The file stays
  // on disk; this is only what's on screen.
  setReelOn(false, { silent: true });
  reel.key = null;
  reel.payload = null;
  reel.index = -1;
  dockTab("explain");

  // The conversation goes with the lecture. It only ever lived here, and it was
  // about where you were in a recording you have now closed.
  explain.history = [];
  explain.key = null;
  explain.whole = false;
  explain.wholeSent = false;
  explainOpen(false);
  hideExplainPop();

  // Otherwise closing the drawer leaves an empty panel filling the screen.
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  notesEl.removeAttribute("data-synced");

  // Pausing isn't enough. A src left in place keeps the request open and the
  // decoder alive behind a closed drawer, and the next lecture would inherit the
  // old one's position while its own file loads.
  videoEl.pause();
  videoEl.removeAttribute("src");
  videoEl.load();
}

videoEl.addEventListener("timeupdate", () => {
  showClock();
  highlightAt(videoEl.currentTime);
  saveProgress();
  followReel();
});

/**
 * The clock under the video: where you are, and how much there is.
 *
 * The file's own clock, which is also the notes' — so a time here can be matched
 * against a timestamp in the notes beside it without arithmetic. When an offset
 * is set, the title gives the transcript's number too, for anyone cross-checking
 * against Panopto's own player.
 *
 * The total is what makes an offset findable in the first place: a recording
 * whose transcript stops four minutes before the picture does is exactly the
 * case this exists for, and you cannot see that from a clock that only counts up.
 */
function showClock() {
  const total = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  const at = videoEl.currentTime;
  const clock = document.getElementById("player-clock");
  clock.textContent = total > 0 ? `${clockText(at)} / ${clockText(total)}` : clockText(at);
  clock.title = player.offset
    ? `Where the recording is. Its transcript calls this ${clockText(toTranscript(at))}, `
      + `being ${clockText(Math.abs(player.offset))} ${player.offset > 0 ? "shorter at the front" : "longer"}.`
    : "Position in the lecture";
}

// ── Where you got to ─────────────────────────────────────────────────────────

/** How often a position is written down while a video plays, in ms. */
const PROGRESS_EVERY = 5000;

/**
 * Pick up where you left off.
 *
 * A permanent listener holding a pending position, rather than a one-shot
 * listener per lecture: a lecture closed before its metadata arrived would leave
 * its handler attached, and the next lecture would then be seeked to the
 * previous one's position.
 *
 * Two positions are deliberately ignored. The first few seconds are a lecture
 * you opened and closed, not one you got into; and a position at the end is a
 * lecture you finished, where what you want is the beginning again.
 */
videoEl.addEventListener("loadedmetadata", () => {
  const at = player.resumeTo;
  player.resumeTo = 0;
  if (!player.active || at < RESUME_MIN) return;
  const length = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  if (length > 0 && at > length - 10) return;

  // Stored and restored in video time: it is a position in the file, and the
  // file is the thing that hasn't changed if the transcript is refetched.
  videoEl.currentTime = at;
  highlightAt(at);
  toast(`Picking up where you left off — ${clockText(at)}.`);
});

/**
 * Write down where you are.
 *
 * Throttled hard while playing, because timeupdate fires four times a second
 * and this is a disk write; forced whenever the video stops, which is where the
 * position that matters usually comes from. Failures are swallowed: losing five
 * seconds of a resume point is not worth interrupting a lecture over.
 *
 * The reply is the server's word on whether that crossed player.watchedAt, so
 * the rule lives in one place and the Library learns the answer rather than
 * working it out a second time.
 */
function saveProgress(force = false) {
  const id = player.lectureId;
  const at = videoEl.currentTime;
  const length = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  if (!id || !(at > 0) || length <= 0) return;
  if (!force && performance.now() - player.savedAt < PROGRESS_EVERY) return;
  player.savedAt = performance.now();

  post("/api/lectures/progress", { id, seconds: at, duration: length })
    .then((result) => {
      const entry = state.entries.find((e) => e.id === id);
      if (!entry) return;
      const was = `${entry.watched}/${partWatched(entry)}`;
      entry.resumeAt = at;
      entry.videoSeconds = length;
      const ticked = result.watched && !entry.watched;
      entry.watched = result.watched;

      // Said out loud, because a box that ticks itself while you are watching is
      // otherwise something you discover later and wonder about.
      if (ticked) toast(`That's ${Math.round(watchFraction(entry) * 100)}% — marked as watched.`);
      // Redrawn only when the box would actually look different. This runs every
      // few seconds while a video plays, and rebuilding the table for a number
      // nobody is looking at is work for nothing.
      if (`${entry.watched}/${partWatched(entry)}` !== was && activeTab() === "panel-library") {
        renderLibrary();
      }
    })
    .catch(() => {});
}

// Pausing is the strongest signal there is that this is the position worth
// keeping — you stopped here. Ending is the other one, and it is what ticks the
// box for a lecture watched to the last second.
videoEl.addEventListener("pause", () => saveProgress(true));
videoEl.addEventListener("ended", () => saveProgress(true));

// Closing the tab or the browser never reaches teardown. keepalive is what lets
// the request outlive the page; sendBeacon can't be used because it cannot set
// the X-UniNotes header the server requires of every mutation.
window.addEventListener("pagehide", () => {
  const id = player.lectureId;
  const length = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
  if (!id || !(videoEl.currentTime > 0) || length <= 0) return;
  fetch("/api/lectures/progress", {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json", "x-uninotes": "1" },
    body: JSON.stringify({ id, seconds: videoEl.currentTime, duration: length }),
  }).catch(() => {});
});
// Fires while the scrubber is being dragged, which is what makes the notes move
// as you scrub rather than only once you let go.
videoEl.addEventListener("seeking", () => highlightAt(videoEl.currentTime));
videoEl.addEventListener("error", () => {
  if (player.active) toast("That video file couldn't be played. Chrome only handles MP4, WebM and MOV.", "bad");
});

// Any scroll that wasn't ours means you've taken over. Listening to `scroll`
// rather than `wheel` covers the scrollbar, the keyboard and a trackpad alike;
// the timestamp is what tells our own scrolling apart from yours.
notesEl.addEventListener("scroll", () => {
  // A tab swap threw the pane back to the top; that is the document changing
  // under you, not you scrolling away from it — and it is certainly not a
  // position worth remembering. A window rather than a flag, so a failed load
  // can't leave following stuck on for the rest of the lecture.
  if (performance.now() - player.reloadAt < 500) return;

  rememberScroll();
  if (!player.active || !player.follow) return;
  // Ours, by position or by the clock. Either alone lets one through: the clock
  // misses a scroll event delayed past its window, and the position alone would
  // ignore a real scroll that happened to land where we last put it.
  if (Math.abs(notesEl.scrollTop - player.autoScrollTo) < 2) return;
  if (performance.now() - player.autoScrollAt < 350) return;
  setFollow(false);
}, { passive: true });

notesEl.addEventListener("click", (event) => {
  if (!player.active || !player.sync) return;
  // A link is a link, and a click that finishes selecting text is a selection.
  if (event.target.closest("a")) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;

  const block = event.target.closest("[data-t]");
  if (block) seekTo(Number(block.dataset.t), Number(block.dataset.g));
});

document.getElementById("player-follow").addEventListener("click", () => {
  setFollow(!player.follow);
  if (player.follow) jumpToNow();
});

document.getElementById("player-cc").addEventListener("click", guard(async () => {
  const on = document.getElementById("player-cc").getAttribute("aria-pressed") !== "true";
  setSubtitles(on);
  const result = await post("/api/settings", { values: { "player.subtitles": on } });
  state.settings = result.settings;
  renderSettings();
}));

document.getElementById("player-sync").addEventListener("click", guard(async () => {
  setSync(!player.sync);
  const result = await post("/api/settings", { values: { "player.sync": player.sync } });
  state.settings = result.settings;
  renderSettings();
}));

/** How far ← and → move the video. Matches player.skipSeconds's schema. */
function skipSeconds() {
  return Math.min(120, Math.max(1, Number(state.settings.values["player.skipSeconds"]) || 15));
}

/**
 * Move the video by a nudge, without disturbing where you are in the notes.
 *
 * Following is deliberately left alone, unlike clicking a note: skipping back
 * fifteen seconds is "say that again", not "take me somewhere else", and if you
 * had scrolled off to read something further down, yanking the pane back is the
 * opposite of what you asked for. The highlight still moves, and Jump to now is
 * one press away.
 */
function skipBy(seconds) {
  const end = Number.isFinite(videoEl.duration) ? videoEl.duration : Infinity;
  videoEl.currentTime = Math.min(end, Math.max(0, videoEl.currentTime + seconds));
}

/**
 * ← and → skip, the way every other player does.
 *
 * On the document rather than the video, because the video only has focus if
 * you clicked it and the thing you were doing before you wanted to skip was
 * reading the notes. Left and right rather than up and down: those still have
 * to scroll the pane.
 *
 * `defaultPrevented` is how the two dividers keep their own use of the same
 * keys — they resize the panes, and being focused is what makes theirs win.
 */
document.addEventListener("keydown", (event) => {
  if (!player.active || event.defaultPrevented) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  if (direction === 0) return;

  // Never take the arrow keys off something you're typing in — the Explain box
  // is right there, and moving the caret is what they're for.
  const focus = document.activeElement;
  if (focus?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(focus?.tagName)) return;

  // Also the browser's own ±5 seconds, which would otherwise land on top of
  // ours whenever the video happens to have focus.
  event.preventDefault();
  skipBy(direction * skipSeconds());
});

/** The keys are invisible, so the clock says what they do. */
function refreshSkipHint() {
  document.getElementById("player-clock").title =
    `← and → skip ${skipSeconds()} seconds — change it in Settings, under Player`;
}

// ── The split ────────────────────────────────────────────────────────────────

/**
 * Dragging the divider between the video and the notes.
 *
 * The default width isn't a share of the window — it's the width the notes
 * already want, so the column holds its reading measure with no empty margins
 * either side and the video gets everything left over. Dragging overrides that
 * with a pixel width; double-clicking gives the fit back.
 */
const splitEl = document.getElementById("pane-split");
/** How little of the window the video may be left with, in px. */
const PANE_MIN = 240;
/**
 * How narrow the notes may be dragged, in px.
 *
 * Well under the reading measure on purpose. The fit was the floor at first, on
 * the reasoning that a column narrower than a comfortable line isn't worth
 * reading — but that is a judgement about reading, and shrinking the notes is
 * usually a decision to stop reading them and watch the slide instead. So the
 * floor is only "still legible", and the fit stays where it belongs: the width
 * you get when you haven't asked for one, and the width double-click gives back.
 */
const NOTES_MIN = 180;
let splitDrag = null;

/**
 * Bounds on the notes column: still legible, and never so wide that the video
 * has nowhere to go.
 */
function clampNotesWidth(px) {
  const body = document.getElementById("drawer-body");
  const total = body.getBoundingClientRect().width;
  const max = Math.max(NOTES_MIN, total - PANE_MIN);
  return Math.round(Math.min(Math.max(px, NOTES_MIN), max));
}

/** `null` drops back to the CSS fallback, which is the bare fit. */
function applyNotesWidth(px) {
  const body = document.getElementById("drawer-body");
  if (px) body.style.setProperty("--notes-width", `${px}px`);
  else body.style.removeProperty("--notes-width");
}

/**
 * The width to use when nothing has been dragged.
 *
 * A readable line at minimum, and about a third of the window wherever there's
 * room for more — so a laptop gets the fit and a wide monitor gets real text
 * without anyone reaching for the divider.
 */
function defaultNotesWidth() {
  const total = document.getElementById("drawer-body").getBoundingClientRect().width;
  return clampNotesWidth(Math.max(player.notesFit, Math.round(total * 0.32)));
}

function currentNotesWidth() {
  return Math.round(document.querySelector(".notes-pane").getBoundingClientRect().width);
}

const saveNotesWidth = guard(async (px) => {
  const result = await post("/api/settings", { values: { "player.notesWidth": px } });
  state.settings = result.settings;
  renderSettings();
});

splitEl.addEventListener("pointerdown", (event) => {
  if (!player.active) return;
  splitDrag = { x: event.clientX, width: currentNotesWidth(), moved: false };
  // Capture keeps the drag alive when the pointer crosses the video, which
  // otherwise swallows the moves. Not fatal if the pointer has already gone.
  try {
    splitEl.setPointerCapture(event.pointerId);
  } catch {
    // Nothing to capture; the move handler still works while over the divider.
  }
  document.getElementById("drawer-body").dataset.dragging = "on";
  // Otherwise the drag starts a text selection in the notes instead.
  event.preventDefault();
});

splitEl.addEventListener("pointermove", (event) => {
  if (!splitDrag) return;
  const dx = event.clientX - splitDrag.x;
  // A press that never moves is a click, not a resize. Without this, brushing the
  // divider pins the current width as a saved setting — and a pinned width stops
  // the column ever sizing itself again.
  if (!splitDrag.moved && Math.abs(dx) < 2) return;
  splitDrag.moved = true;
  // With the notes on the left the divider is to their right, so dragging right
  // grows them; on the right it's the other way round.
  const onLeft = document.getElementById("drawer-body").dataset.side === "left";
  applyNotesWidth(clampNotesWidth(onLeft ? splitDrag.width + dx : splitDrag.width - dx));
});

for (const event of ["pointerup", "pointercancel"]) {
  splitEl.addEventListener(event, () => {
    if (!splitDrag) return;
    const moved = splitDrag.moved;
    splitDrag = null;
    document.getElementById("drawer-body").dataset.dragging = "off";
    if (moved) saveNotesWidth(currentNotesWidth());
  });
}

// Double-click is the way back: a width you dragged by accident shouldn't need a
// trip to Settings to undo.
splitEl.addEventListener("dblclick", () => {
  if (!player.active) return;
  applyNotesWidth(null);
  saveNotesWidth(0);
});

splitEl.addEventListener("keydown", (event) => {
  if (!player.active) return;
  const step = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
  if (step === 0) return;
  event.preventDefault();
  const onLeft = document.getElementById("drawer-body").dataset.side === "left";
  applyNotesWidth(clampNotesWidth(currentNotesWidth() + (onLeft ? step : -step)));
  saveNotesWidth(currentNotesWidth());
});

/**
 * Swap which side the notes are on, from the player rather than from Settings.
 *
 * Which side you want depends on the lecture — slides dense on the left, a
 * lecturer's face on the right — so it belongs next to the video, not two tabs
 * away. It still writes the setting, because a preference you have to re-express
 * every time isn't one.
 */
document.getElementById("player-swap").addEventListener("click", guard(async () => {
  const body = document.getElementById("drawer-body");
  const was = body.dataset.side;
  const side = was === "left" ? "right" : "left";

  // Flipped first: the layout is the feedback, and waiting on a round trip to a
  // local server before moving would just look like a dropped click.
  body.dataset.side = side;
  try {
    const result = await post("/api/settings", { values: { "player.notesSide": side } });
    state.settings = result.settings;
    // Keep the Settings tab honest — it shows the same value, and a control that
    // disagreed with the one you just used would be worse than not having it.
    renderSettings();
  } catch (err) {
    body.dataset.side = was;
    throw err;
  }
}));

// ── Explain ──────────────────────────────────────────────────────────────────

/**
 * Asking about the lecture while you're watching it.
 *
 * The conversation lives here and nowhere else. It is posted with each turn so
 * the server stays stateless — the same shape as everything else in the panel,
 * and no session store to expire — and it is never written to disk: this is a
 * scratch conversation *about* a lecture, not an artefact *of* one. Closing the
 * drawer ends it.
 *
 * Everything sent is assembled server-side from the lecture you have open. The
 * page says where it is; it does not get to say what to send. See
 * src/gui/explain.ts.
 */
const explain = {
  /** [{ role: "user" | "model", text }] — the whole conversation, posted each turn. */
  history: [],
  /** One in flight at a time, so a double-press can't fork the conversation. */
  busy: false,
  /** The lecture the history belongs to, so an unrelated one can't inherit it. */
  key: null,
  /**
   * Send the whole notes file with the next question — armed by the button,
   * spent by the request that uses it.
   *
   * One press, one send, and that is the whole point of it being a button rather
   * than a setting: 25 KB with every question is slow, dear, and buries what you
   * asked about among everything you didn't. A question that genuinely spans the
   * lecture — "how does this connect to the first half?" — needs it once.
   */
  whole: false,
  /** Whether it has been sent in this conversation. Only changes the label. */
  wholeSent: false,
};

const explainDock = document.getElementById("explain-dock");
const explainSplitEl = document.getElementById("explain-split");
const explainLog = document.getElementById("explain-log");
const explainPop = document.getElementById("explain-pop");

function explainOpen(on) {
  explainDock.hidden = !on;
  explainSplitEl.hidden = !on;
  showDockChips();
  if (!on) return;
  applyDockHeight(Number(state.settings.values["explain.dockHeight"]) || 0);
  renderWholeButton();
  if (explain.history.length === 0) renderExplain();
}

/**
 * Armed, spent, or ready to arm.
 *
 * Spent doesn't mean disabled. Each turn is a fresh call and the lecture
 * material rides in the system instruction, which is rebuilt every time — so
 * what a follow-up inherits is the model's *answer*, not the document behind
 * it. Locking the button after one use would leave a conversation that had lost
 * the thing it was about with no way to get it back. One press, one send; press
 * it again when a later question needs the lot again.
 */
function renderWholeButton() {
  const button = document.getElementById("explain-whole");
  button.textContent = explain.whole
    ? "Whole lecture: on for the next question"
    : explain.wholeSent
      ? "Send the whole lecture again"
      : "Send the whole lecture";
  button.title = explain.whole
    ? "Press again to go back to sending just the part you're on"
    : "Include the whole lecture's notes with your next question, this once";
}

function renderExplain() {
  explainLog.replaceChildren();
  if (explain.history.length === 0) {
    explainLog.append(el("p", {
      class: "explain-idle",
      text: "Ask about where you are in the lecture, or highlight a passage in the notes and click Explain this.",
    }));
    return;
  }

  for (const turn of explain.history) {
    if (turn.role === "user") {
      explainLog.append(el("div", { class: "explain-turn you", text: turn.text }));
      continue;
    }
    const answer = el("div", { class: "explain-turn them" });
    answer.append(renderMarkdown(turn.text));
    explainLog.append(answer);
    if (turn.sent) explainLog.append(el("p", { class: "explain-sent", text: turn.sent }));
  }
  explainLog.scrollTop = explainLog.scrollHeight;
}

/** "Sent the pretty notes, the transcript — 2,140 characters." */
function describeSent(context) {
  const parts = [];
  if (context.overview) parts.push("the lecture summary");
  // "in full" goes on the notes, not on the sentence — it's the notes that were
  // sent whole, and the summary and transcript are what they always are.
  if (context.pretty) parts.push(context.whole ? "the pretty notes in full" : "the pretty notes");
  if (context.raw) parts.push(context.whole ? "the raw notes in full" : "the raw notes");
  if (context.subtitles) parts.push("the transcript");
  const what = parts.length === 0 ? "nothing but the lecture title" : parts.join(", ");
  return `Sent ${what} — ${context.chars.toLocaleString()} characters.`;
}

/**
 * Ask one question.
 *
 * The question goes into the log before the request, not after it: with several
 * seconds of round trip, an input box that empties and then does nothing visible
 * reads as a dropped click.
 */
async function askExplain({ question = "", selection = "", at = null } = {}) {
  if (explain.busy || !state.drawerKey) return;
  if (explain.key !== state.drawerKey) {
    explain.history = [];
    explain.key = state.drawerKey;
    explain.whole = false;
    explain.wholeSent = false;
  }

  explainOpen(true);
  // An answer arriving behind the other tab would look like nothing happened.
  dockTab("explain");
  const shown = selection
    ? `Explain this:\n\n${selection}${question ? `\n\n${question}` : ""}`
    : question || "Explain what's being covered here.";
  explain.history.push({ role: "user", text: shown });
  renderExplain();

  explainLog.append(el("p", { class: "explain-idle", text: "Thinking…" }));
  explainLog.scrollTop = explainLog.scrollHeight;

  explain.busy = true;
  document.getElementById("explain-send").disabled = true;
  // Spent on this request whether or not it succeeds is the wrong call — a
  // failed send didn't reach the model, so the arming survives to be used by
  // the retry.
  const whole = explain.whole && !explain.wholeSent;
  try {
    const result = await post("/api/explain", {
      whole,
      key: state.drawerKey,
      // The passage's own place in the lecture when there is one, the video's
      // otherwise. See notesSelection(). The file's clock, like everything else
      // on screen — the server holds this lecture's offset and converts for the
      // one thing that needs it, which is the transcript window.
      atSeconds: Math.floor(at ?? videoEl.currentTime ?? 0),
      question,
      selection,
      // Everything up to but not including the turn just pushed — the server
      // builds that one itself from `question` and `selection`.
      history: explain.history.slice(0, -1).map(({ role, text }) => ({ role, text })),
    });
    // The server's wording of the question, not the placeholder shown while it
    // was thinking — so the history posted with the next turn is exactly the
    // conversation the model had.
    explain.history[explain.history.length - 1].text = result.ask;
    explain.history.push({ role: "model", text: result.answer, sent: describeSent(result.context) });
    if (result.context.whole) { explain.wholeSent = true; explain.whole = false; }
    renderWholeButton();
    renderExplain();
  } catch (err) {
    // The failed question stays in the log with the reason under it: dropping it
    // would leave you re-typing something that might fail for the same reason.
    renderExplain();
    explainLog.append(el("p", { class: "explain-turn bad", text: err.message }));
    explainLog.scrollTop = explainLog.scrollHeight;
  } finally {
    explain.busy = false;
    document.getElementById("explain-send").disabled = false;
  }
}

// Asks about right now, and spends a call doing it.
document.getElementById("player-explain").addEventListener("click", () => askExplain());

document.getElementById("explain-close").addEventListener("click", () => explainOpen(false));

document.getElementById("explain-whole").addEventListener("click", () => {
  explain.whole = !explain.whole;
  renderWholeButton();
  document.getElementById("explain-input").focus();
});

document.getElementById("explain-clear").addEventListener("click", () => {
  explain.history = [];
  // A new conversation hasn't been told anything, so the whole lecture is on
  // offer again.
  explain.whole = false;
  explain.wholeSent = false;
  renderWholeButton();
  renderExplain();
  document.getElementById("explain-input").focus();
});

document.getElementById("explain-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("explain-input");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  askExplain({ question });
});

// ── The selection popover ────────────────────────────────────────────────────

/**
 * The selected text, but only when the whole selection is inside the notes.
 *
 * Also where in the lecture it came from. A passage you highlighted should be
 * explained against the part of the lecture *it* belongs to, not against
 * wherever the video happens to be sitting — you can read ahead, and being told
 * "that isn't covered at this timestamp" about a paragraph you just pointed at
 * is the feature failing. The blocks already carry data-t for click-to-seek, so
 * the answer is right there.
 */
function notesSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!notesEl.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().trim();
  if (text.length <= 1) return null;

  const node = range.startContainer;
  const block = (node.nodeType === 1 ? node : node.parentElement)?.closest("[data-t]");
  return { text, rect: range.getBoundingClientRect(), at: block ? Number(block.dataset.t) : null };
}

/**
 * What the popover will send, captured when it appears rather than when it's
 * clicked.
 *
 * Pressing a button is a mousedown somewhere outside the selection, and that
 * collapses it — so by the time the click handler runs there is often nothing
 * left to read. Holding the text is the difference between the button working
 * and it silently doing nothing.
 */
let popSelection = null;

function hideExplainPop() {
  explainPop.hidden = true;
  popSelection = null;
}

/**
 * Put the button under the end of the selection, nudged back inside the window.
 *
 * Fixed positioning against the viewport rather than the notes column, because
 * the column is a scroll box and an absolutely positioned child of it would be
 * clipped the moment the selection ran near an edge.
 */
function showExplainPop(rect) {
  explainPop.hidden = false;
  const box = explainPop.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - box.width / 2),
    window.innerWidth - box.width - 8,
  );
  // Below by default; above when the selection ends near the bottom of the window.
  const below = rect.bottom + 8;
  const top = below + box.height > window.innerHeight - 8 ? rect.top - box.height - 8 : below;
  explainPop.style.left = `${Math.round(left)}px`;
  explainPop.style.top = `${Math.round(Math.max(8, top))}px`;
}

// mouseup rather than selectionchange: the button should appear when you finish
// selecting, not follow the cursor while you drag through the text.
notesEl.addEventListener("mouseup", () => {
  if (!player.active || state.settings.values["explain.enabled"] === false) return;
  // A frame's grace — at mouseup the selection is not always settled yet.
  setTimeout(() => {
    const found = notesSelection();
    if (!found) { hideExplainPop(); return; }
    popSelection = found;
    showExplainPop(found.rect);
  }, 0);
});

explainPop.addEventListener("click", () => {
  const found = popSelection;
  hideExplainPop();
  if (found) askExplain({ selection: found.text, at: found.at });
});

// Any of these mean the selection is no longer where the button is pointing.
notesEl.addEventListener("scroll", hideExplainPop, { passive: true });
document.addEventListener("selectionchange", () => {
  // Not while the pointer is on the button: pressing it is itself what collapses
  // the selection, and reacting to that would hide the button mid-click.
  if (!explainPop.hidden && !explainPop.matches(":hover") && !notesSelection()) hideExplainPop();
});

// ── Highlights ───────────────────────────────────────────────────────────────

/**
 * The lecture cut down to the parts worth watching.
 *
 * The server holds the judgement: one call scored every span 1–5, and the saved
 * reel comes back already cut three ways. So everything here is presentation and
 * playback — switching preset is picking a different array that arrived with the
 * same response, which is why it costs nothing and works offline.
 */
const reel = {
  /** The lecture `payload` belongs to, so another one can't inherit it. */
  key: null,
  /** { reel, picks: { skim, highlights, deep }, unavailable } or null. */
  payload: null,
  preset: "highlights",
  /** Whether playback is being steered by the reel. */
  on: false,
  /** Index into the current pick's segments, or -1. */
  index: -1,
  /** The preset being cut right now, or false. Named so the panel can say which. */
  busy: false,
  /**
   * Where we last seeked to ourselves.
   *
   * Advancing to the next span *is* a seek, and the handler that watches for you
   * taking over must not read our own jump as yours. Matched by position rather
   * than by a timer: the seeking event can arrive a frame or several later, and
   * a window wide enough to cover that is wide enough to swallow a real one.
   */
  seekTo: -1,
};

const dockEl = document.getElementById("explain-dock");

/** The reel being played, or null when this preset hasn't been built. */
function reelCurrent() {
  return reel.payload?.reels?.[reel.preset] ?? null;
}

function reelSegments() {
  return reelCurrent()?.segments ?? [];
}

/** Has anything at all been built for this lecture? */
function reelAny() {
  return Object.values(reel.payload?.reels ?? {}).some(Boolean);
}

/**
 * Show one of the dock's two tabs.
 *
 * The head actions belong to Explain — "send the whole lecture" means nothing to
 * a reel — so they go with it rather than sitting there greyed out.
 */
function dockTab(which) {
  dockEl.dataset.tab = which;
  for (const [id, name] of [["dock-tab-explain", "explain"], ["dock-tab-highlights", "highlights"]]) {
    const tab = document.getElementById(id);
    tab.classList.toggle("current", name === which);
    tab.setAttribute("aria-selected", String(name === which));
  }
  const onExplain = which === "explain";
  explainLog.hidden = !onExplain;
  document.getElementById("explain-form").hidden = !onExplain;
  document.getElementById("explain-whole").hidden = !onExplain;
  document.getElementById("explain-clear").hidden = !onExplain;
  document.getElementById("reel-list").hidden = onExplain;
  document.getElementById("reel-presets").hidden = onExplain;
  document.getElementById("reel-form").hidden = onExplain;
  showDockChips();
  if (!onExplain) renderReel();
}

/**
 * What the two panel buttons say about the dock.
 *
 * Each reports whether *its* panel is the one showing, not merely that the dock
 * is open — which had the Explain button looking pressed while you were reading
 * the reel. Expanded rather than pressed, because what they do is disclose a
 * panel; pressed belongs to Highlights beside them, which toggles something.
 */
function showDockChips() {
  const tab = dockEl.hidden ? "" : dockEl.dataset.tab;
  for (const [id, name] of [["player-highlights-open", "highlights"], ["player-explain-open", "explain"]]) {
    document.getElementById(id).setAttribute("aria-expanded", String(tab === name));
  }
}

document.getElementById("dock-tab-explain").addEventListener("click", () => dockTab("explain"));
document.getElementById("dock-tab-highlights").addEventListener("click", () => {
  explainOpen(true);
  dockTab("highlights");
});

/**
 * Fetch whatever is saved for this lecture. Free — no model is consulted.
 *
 * Failure is silent by design: a lecture with no reel is the ordinary case, and
 * the panel says what to do about it when you open it.
 */
async function loadReel(key) {
  reel.key = key;
  reel.payload = null;
  try {
    reel.payload = await get(`/api/highlights?key=${encodeURIComponent(key)}`);
  } catch {
    reel.payload = null;
  }
  if (reel.key !== key) return;
  renderReel();
}

/**
 * The three buttons: what each one costs to watch, and whether it exists yet.
 *
 * Once built, a preset shows its real run time and switching to it is free.
 * Before that it shows the share it aims for and a dot saying it hasn't been
 * made — pressing it is what spends the call, which is why the state has to be
 * legible before you press.
 */
function reelLengths() {
  for (const button of document.querySelectorAll(".reel-preset")) {
    const name = button.dataset.reel;
    const preset = reel.payload?.presets?.[name];
    const built = reel.payload?.reels?.[name] ?? null;
    button.querySelector(".reel-len").textContent = built
      ? `${clockText(built.seconds)} · ${built.segments.length}`
      : preset ? `build · ${preset.share}%` : "—";
    button.setAttribute("aria-pressed", String(name === reel.preset));
    button.classList.toggle("unbuilt", !built);
    button.title = built
      ? `${built.segments.length} spans, ${clockText(built.seconds)} — already built, free to switch to`
      : preset
        ? `Not built yet. One call, aiming for around ${preset.minSpans} cuts of `
          + `${preset.minSeconds}–${preset.maxSeconds} seconds — about ${preset.share}% of the lecture.`
        : "";
    // Boolean(), because `busy` holds the preset being built rather than a flag
    // — the panel says which one it is cutting.
    button.disabled = Boolean(reel.busy);
  }
}

function renderReel() {
  reelLengths();
  const list = document.getElementById("reel-list");
  const form = document.getElementById("reel-form");
  const saved = reelCurrent();

  if (reel.busy) {
    list.replaceChildren(el("p", {
      class: "explain-idle",
      text: `Cutting the ${reel.busy} reel — a minute or so, and you can carry on watching.`,
    }));
    form.hidden = true;
    return;
  }
  form.hidden = dockEl.dataset.tab !== "highlights";
  // Named, because with three reels "Rebuild" alone doesn't say which one it
  // would throw away and spend a call replacing.
  document.getElementById("reel-build").textContent = saved ? `Rebuild ${reel.preset}` : `Build ${reel.preset}`;

  if (!saved) {
    list.replaceChildren(el("p", {
      class: "explain-idle",
      text: reel.payload?.unavailable
        || (reelAny()
          ? `No ${reel.preset} reel yet. Press it again, or Build, to cut one — each of the three `
            + "is its own pass, built for its own length."
          : "Pick how much of the lecture you want and press it. Skim cuts many very short "
            + "moments, Deep gives each point room to finish; each is one call, and once built "
            + "it's saved and free to come back to."),
    }));
    return;
  }

  const playingAt = reelSegments()[reel.index]?.start;
  const nodes = saved.segments.map((segment) => {
    const item = el("button", { class: "reel-item", type: "button" });
    if (segment.start === playingAt) item.classList.add("on");
    item.append(
      // Shown in the video's clock, not the transcript's, so a span's time reads
      // the same as the timestamps in the notes beside it and as the clock under
      // the picture. Only the stored number is transcript time.
      el("span", { class: "ts", text: clockText(toVideo(segment.start)) }),
      el("span", { class: "reel-text", text: segment.why }),
      el("span", { class: "reel-weight", text: `${Math.round(segment.end - segment.start)}s` }),
    );
    item.title = `${clockText(toVideo(segment.start))}–${clockText(toVideo(segment.end))} · scored ${segment.weight}/5`;
    item.addEventListener("click", () => playSegment(segment));
    return item;
  });

  const made = saved.madeAt ? new Date(saved.madeAt) : null;
  nodes.push(el("p", {
    class: "explain-sent",
    text: `${saved.segments.length} spans · ${clockText(saved.seconds)} of `
      + `${clockText(saved.lectureSeconds)} · ${saved.model}`
      + (made && !Number.isNaN(made.getTime()) ? ` on ${made.toLocaleDateString()}` : "")
      + (saved.steer ? ` · asked for: ${saved.steer}` : ""),
  }));
  list.replaceChildren(...nodes);
}

/**
 * Our own seek, marked as ours so it isn't read as you taking over.
 *
 * Spans are notes time; the playhead is video time. `seekTo` stays in notes time
 * so the "was this us?" test below compares two numbers in the same frame.
 */
function reelSeek(seconds) {
  reel.seekTo = seconds;
  videoEl.currentTime = toVideo(seconds);
}

/**
 * Move the "playing now" marker.
 *
 * The panel's list is the only place this shows, so it is only redrawn when the
 * panel is actually on screen — this fires at every span boundary, and rebuilding
 * a list nobody is looking at is work for nothing.
 */
function setReelIndex(index) {
  reel.index = index;
  if (dockEl.dataset.tab === "highlights" && !dockEl.hidden) renderReel();
}

/**
 * Jump to one span from the list or the bar.
 *
 * A span this preset dropped is still a real place in the lecture, so clicking
 * it goes there — and stops the steering, because leaving the reel to yank you
 * onwards at the end of a span you deliberately left is the reel fighting you.
 *
 * Either way the video isn't started. A paused lecture stays paused, the same as
 * clicking a note does.
 */
function playSegment(segment) {
  const index = reelSegments().findIndex((s) => s.start === segment.start);
  if (index < 0) {
    setReelOn(false, { silent: true });
    videoEl.currentTime = toVideo(segment.start);
    return;
  }
  setReelOn(true, { silent: true, at: index });
}

/**
 * Turn the reel's steering on or off.
 *
 * Turning it on lands you in the nearest span rather than starting again from
 * the top: you pressed it part-way through a lecture, and being thrown back to
 * the beginning is not what "play the good bits" means. Playback state is left
 * alone — a paused video stays paused.
 */
function setReelOn(on, { silent = false, at = -1 } = {}) {
  const segments = reelSegments();
  if (on && segments.length === 0) return;
  const was = reel.on;
  reel.on = on;
  // Lit in the bar whether or not the panel is open: this is the state that
  // explains why the video keeps jumping, and it has to read from wherever you
  // are. Pressed rather than a class of its own — the button is a toggle again,
  // and this is what it is a toggle of.
  document.getElementById("player-highlights").setAttribute("aria-pressed", String(on));

  if (!on) {
    reel.index = -1;
    if (dockEl.dataset.tab === "highlights" && !dockEl.hidden) renderReel();
    if (was && !silent) toast("Highlights off — playing the whole lecture again.");
    return;
  }

  // Already steering and nowhere particular to go: leave it where it is.
  if (was && at < 0) return;

  const t = toTranscript(videoEl.currentTime);
  const inside = segments.findIndex((s) => t >= s.start && t < s.end);
  const next = segments.findIndex((s) => s.start > t);
  const index = at >= 0 ? at : inside >= 0 ? inside : next >= 0 ? next : 0;
  setReelIndex(index);
  // Only when you aren't already inside it: turning the reel on part-way through
  // a good span shouldn't restart the span you're listening to.
  if (at >= 0 || inside < 0) reelSeek(segments[index].start);
  if (dockEl.dataset.tab === "highlights" && !dockEl.hidden) renderReel();
}

/**
 * Move the video along the reel as each span finishes.
 *
 * Driven by timeupdate rather than by a timer, so it survives pausing, scrubbing
 * and a video that buffers — the only thing that advances it is the picture
 * actually reaching the end of a span.
 */
function followReel() {
  if (!reel.on) return;
  const saved = reelCurrent();
  const segments = saved?.segments ?? [];
  const current = segments[reel.index];
  if (!current) return;
  if (toTranscript(videoEl.currentTime) < current.end) return;

  if (reel.index + 1 >= segments.length) {
    // The end of the reel is the end of watching, not a jump back to the top.
    videoEl.pause();
    setReelOn(false, { silent: true });
    toast(`That's the reel — ${clockText(saved.seconds)} of ${clockText(saved.lectureSeconds)}.`);
    return;
  }
  setReelIndex(reel.index + 1);
  reelSeek(segments[reel.index].start);
}

/**
 * A seek that wasn't ours means you've taken over — sometimes.
 *
 * Landing inside a span you're already watching is a nudge within the reel, not
 * a departure from it: the arrow keys exist for exactly that, and killing the
 * reel because you skipped fifteen seconds of a slow explanation would make the
 * two features fight. Landing in the middle of what the reel skipped is the real
 * signal, and that turns the steering off.
 */
videoEl.addEventListener("seeking", () => {
  if (!reel.on) return;
  const t = toTranscript(videoEl.currentTime);
  if (Math.abs(t - reel.seekTo) < 0.75) return;
  reel.seekTo = -1;

  const inside = reelSegments().findIndex((s) => t >= s.start && t < s.end);
  if (inside >= 0) { setReelIndex(inside); return; }
  setReelOn(false);
});

/**
 * Build a reel. The one thing here that spends a call.
 *
 * Fired and left to run: at thinking level high over a whole transcript this is
 * the better part of a minute, and blocking the player for it would be absurd
 * when the thing you'd be blocking is a lecture you can watch meanwhile.
 */
const buildReel = guard(async (preset, steer = "") => {
  if (reel.busy || !state.drawerKey) return;
  const key = state.drawerKey;
  reel.busy = preset;
  reel.preset = preset;
  renderReel();
  toast(`Cutting the ${preset} reel — a minute or so. Carry on watching.`);

  try {
    const payload = await post("/api/highlights/build", { key, preset, steer });
    // The drawer may have moved on while it was thinking. The file is saved
    // either way, so the work isn't lost — it just isn't what's on screen.
    if (state.drawerKey !== key) return;
    reel.payload = payload;
    reel.index = -1;
    const built = payload.reels[preset];
    toast(`${preset[0].toUpperCase()}${preset.slice(1)} ready — ${built.segments.length} cuts, ${clockText(built.seconds)}.`);
    explainOpen(true);
    dockTab("highlights");
  } finally {
    reel.busy = false;
    if (state.drawerKey === key) renderReel();
  }
});

/**
 * The player bar's Highlights button: play the reel, or stop.
 *
 * The panel is the button beside it, so this one has a single job. With nothing
 * built there is no reel to steer, and it opens the panel instead — the choice
 * of which reel to cut is the only thing that could happen next, and it lives
 * there.
 */
document.getElementById("player-highlights").addEventListener("click", () => {
  if (reel.busy) return;
  if (!reelCurrent()) {
    if (reel.payload?.unavailable) { toast(reel.payload.unavailable, "bad"); return; }
    explainOpen(true);
    dockTab("highlights");
    return;
  }
  setReelOn(!reel.on);
});

/**
 * The two panel buttons, one per feature, sharing an icon.
 *
 * Each toggles the dock onto its own panel, and closes it when that panel is
 * already the one showing. Same gesture, same glyph; which panel it means is
 * said by the group it sits in rather than by a different picture.
 */
function panelButton(id, tab, onOpen) {
  document.getElementById(id).addEventListener("click", () => {
    if (!dockEl.hidden && dockEl.dataset.tab === tab) { explainOpen(false); return; }
    explainOpen(true);
    dockTab(tab);
    if (onOpen) onOpen();
  });
}

panelButton("player-highlights-open", "highlights");
// Opening Explain deliberately puts the caret in the box: you opened it to type
// a question, since the button that asks one without typing is right beside it.
panelButton("player-explain-open", "explain", () => document.getElementById("explain-input").focus());

/**
 * The three buttons: switch to a reel, or cut one if it doesn't exist yet.
 *
 * Pressing a preset that has already been built is free and instant — it is a
 * saved file. Pressing one that hasn't spends a call, on that preset alone. The
 * button says which it is about to do before you press it.
 */
document.getElementById("reel-presets").addEventListener("click", (event) => {
  const button = event.target.closest(".reel-preset");
  if (!button || reel.busy) return;
  const preset = button.dataset.reel;

  if (!reel.payload?.reels?.[preset]) {
    if (reel.payload?.unavailable) { toast(reel.payload.unavailable, "bad"); return; }
    buildReel(preset, document.getElementById("reel-input").value.trim());
    document.getElementById("reel-input").value = "";
    return;
  }

  reel.preset = preset;
  // Re-landed rather than left where it was: this is a different set of spans,
  // and the index is a position in *this* list.
  const t = toTranscript(videoEl.currentTime);
  const segments = reelSegments();
  const inside = segments.findIndex((s) => t >= s.start && t < s.end);
  reel.index = reel.on ? (inside >= 0 ? inside : Math.max(0, segments.findIndex((s) => s.start > t))) : -1;
  renderReel();
});

// Rebuilds whichever preset is selected, which is the only way to replace a reel
// you already have — a preset button on its own never spends a second call.
document.getElementById("reel-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("reel-input");
  const steer = input.value.trim();
  input.value = "";
  buildReel(reel.preset, steer);
});

// ── The dock's height ────────────────────────────────────────────────────────

/** How little of the video pane the dock may leave the picture, in px. */
const DOCK_FRAME_MIN = 140;
const DOCK_MIN = 128;

function clampDockHeight(px) {
  const pane = document.getElementById("player-pane").getBoundingClientRect().height;
  const max = Math.max(DOCK_MIN, pane - DOCK_FRAME_MIN);
  return Math.round(Math.min(Math.max(px, DOCK_MIN), max));
}

/** `0` drops back to the CSS fallback, which is a share of the pane. */
function applyDockHeight(px) {
  if (px) explainDock.style.setProperty("--explain-height", `${clampDockHeight(px)}px`);
  else explainDock.style.removeProperty("--explain-height");
}

const saveDockHeight = guard(async (px) => {
  const result = await post("/api/settings", { values: { "explain.dockHeight": px } });
  state.settings = result.settings;
  renderSettings();
});

let dockDrag = null;

explainSplitEl.addEventListener("pointerdown", (event) => {
  dockDrag = { y: event.clientY, height: explainDock.getBoundingClientRect().height, moved: false };
  explainSplitEl.setPointerCapture(event.pointerId);
  document.getElementById("drawer-body").dataset.dragging = "rows";
  event.preventDefault();
});

explainSplitEl.addEventListener("pointermove", (event) => {
  if (!dockDrag) return;
  const dy = event.clientY - dockDrag.y;
  // Same guard as the vertical divider: a plain click must not persist a height.
  if (!dockDrag.moved && Math.abs(dy) < 2) return;
  dockDrag.moved = true;
  // The divider sits above the dock, so dragging up grows it.
  applyDockHeight(clampDockHeight(dockDrag.height - dy));
});

for (const event of ["pointerup", "pointercancel"]) {
  explainSplitEl.addEventListener(event, () => {
    if (!dockDrag) return;
    const moved = dockDrag.moved;
    dockDrag = null;
    document.getElementById("drawer-body").dataset.dragging = "off";
    if (moved) saveDockHeight(Math.round(explainDock.getBoundingClientRect().height));
  });
}

explainSplitEl.addEventListener("dblclick", () => {
  applyDockHeight(0);
  saveDockHeight(0);
});

explainSplitEl.addEventListener("keydown", (event) => {
  const step = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0;
  if (step === 0) return;
  event.preventDefault();
  const next = clampDockHeight(explainDock.getBoundingClientRect().height + step);
  applyDockHeight(next);
  saveDockHeight(next);
});

/**
 * Full screen for the panel, not for the video.
 *
 * The video element has its own fullscreen button and that one loses the notes,
 * which is the opposite of what this view is for. This one takes the whole panel,
 * so you lose the browser and the desktop and keep the two things you're using.
 */
const fullscreenBtn = document.getElementById("drawer-fullscreen");

fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  document.querySelector(".drawer-panel").requestFullscreen().catch(() => {
    toast("The browser wouldn't allow full screen here.", "bad");
  });
});

// Driven by the event, not by the click: Escape and the browser's own controls
// leave full screen too, and the label has to follow those as well.
document.addEventListener("fullscreenchange", () => {
  const on = Boolean(document.fullscreenElement);
  fullscreenBtn.dataset.on = String(on);
  fullscreenBtn.querySelector(".head-btn-label").textContent = on ? "Exit full screen" : "Full screen";
  // The panes changed size, so a column sized to the old window may now be out
  // of bounds — and after exiting, the notes should get their share back.
  if (player.active) applyNotesWidth(clampNotesWidth(currentNotesWidth()));
  if (player.active) handOverCues();
});

/**
 * Give the subtitles back to the browser while the video alone is full screen.
 *
 * Our subtitle element lives in the page, so it isn't painted when the video
 * element is the fullscreen element — the picture covers it. That path is the
 * video's own control rather than ours, but coming out of it with no subtitles
 * at all would be worse than the browser's, so hand them over and take them
 * back on the way out.
 */
function handOverCues() {
  const on = document.getElementById("player-cc").getAttribute("aria-pressed") === "true";
  if (!on) return;
  const theirs = document.fullscreenElement === videoEl;
  for (const track of videoEl.textTracks) track.mode = theirs ? "showing" : "hidden";
  document.getElementById("player-cues").hidden = theirs;
  if (!theirs) paintCues();
}

document.getElementById("drawer-details").addEventListener("click", () => {
  const drawer = document.getElementById("drawer");
  const showing = drawer.dataset.details === "on";
  drawer.dataset.details = showing ? "off" : "on";
  document.getElementById("drawer-details").querySelector(".head-btn-label").textContent =
    showing ? "Details" : "Hide details";
});

// ── Theme ────────────────────────────────────────────────────────────────────

/**
 * Light/dark, remembered locally.
 *
 * A browser preference rather than a tool setting, so it lives in localStorage
 * and never reaches settings.json: which theme suits the room you're in is not a
 * fact about your notes pipeline. With nothing stored, the system preference
 * applies — the stylesheet already handles that on its own.
 */
// ── Stopping the server ──────────────────────────────────────────────────────

/**
 * Put the page into its final state.
 *
 * Nothing here will work again — there's no server to answer — so the page says
 * that plainly and dims itself rather than leaving controls that look live. The
 * stream is closed by hand too, or EventSource would spend the rest of the
 * afternoon reconnecting to a port with nothing behind it.
 */
function markStopped() {
  state.stopped = true;
  if (eventSource) eventSource.close();
  document.getElementById("state-dot").className = "dot";
  document.getElementById("state-text").textContent = "Stopped";
  document.getElementById("state-meta").textContent =
    "the control panel is no longer running — start it again with npm run gui";
  document.body.classList.add("is-stopped");
}

document.getElementById("shutdown").addEventListener("click", guard(async () => {
  if (!confirm(
    "Stop UniNotes?\n\n" +
    "The server exits and this page stops working. You'll need a terminal to start it again.",
  )) return;

  try {
    await post("/api/shutdown");
  } catch (err) {
    // 409 is the server declining to orphan a job's process tree. Only that one
    // is worth a second ask; anything else is a real failure and should surface.
    if (!/job is still running/i.test(err.message)) throw err;
    if (!confirm(
      "A job is still running.\n\n" +
      "Stopping now cancels it, along with the ffmpeg and browser processes it started. " +
      "Parts already finished stay checkpointed and get reused on the next run.\n\n" +
      "Stop anyway?",
    )) return;
    await post("/api/shutdown", { force: true });
  }

  markStopped();
}));

const THEME_KEY = "uninotes-theme";
const themeToggle = document.getElementById("theme-toggle");

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function isDark() {
  const set = document.documentElement.dataset.theme;
  return set ? set === "dark" : systemPrefersDark();
}

function refreshThemeToggle() {
  themeToggle.title = isDark() ? "Switch to light mode" : "Switch to dark mode";
}

themeToggle.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage blocked. The theme still applies for this page.
  }
  refreshThemeToggle();
});

// Follows the system while nothing has been chosen, so the tooltip stays honest.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshThemeToggle);
refreshThemeToggle();

// ── Settings ─────────────────────────────────────────────────────────────────

function currentValue(path) {
  return path in state.draft ? state.draft[path] : state.settings.values[path];
}

function setDraft(path, value) {
  // Structural comparison for the term list — it's an array, so === would call
  // an untouched list a change and leave the save bar showing forever.
  const same = typeof value === "object" && value !== null
    ? JSON.stringify(value) === JSON.stringify(state.settings.values[path])
    : value === state.settings.values[path];

  if (same) delete state.draft[path];
  else state.draft[path] = value;

  renderSettings();
  schedulePreview();
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
    // Collapsed until you open it. Eleven groups of settings is a wall to scroll
    // past when you came here to change one thing, and the group names are the
    // index — a group with an unsaved change opens itself, because a change you
    // can't see is worse than a long page.
    const dirtyHere = group.fields.some((f) => f.path in state.draft);
    const open = state.settingsOpen.has(group.name) || dirtyHere;
    const section = el("section", { class: `set-group${open ? " open" : ""}` });

    const head = el("div", { class: "set-group-head" });
    const toggle = el("button", { class: "set-group-toggle" });
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.innerHTML =
      '<svg class="set-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6 4l4 4-4 4"/></svg>';
    toggle.append(el("span", { text: group.name }));
    toggle.addEventListener("click", () => {
      if (state.settingsOpen.has(group.name)) state.settingsOpen.delete(group.name);
      else state.settingsOpen.add(group.name);
      renderSettings();
    });
    head.append(toggle);

    // Reset lives on the group, not on each setting. Putting one group back is
    // the thing you actually want when you've been experimenting, and it is a
    // far smaller commitment than the page-wide reset at the bottom.
    const reset = el("button", {
      class: "link-btn",
      text: "Reset",
      title: `Put every setting under ${group.name} back to its default`,
    });
    reset.addEventListener("click", guard(async () => {
      const result = await post("/api/settings/reset", { group: group.name });
      // Drafts for this group would otherwise re-apply the values you just
      // dropped the moment you saved.
      for (const field of group.fields) delete state.draft[field.path];
      state.settings = result.settings;
      toast(result.message);
      renderSettings();
      schedulePreview();
    }));
    head.append(reset);
    section.append(head);

    if (!open) return section;

    const list = el("div", { class: "set-list" });
    group.fields.forEach((field) => list.append(renderSetting(field)));
    section.append(list);
    // Attached to Naming rather than sitting at the end of the page: two
    // free-text templates are only safe to offer beside the thing that shows
    // what they do, and scrolling away to check defeats the point.
    if (group.name === "Naming") section.append(renderPreview());
    return section;
  }));

  // Here because this is the one place every settings load and save passes
  // through, and the size has to reach a player that may already be open —
  // including its own A− / A+, which would otherwise go stale when the size is
  // changed from this form instead.
  applyCueSize(state.settings.values["player.subtitleSize"]);
  refreshCueButtons();
  refreshSkipHint();

  const changed = Object.keys(state.draft);
  document.getElementById("settings-bar").hidden = changed.length === 0;
  document.getElementById("settings-changed").textContent =
    changed.length === 1 ? "1 unsaved change" : `${changed.length} unsaved changes`;
}

function renderSetting(field) {
  // A setting whose feature is switched off is shown but not editable — leaving
  // it live invites you to configure something that isn't going to happen.
  const inactive = field.dependsOn !== undefined && currentValue(field.dependsOn) === false;
  // The term list is a table of controls, not a value — it needs the label
  // column's width as well as its own.
  const wide = field.type === "terms" ? " set-wide" : "";
  const wrap = el("div", { class: `set${inactive ? " set-off" : ""}${wide}` });
  const dirty = field.path in state.draft;

  // "unsaved" only. A per-setting "changed from default" badge marked most of
  // the page once anything was configured, which made it noise rather than
  // information — and what you actually want from it, putting a group back, is
  // now the Reset link on the group's own heading.
  const name = el("div", { class: "set-name", text: field.label });
  if (dirty) name.append(el("span", { class: "changed", text: "unsaved" }));
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
  } else if (field.type === "terms") {
    control.append(renderTermEditor(field, value));
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

// ── Terms ────────────────────────────────────────────────────────────────────

const MS_DAY = 86400000;

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Date(date.getTime() + days * MS_DAY).toISOString().slice(0, 10);
}

/**
 * A term to start editing from.
 *
 * Guesses the next one along rather than opening blank: a second semester
 * usually starts around five months after the first and runs the same shape, so
 * pre-filling turns "set up 2026 S1, then S2, then 2027 S1" into three clicks
 * and three corrections instead of fifteen fields. Every value is editable —
 * the guess only has to be closer than empty.
 */
function nextTerm(existing) {
  const previous = existing[existing.length - 1];
  if (!previous) {
    const year = new Date().getFullYear();
    return {
      id: `term-${Date.now()}`,
      label: `${year} Semester 1`,
      folder: "",
      start: `${year}-03-02`,
      weeks: 12,
      break: { afterWeek: 6, weeks: 2 },
    };
  }

  const bumpedYear = /^(\d{4})/.exec(previous.label);
  const isSecond = /2\b/.test(previous.label);
  const label = bumpedYear
    ? isSecond
      ? `${Number(bumpedYear[1]) + 1} Semester 1`
      : previous.label.replace(/1\b/, "2")
    : `${previous.label} (copy)`;

  return {
    ...previous,
    id: `term-${Date.now()}`,
    label,
    // The term you're adding is the one you're moving into, so the one before it
    // becomes the archive — but only if it isn't already filed somewhere.
    folder: "",
    start: addDays(previous.start, isSecond ? 224 : 140),
    break: previous.break ? { ...previous.break } : null,
  };
}

function renderTermEditor(field, rawValue) {
  const terms = Array.isArray(rawValue) ? rawValue : [];
  const host = el("div", { class: "terms" });

  const commit = (next) => setDraft(field.path, next);

  const update = (index, patch) => {
    const next = terms.map((t, i) => (i === index ? { ...t, ...patch } : t));
    commit(next);
  };

  if (terms.length === 0) {
    host.append(el("p", {
      class: "terms-empty",
      text: "No terms yet. Add one and lectures start sorting into weeks.",
    }));
  }

  terms.forEach((term, index) => {
    const row = el("div", { class: "term" });

    const line = el("div", { class: "term-line" });
    line.append(
      termField("Name", "text", term.label, "2026 Semester 2", (v) => update(index, { label: v }), "term-name"),
      termField("Folder", "text", term.folder, "blank for current", (v) => update(index, { folder: v }), "term-folder"),
      termField("Week 1 starts", "date", term.start, "", (v) => update(index, { start: v }), "term-date"),
      termField("Weeks", "number", term.weeks, "", (v) => update(index, { weeks: Number(v) || 1 }), "term-weeks"),
    );

    const remove = el("button", { class: "link-btn danger", text: "Remove" });
    remove.addEventListener("click", () => commit(terms.filter((_, i) => i !== index)));
    line.append(remove);
    row.append(line);

    // Second line, because a break is a qualifier on the term above rather than
    // another field of equal weight — and most of the time it's left alone.
    const breakLine = el("div", { class: "term-line term-break" });
    const has = term.break !== null && term.break !== undefined;

    const toggle = el("label", { class: "check" });
    const box = el("input");
    box.type = "checkbox";
    box.checked = has;
    box.addEventListener("change", () => {
      update(index, { break: box.checked ? { afterWeek: Math.ceil((term.weeks || 12) / 2), weeks: 2 } : null });
    });
    toggle.append(box, document.createTextNode(" mid-term break"));
    breakLine.append(toggle);

    if (has) {
      breakLine.append(
        el("span", { class: "term-label", text: "after week" }),
        termNumber(term.break.afterWeek, (v) => update(index, { break: { ...term.break, afterWeek: v } })),
        el("span", { class: "term-label", text: "lasting" }),
        termNumber(term.break.weeks, (v) => update(index, { break: { ...term.break, weeks: v } })),
        el("span", { class: "term-label", text: "week(s)" }),
      );
    }
    row.append(breakLine);

    const problem = (state.termProblems ?? []).find((p) => p.termId === term.id);
    if (problem) row.append(el("div", { class: "term-problem", text: problem.message }));

    host.append(row);
  });

  const add = el("button", { class: "btn", text: "Add term" });
  add.addEventListener("click", () => commit([...terms, nextTerm(terms)]));
  host.append(add);

  return host;
}

function termField(label, type, value, placeholder, onChange, className) {
  const wrap = el("label", { class: `term-field ${className}` });
  wrap.append(el("span", { class: "term-label", text: label }));
  const input = el("input", { class: "field" });
  input.type = type;
  input.value = value ?? "";
  if (placeholder) input.placeholder = placeholder;
  if (type === "number") input.min = 1;
  input.addEventListener("change", () => onChange(input.value));
  wrap.append(input);
  return wrap;
}

function termNumber(value, onChange) {
  const input = el("input", { class: "field term-num" });
  input.type = "number";
  input.min = 1;
  input.value = value ?? 1;
  input.addEventListener("change", () => onChange(Number(input.value) || 1));
  return input;
}

// ── Naming preview ───────────────────────────────────────────────────────────

/**
 * Ask the server where real lectures would land under the current form values.
 *
 * Server-side because the answer must come from the code that does the writing.
 * Debounced: this fires on every keystroke in a template box, and the answer is
 * only worth having once you've stopped typing.
 */
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { refreshPreview(); }, 250);
}

const refreshPreview = guard(async () => {
  const values = { ...state.settings.values, ...state.draft };
  const data = await post("/api/naming/preview", { values });
  state.preview = data.samples ?? [];
  state.termProblems = data.problems ?? [];
  // Redrawn rather than patched in place: the term rows need their validation
  // messages from the same response, and they live elsewhere in the form.
  renderSettings();
});

/** The "where would this go" panel, drawn from the last preview response. */
function renderPreview() {
  const host = el("div", { class: "preview" });
  host.append(el("div", { class: "preview-caption", text: "Where these would go" }));

  if (state.preview === null) {
    host.append(el("p", { class: "console-idle", text: "Working it out…" }));
    return host;
  }
  if (state.preview.length === 0) {
    host.append(el("p", { class: "console-idle", text: "No lectures yet to preview against." }));
    return host;
  }

  for (const sample of state.preview) {
    const block = el("div", { class: "preview-item" });

    block.append(el("div", { class: "preview-title", text: sample.title }));
    block.append(el("div", {
      class: sample.date ? "preview-meta" : "preview-meta none",
      text: sample.date
        ? `${sample.date} · from ${sample.dateSource}` +
          (sample.week ? ` · ${sample.termLabel}, week ${sample.week}` : " · outside every term")
        : "no date found — the week folder is left out",
    }));

    for (const entry of sample.paths) {
      const line = el("div", { class: "preview-path" });
      line.append(el("span", { class: "preview-root", text: `${entry.name}: ` }));
      line.append(el("span", { text: entry.path }));
      block.append(line);
    }

    host.append(block);
  }

  return host;
}

document.getElementById("settings-save").addEventListener("click", guard(async () => {
  const result = await post("/api/settings", { values: state.draft });
  state.settings = result.settings;
  state.draft = {};
  renderSettings();
  toast(result.message);
  refreshPreview();
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
  refreshPreview();
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

// Scoped to this tab. A bare [data-preset] once reached across the whole page
// and bound the player's reel buttons too, so choosing Skim also tried to
// schedule a pipeline run at "sk:im".
document.querySelectorAll("#panel-schedule [data-preset]").forEach((button) => {
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
    // Ranges before single stamps: the single pattern wants the closing bracket
    // straight after the time, so "[00:00 - 02:34]" would go untagged — and a
    // range is exactly what the model reaches for to open a section, which is
    // the block you most want to be able to jump to.
    .replace(
      /\[(\d{1,2}:[0-5]\d(?::[0-5]\d)?\s*[-–—]\s*\d{1,2}:[0-5]\d(?::[0-5]\d)?)\]/g,
      '<span class="ts">[$1]</span>',
    )
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

/**
 * "2026-07-28" → "Tue 28 Jul". Null if there isn't a date to show.
 *
 * Built from the parts rather than handed to `new Date(iso)`, which reads a bare
 * date as UTC: west of Greenwich that renders as the day before, which on a
 * Monday lecture is last week.
 *
 * The weekday earns its place — lectures recur on the same day, so "Tue" is how
 * you recognise which of a course's two slots this one is. The year appears only
 * when it isn't the current one, since a column of "2026" repeated forty times
 * says nothing.
 */
function formatLectureDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
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
  refreshPreview();

  // Counts change from outside the panel too — a scheduled run, a video dropped
  // into Incoming/ — so poll rather than only refreshing after our own actions.
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 5000);
});

boot();
