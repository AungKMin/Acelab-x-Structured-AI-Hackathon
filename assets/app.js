/* AEC Hackathon grader UI */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const state = {
    team: null, // { name, code }
    activeRun: null, // { id, token }
    pollTimer: null,
    lbTimer: null,
  };

  // ---------- utilities ----------

  async function api(path, opts = {}) {
    const resp = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...opts,
    });
    const data = await resp.json().catch(() => ({ error: "Bad response from server." }));
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    return data;
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $("#toast");
    el.textContent = message;
    el.className = `toast${isError ? " err" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
  }

  const fmt = {
    f1: (v) => (v === null || v === undefined ? "—" : v.toFixed(3)),
    pct: (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`),
    usd: (v) => (v === null || v === undefined ? "—" : `$${v.toFixed(4)}`),
    dur: (ms) => {
      if (ms === null || ms === undefined) return "—";
      if (ms < 1000) return `${Math.round(ms)}ms`;
      const s = Math.round(ms / 1000);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    },
  };

  function pillClass(status) {
    if (status === "succeeded") return "pill pill-good";
    if (status === "running" || status === "finalizing") return "pill";
    if (status === "infra_error") return "pill pill-warn";
    return "pill pill-bad";
  }

  const STATUS_LABEL = {
    running: "Running",
    finalizing: "Grading",
    succeeded: "Scored",
    failed: "Failed",
    timeout: "Timed out",
    error: "Error",
    infra_error: "Setup issue",
  };

  // ---------- tabs ----------

  function movePill() {
    const active = document.querySelector(".tab.active");
    const pill = $("#tab-pill");
    if (!active || !pill) return;
    pill.style.left = `${active.offsetLeft}px`;
    pill.style.width = `${active.offsetWidth}px`;
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      $(`#panel-${btn.dataset.tab}`).classList.add("active");
      movePill();
      if (btn.dataset.tab === "leaderboard") refreshLeaderboard();
      if (btn.dataset.tab === "event") refreshEventInfo();
    });
  });

  window.addEventListener("resize", movePill);
  movePill();

  // ---------- team ----------

  function saveTeam() {
    if (state.team) localStorage.setItem("aec-team", JSON.stringify(state.team));
    else localStorage.removeItem("aec-team");
  }

  function showSignedIn(info) {
    $("#team-forms").classList.add("hidden");
    $("#code-reveal").classList.add("hidden");
    $("#team-info").classList.remove("hidden");
    $("#run-card").classList.remove("hidden");
    $("#history-card").classList.remove("hidden");
    $("#team-status").textContent = "Signed in";
    $("#team-status").className = "pill pill-good";
    $("#team-name-display").textContent = state.team.name;
    if (info) {
      $("#test-runs-left").textContent = `${info.max_test_runs - info.test_runs_used} of ${info.max_test_runs} left`;
      $("#final-runs-left").textContent = info.final_runs_used > 0 ? "submitted" : "available";
      renderHistory(info.runs || []);
    }
  }

  function signOut() {
    state.team = null;
    saveTeam();
    stopPolling();
    $("#team-forms").classList.remove("hidden");
    $("#team-info").classList.add("hidden");
    $("#run-card").classList.add("hidden");
    $("#active-run-card").classList.add("hidden");
    $("#history-card").classList.add("hidden");
    $("#team-status").textContent = "Not signed in";
    $("#team-status").className = "pill pill-dim";
    $("#event-signin-hint").classList.remove("hidden");
    $("#event-sections").innerHTML = "";
  }

  async function refreshTeam() {
    if (!state.team) return null;
    try {
      const info = await api("/api/team/runs", {
        method: "POST",
        body: JSON.stringify(state.team),
      });
      showSignedIn(info);
      return info;
    } catch (e) {
      toast(e.message, true);
      signOut();
      return null;
    }
  }

  $("#claim-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#claim-name").value.trim();
    try {
      const data = await api("/api/teams", { method: "POST", body: JSON.stringify({ name }) });
      state.team = { name: data.name, code: data.code };
      saveTeam();
      $("#team-forms").classList.add("hidden");
      $("#revealed-code").textContent = data.code;
      $("#code-reveal").classList.remove("hidden");
    } catch (e) {
      toast(e.message, true);
    }
  });

  $("#code-saved-btn").addEventListener("click", () => {
    refreshTeam();
    refreshEventInfo();
  });

  $("#login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    state.team = { name: $("#login-name").value.trim(), code: $("#login-code").value.trim() };
    const info = await refreshTeam();
    if (info) {
      saveTeam();
      refreshEventInfo();
    }
  });

  $("#signout-btn").addEventListener("click", signOut);

  // ---------- runs ----------

  $("#run-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!state.team) return;
    const kind = document.querySelector('input[name="kind"]:checked').value;
    if (kind === "final" && !confirm("Final runs cannot be repeated. Launch it now?")) return;

    const btn = $("#run-submit-btn");
    btn.disabled = true;
    btn.textContent = "Launching…";
    try {
      const run = await api("/api/runs", {
        method: "POST",
        body: JSON.stringify({ ...state.team, repo: $("#repo-input").value.trim(), kind }),
      });
      state.activeRun = { id: run.id, token: run.poll_token };
      showActiveRun({ id: run.id, kind, status: "running", elapsed_ms: 0 });
      startPolling();
      toast(`Run #${run.id} launched.`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Launch run";
    }
  });

  const PROGRESS_STEPS = [
    [0, "Provisioning sandbox…"],
    [6, "Cloning your repo…"],
    [15, "Executing run.sh…"],
  ];

  function showActiveRun(run) {
    $("#active-run-card").classList.remove("hidden");
    $("#active-run-id").textContent = `#${run.id}`;
    const pill = $("#active-run-status");
    pill.textContent = STATUS_LABEL[run.status] || run.status;
    pill.className = pillClass(run.status);

    const isLive = run.status === "running" || run.status === "finalizing";
    $("#run-progress").classList.toggle("hidden", !isLive);
    $("#run-result").classList.toggle("hidden", isLive);

    if (isLive) {
      const sec = Math.round((run.elapsed_ms || 0) / 1000);
      let line = PROGRESS_STEPS[0][1];
      for (const [t, label] of PROGRESS_STEPS) if (sec >= t) line = label;
      if (run.status === "finalizing") line = "Grading output…";
      $("#progress-line").textContent = line;
      $("#progress-elapsed").textContent = `${fmt.dur(run.elapsed_ms)} elapsed`;
      return;
    }

    // Finished: render scores / errors.
    const grid = $("#score-grid");
    grid.innerHTML = "";
    if (run.sealed) {
      grid.innerHTML = `<div class="score-tile hero" style="grid-column: 1 / -1">
        <div class="k">Final run</div><div class="v" style="font-size:18px">${run.message || "Sealed until the end of the event."}</div></div>`;
    } else if (run.status === "succeeded") {
      grid.innerHTML = [
        tile("F1", fmt.f1(run.f1), true),
        tile("Precision", fmt.pct(run.precision)),
        tile("Recall", fmt.pct(run.recall)),
        tile("Matched", `${run.matched} / ${run.matched + Math.max(0, (run.reported ?? 0) - run.matched)} reported`),
        tile("Cost", fmt.usd(run.cost_usd)),
        tile("Time", fmt.dur(run.duration_ms)),
        tile("LLM calls", run.llm_calls ?? 0),
      ].join("");
    }

    const errBox = $("#run-error");
    if (run.error && !run.sealed) {
      errBox.textContent = run.error;
      errBox.classList.remove("hidden");
    } else {
      errBox.classList.add("hidden");
    }

    const logDetails = $("#log-details");
    if (run.log_tail && !run.sealed) {
      $("#log-tail").textContent = run.log_tail;
      logDetails.classList.remove("hidden");
    } else {
      logDetails.classList.add("hidden");
    }
  }

  function tile(k, v, hero = false) {
    return `<div class="score-tile${hero ? " hero" : ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      if (!state.activeRun) return stopPolling();
      try {
        const run = await api(`/api/runs/${state.activeRun.id}?token=${state.activeRun.token}`);
        showActiveRun(run);
        if (run.status !== "running" && run.status !== "finalizing") {
          stopPolling();
          state.activeRun = null;
          refreshTeam();
          toast(run.status === "succeeded" ? "Run scored." : `Run finished: ${STATUS_LABEL[run.status] || run.status}`);
        }
      } catch {
        /* transient poll failure — keep trying */
      }
    }, 4000);
  }

  function renderHistory(runs) {
    const tbody = $("#history-table tbody");
    tbody.innerHTML = "";
    for (const run of runs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="num">#${run.id}</td>
        <td>${run.kind}</td>
        <td class="num">${escapeHtml(run.repo || "")}</td>
        <td><span class="${pillClass(run.status)}">${STATUS_LABEL[run.status] || run.status}</span></td>
        <td class="num">${run.sealed ? "sealed" : fmt.f1(run.f1)}</td>
        <td class="num">${run.sealed ? "sealed" : fmt.usd(run.cost_usd)}</td>
        <td class="num">${fmt.dur(run.duration_ms)}</td>`;
      tbody.appendChild(tr);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  // ---------- event info ----------

  function copyRow(value, label) {
    return `<button class="btn btn-copy" data-copy="${escapeHtml(value)}">Copy</button>`;
  }

  document.body.addEventListener("click", (ev) => {
    const value = ev.target?.dataset?.copy;
    if (!value) return;
    navigator.clipboard.writeText(value).then(
      () => toast("Copied."),
      () => toast("Copy failed — select the text instead.", true),
    );
  });

  async function refreshEventInfo() {
    const hint = $("#event-signin-hint");
    const root = $("#event-sections");
    if (!state.team) {
      hint.classList.remove("hidden");
      root.innerHTML = "";
      return;
    }
    hint.classList.add("hidden");
    try {
      const data = await api("/api/event-info", { method: "POST", body: JSON.stringify(state.team) });
      renderEventInfo(data);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderEventInfo({ event_info: info, team_key: key }) {
    const cards = [];

    if (key) {
      const spent = key.usage ?? null;
      const limit = key.limit ?? null;
      const pct = spent !== null && limit ? Math.min(100, (spent / limit) * 100) : null;
      cards.push(`<div class="card">
        <div class="card-head"><h2>Your team's OpenRouter key</h2>
          ${key.disabled === true ? '<span class="pill pill-bad">Disabled</span>' : key.disabled === false ? '<span class="pill pill-good">Active</span>' : ""}</div>
        <div class="kv-list">
          <div class="kv-row"><span class="k">API key</span><span class="secret">${escapeHtml(key.key)}</span>${copyRow(key.key)}</div>
          <div class="kv-row"><span class="k">Spend</span>
            <span class="v mono">${spent === null ? "—" : "$" + spent.toFixed(4)}${limit ? ` of $${limit.toFixed(2)}` : ""}</span>
            ${pct === null ? "" : `<span class="spend-bar"><div style="width:${pct.toFixed(1)}%"></div></span>`}</div>
          <div class="kv-row"><span class="k">Use it at</span><span class="v mono">https://openrouter.ai/api/v1</span></div>
        </div>
        <p class="hint" style="margin-top:10px">This key is for local development. Inside graded runs, read <span class="mono">OPENROUTER_API_KEY</span> from the environment instead.</p>
      </div>`);
    }

    const sk = info.shared_key;
    if (sk?.value) {
      cards.push(`<div class="card">
        <div class="card-head"><h2>${escapeHtml(sk.label || "Shared API key")}</h2></div>
        <div class="kv-row"><span class="secret">${escapeHtml(sk.value)}</span>${copyRow(sk.value)}</div>
      </div>`);
    }

    const sa = info.structured_ai;
    if (sa && (sa.docs_url || sa.base_url || sa.api_key || sa.notes)) {
      const rows = [];
      if (sa.docs_url) rows.push(`<div class="kv-row"><span class="k">Docs</span><span class="v"><a href="${escapeHtml(sa.docs_url)}" target="_blank" rel="noopener">${escapeHtml(sa.docs_url)}</a></span></div>`);
      if (sa.base_url) rows.push(`<div class="kv-row"><span class="k">Base URL</span><span class="v mono">${escapeHtml(sa.base_url)}</span>${copyRow(sa.base_url)}</div>`);
      if (sa.api_key) rows.push(`<div class="kv-row"><span class="k">API key</span><span class="secret">${escapeHtml(sa.api_key)}</span>${copyRow(sa.api_key)}</div>`);
      if (sa.notes) rows.push(`<div class="kv-row"><span class="k">Notes</span><span class="v">${escapeHtml(sa.notes)}</span></div>`);
      cards.push(`<div class="card"><div class="card-head"><h2>Structured AI API</h2></div><div class="kv-list">${rows.join("")}</div></div>`);
    }

    if (info.links?.length) {
      const rows = info.links
        .filter((l) => l && l.url)
        .map((l) => `<div class="kv-row"><span class="k">${escapeHtml(l.label || "Link")}</span><span class="v"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a></span></div>`);
      cards.push(`<div class="card"><div class="card-head"><h2>Links</h2></div><div class="kv-list">${rows.join("")}</div></div>`);
    }

    if (info.notes) {
      cards.push(`<div class="card"><div class="card-head"><h2>Notes</h2></div><p style="font-size:14px; white-space:pre-wrap">${escapeHtml(info.notes)}</p></div>`);
    }

    $("#event-sections").innerHTML =
      cards.join("") || '<div class="card"><p class="hint">Nothing here yet — the organizers have not published event info.</p></div>';
  }

  // ---------- leaderboard ----------

  async function refreshLeaderboard() {
    try {
      const data = await api("/api/leaderboard");
      const tbody = $("#lb-table tbody");
      tbody.innerHTML = "";
      data.teams.forEach((t, i) => {
        const tr = document.createElement("tr");
        if (i < 3 && t.f1 !== null) tr.className = "podium";
        tr.innerHTML = `
          <td class="rank">${t.f1 === null ? "—" : i + 1}</td>
          <td>${escapeHtml(t.team)}</td>
          <td class="num">${fmt.f1(t.f1)}</td>
          <td class="num">${fmt.pct(t.precision)}</td>
          <td class="num">${fmt.pct(t.recall)}</td>
          <td class="num">${fmt.usd(t.cost_usd)}</td>
          <td class="num">${fmt.dur(t.duration_ms)}</td>
          <td class="num">${t.test_runs_used} / ${t.max_test_runs}</td>
          <td>${t.final_submitted ? "✓" : ""}</td>`;
        tbody.appendChild(tr);
      });
      $("#lb-updated").textContent = `updated ${new Date(data.updated_at).toLocaleTimeString()}`;
    } catch {
      /* leave the old rows in place */
    }
  }

  // ---------- init ----------

  async function loadConfig() {
    try {
      const cfg = await api("/api/config");
      $("#rule-limits").textContent = `${cfg.max_test_runs} test runs, ${cfg.max_final_runs} final run per team.`;
      $("#rule-timeout").textContent = `${Math.round(cfg.run_timeout_seconds / 60)} minute wall-clock timeout per run.`;
      $("#rule-calls").textContent = `Up to ${cfg.max_llm_calls_per_run} LLM calls per run.`;
    } catch {
      /* defaults in the HTML are fine */
    }
  }

  const savedTeam = localStorage.getItem("aec-team");
  if (savedTeam) {
    try {
      state.team = JSON.parse(savedTeam);
      refreshTeam();
    } catch {
      localStorage.removeItem("aec-team");
    }
  }
  loadConfig();
  refreshLeaderboard();
  state.lbTimer = setInterval(() => {
    if ($("#panel-leaderboard").classList.contains("active")) refreshLeaderboard();
  }, 10000);
})();
