const $ = (s) => document.querySelector(s);
const state = {
  lots: [], quotes: {}, fx: {}, rows: [],
  base: localStorage.getItem("base") || "EUR",
  sort: { k: "valueBase", dir: -1 },
  selected: null, range: "1y", editId: null,
};
const charts = {};
const PALETTE = ["#4f8cff", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6", "#ec4899", "#eab308", "#6366f1", "#84cc16", "#f97316", "#06b6d4"];

const api = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const money = (v, cur) => v == null || isNaN(v) ? "–" :
  new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(v);
const signed = (v, cur) => v == null || isNaN(v) ? "–" : (v > 0 ? "+" : "") + money(v, cur);
const pct = (v) => v == null || isNaN(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(2) + "%";
const cls = (v) => v > 0 ? "up" : v < 0 ? "down" : "";
const num = (v) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(v);

async function loadLots() { state.lots = await api("/api/lots"); }

async function loadQuotes() {
  const syms = [...new Set(state.lots.map((l) => l.symbol))];
  state.quotes = syms.length ? await api("/api/quotes?symbols=" + encodeURIComponent(syms.join(","))) : {};
  const curs = [...new Set(Object.values(state.quotes).map((q) => q.currency).filter((c) => c && c !== state.base))];
  const fxSyms = curs.map((c) => `${c}${state.base}=X`);
  const fxq = fxSyms.length ? await api("/api/quotes?symbols=" + encodeURIComponent(fxSyms.join(","))) : {};
  state.fx = { [state.base]: 1 };
  curs.forEach((c) => { const q = fxq[`${c}${state.base}=X`]; state.fx[c] = q && q.price ? q.price : null; });
  $("#updated").textContent = "Updated " + new Date().toLocaleTimeString();
}

function compute() {
  const groups = {};
  for (const l of state.lots) (groups[l.symbol] ||= []).push(l);
  const rows = Object.entries(groups).map(([symbol, lots]) => {
    const q = state.quotes[symbol] || {};
    const cur = q.currency || "USD";
    const fx = state.fx[cur] ?? (cur === state.base ? 1 : null);
    const shares = lots.reduce((s, l) => s + l.shares, 0);
    const cost = lots.reduce((s, l) => s + l.shares * l.price, 0);
    const value = q.price != null ? shares * q.price : null;
    const gain = value != null ? value - cost : null;
    const dayChange = q.price != null && q.previousClose ? shares * (q.price - q.previousClose) : null;
    return {
      symbol, lots, q, cur, shares, cost, value, gain,
      name: q.name || symbol,
      avg: cost / shares, price: q.price,
      dayPct: q.previousClose ? (q.price / q.previousClose - 1) * 100 : null,
      retPct: gain != null && cost ? (gain / cost) * 100 : null,
      costBase: fx != null ? cost * fx : null,
      valueBase: value != null && fx != null ? value * fx : null,
      gainBase: gain != null && fx != null ? gain * fx : null,
      dayBase: dayChange != null && fx != null ? dayChange * fx : null,
      error: q.error,
    };
  });
  const totalValue = rows.reduce((s, r) => s + (r.valueBase || 0), 0);
  rows.forEach((r) => (r.weight = totalValue && r.valueBase != null ? (r.valueBase / totalValue) * 100 : null));
  const { k, dir } = state.sort;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (typeof x === "string") return dir * x.localeCompare(y);
    return dir * ((x ?? -Infinity) - (y ?? -Infinity));
  });
  state.rows = rows;
}

function renderSummary() {
  const B = state.base, rows = state.rows;
  const value = rows.reduce((s, r) => s + (r.valueBase || 0), 0);
  const cost = rows.reduce((s, r) => s + (r.valueBase != null ? r.costBase : 0), 0);
  const day = rows.reduce((s, r) => s + (r.dayBase || 0), 0);
  const gain = value - cost;
  $("#tValue").textContent = money(value, B);
  $("#tCost").textContent = money(cost, B);
  $("#tGain").textContent = signed(gain, B); $("#tGain").className = "value " + cls(gain);
  $("#tGainPct").textContent = cost ? pct((gain / cost) * 100) : ""; $("#tGainPct").className = "sub " + cls(gain);
  $("#tDay").textContent = signed(day, B); $("#tDay").className = "value " + cls(day);
  const prevVal = value - day;
  $("#tDayPct").textContent = prevVal ? pct((day / prevVal) * 100) : ""; $("#tDayPct").className = "sub " + cls(day);
}

function renderTable() {
  const B = state.base;
  const tb = $("#holdings tbody");
  tb.innerHTML = "";
  $("#empty").classList.toggle("hidden", state.rows.length > 0);
  for (const r of state.rows) {
    const tr = document.createElement("tr");
    if (r.symbol === state.selected) tr.classList.add("selected");
    tr.innerHTML = `
      <td><div class="sym">${r.symbol}</div><div class="name" title="${r.name}">${r.error ? '<span class="down">Price unavailable</span>' : r.name}</div></td>
      <td class="num">${num(r.shares)}</td>
      <td class="num">${money(r.avg, r.cur)}</td>
      <td class="num"><b>${money(r.price, r.cur)}</b></td>
      <td class="num ${cls(r.dayPct)}">${pct(r.dayPct)}</td>
      <td class="num">${money(r.costBase, B)}</td>
      <td class="num"><b>${money(r.valueBase, B)}</b></td>
      <td class="num ${cls(r.gainBase)}">${signed(r.gainBase, B)}</td>
      <td class="num"><span class="pill ${cls(r.retPct)}">${pct(r.retPct)}</span></td>
      <td class="num">${r.weight != null ? r.weight.toFixed(1) + "%" : "–"}<div class="bar"><div style="width:${r.weight || 0}%"></div></div></td>`;
    tr.onclick = () => selectStock(r.symbol === state.selected ? null : r.symbol);
    tb.appendChild(tr);
  }
  document.querySelectorAll("#holdings th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === state.sort.k);
    th.classList.toggle("asc", th.dataset.k === state.sort.k && state.sort.dir === 1);
  });
}

const chartDefaults = () => {
  Chart.defaults.color = "#8b96ad";
  Chart.defaults.borderColor = "#2a3550";
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
};

function renderCharts() {
  const B = state.base;
  const rows = state.rows.filter((r) => r.valueBase != null);
  const alloc = [...rows].sort((a, b) => b.valueBase - a.valueBase);
  charts.alloc?.destroy();
  charts.alloc = new Chart($("#allocChart"), {
    type: "doughnut",
    data: { labels: alloc.map((r) => r.symbol), datasets: [{ data: alloc.map((r) => r.valueBase), backgroundColor: alloc.map((_, i) => PALETTE[i % PALETTE.length]), borderColor: "#171e2e", borderWidth: 2 }] },
    options: { maintainAspectRatio: false, animation: false, cutout: "60%",
      plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (c) => {
        const total = c.dataset.data.reduce((a, b) => a + b, 0);
        return ` ${c.label}: ${money(c.raw, B)} (${((c.raw / total) * 100).toFixed(1)}%)`; } } } },
      onClick: (_, els) => els.length && selectStock(alloc[els[0].index].symbol) },
  });
  const ret = [...rows].sort((a, b) => b.retPct - a.retPct);
  charts.ret?.destroy();
  charts.ret = new Chart($("#retChart"), {
    type: "bar",
    data: { labels: ret.map((r) => r.symbol), datasets: [{ data: ret.map((r) => r.retPct), backgroundColor: ret.map((r) => (r.retPct >= 0 ? "#22c55e" : "#ef4444")), borderRadius: 4 }] },
    options: { maintainAspectRatio: false, animation: false, indexAxis: "y",
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${pct(c.raw)}  (${signed(ret[c.dataIndex].gainBase, B)})` } } },
      scales: { x: { ticks: { callback: (v) => v + "%" } }, y: { grid: { display: false } } },
      onClick: (_, els) => els.length && selectStock(ret[els[0].index].symbol) },
  });
}

async function selectStock(sym) {
  state.selected = sym;
  renderTable();
  $("#detail").classList.toggle("hidden", !sym);
  if (!sym) return;
  renderLots();
  await renderHistory();
  $("#detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderLots() {
  const r = state.rows.find((x) => x.symbol === state.selected);
  if (!r) { selectStock(null); return; }
  $("#dTitle").innerHTML = `${r.symbol} <span class="muted" style="font-weight:400">${r.name}</span> &nbsp;<span>${money(r.price, r.cur)}</span> <span class="${cls(r.dayPct)} small">${pct(r.dayPct)} today</span>`;
  const tb = $("#lots tbody");
  tb.innerHTML = "";
  const sorted = [...r.lots].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  for (const l of sorted) {
    const cost = l.shares * l.price, val = r.price != null ? l.shares * r.price : null;
    const g = val != null ? val - cost : null, p = g != null && cost ? (g / cost) * 100 : null;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${l.date || "–"}</td><td class="num">${num(l.shares)}</td><td class="num">${money(l.price, r.cur)}</td>
      <td class="num">${money(cost, r.cur)}</td><td class="num">${money(val, r.cur)}</td>
      <td class="num ${cls(g)}">${signed(g, r.cur)}</td><td class="num"><span class="pill ${cls(p)}">${pct(p)}</span></td>
      <td class="num"><button class="icon" data-edit="${l.id}" title="Edit">&#9998;</button><button class="icon" data-del="${l.id}" title="Delete">&#x2715;</button></td>`;
    tb.appendChild(tr);
  }
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><b>Total</b></td><td class="num"><b>${num(r.shares)}</b></td><td class="num"><b>${money(r.avg, r.cur)}</b> <span class="muted small">avg</span></td>
    <td class="num"><b>${money(r.cost, r.cur)}</b></td><td class="num"><b>${money(r.value, r.cur)}</b></td>
    <td class="num ${cls(r.gain)}"><b>${signed(r.gain, r.cur)}</b></td><td class="num"><span class="pill ${cls(r.retPct)}">${pct(r.retPct)}</span></td>
    <td class="num"><button class="icon" data-addfor="${r.symbol}" title="Add purchase">+ Add</button></td>`;
  tb.appendChild(tr);
}

async function renderHistory() {
  const sym = state.selected;
  const r = state.rows.find((x) => x.symbol === sym);
  let h;
  try { h = await api(`/api/history?symbol=${encodeURIComponent(sym)}&range=${state.range}`); } catch { return; }
  if (state.selected !== sym) return;
  const intraday = state.range === "1d" || state.range === "5d";
  const labels = h.points.map((p) => new Date(p[0] * 1000).toLocaleDateString(undefined, intraday ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "2-digit" }));
  const data = h.points.map((p) => p[1]);
  const up = data.length && data[data.length - 1] >= data[0];
  const color = up ? "#22c55e" : "#ef4444";
  const ctx = $("#histChart").getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, 340);
  grad.addColorStop(0, up ? "rgba(34,197,94,.25)" : "rgba(239,68,68,.25)"); grad.addColorStop(1, "rgba(0,0,0,0)");
  charts.hist?.destroy();
  charts.hist = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [
      { label: "Price", data, borderColor: color, backgroundColor: grad, fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15 },
      { label: "Your avg buy price", data: data.map(() => r.avg), borderColor: "#4f8cff", borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5, fill: false },
    ] },
    options: { maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.raw, h.currency)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } }, y: { ticks: { callback: (v) => money(v, h.currency) } } } },
  });
}

function renderAll() { compute(); renderSummary(); renderTable(); renderCharts(); if (state.selected) renderLots(); }

async function refresh(withHistory = false) {
  $("#refresh").disabled = true;
  try { await loadQuotes(); renderAll(); if (withHistory && state.selected) await renderHistory(); }
  catch (e) { $("#updated").textContent = "Price update failed: " + e.message; }
  finally { $("#refresh").disabled = false; }
}

// ---- Add / edit dialog ----
const dlg = $("#lotDialog");
let acTimer, acItems = [], acIdx = -1;

function openDialog(lot = null, symbol = "") {
  state.editId = lot ? lot.id : null;
  $("#lotDialogTitle").textContent = lot ? "Edit purchase" : "Add purchase";
  $("#fSymbol").value = lot ? lot.symbol : symbol;
  $("#fShares").value = lot ? lot.shares : "";
  $("#fPrice").value = lot ? lot.price : "";
  $("#fDate").value = lot ? lot.date : new Date().toISOString().slice(0, 10);
  $("#fInfo").textContent = ""; $("#fCur").textContent = "";
  $("#acList").classList.add("hidden");
  dlg.showModal();
  if ($("#fSymbol").value) lookupSymbol($("#fSymbol").value, !lot);
  ($("#fSymbol").value ? $("#fShares") : $("#fSymbol")).focus();
}

async function lookupSymbol(sym, prefill) {
  sym = sym.trim().toUpperCase();
  if (!sym) return;
  const q = (await api("/api/quotes?symbols=" + encodeURIComponent(sym)))[sym];
  if ($("#fSymbol").value.trim().toUpperCase() !== sym) return;
  if (!q || q.error || q.price == null) { $("#fInfo").innerHTML = `<span class="down">Couldn't find a price for ${sym}</span>`; $("#fCur").textContent = ""; return; }
  $("#fInfo").textContent = `${q.name} · ${q.exchange} · now ${money(q.price, q.currency)}`;
  $("#fCur").textContent = `(${q.currency})`;
  if (prefill && !$("#fPrice").value) $("#fPrice").value = +q.price.toFixed(4);
}

function showAc(items) {
  acItems = items; acIdx = -1;
  const ul = $("#acList");
  ul.innerHTML = items.map((x, i) => `<li data-i="${i}"><b>${x.symbol}</b><span>${x.name} · ${x.exchange}</span></li>`).join("");
  ul.classList.toggle("hidden", !items.length);
}
function pickAc(i) {
  const x = acItems[i]; if (!x) return;
  $("#fSymbol").value = x.symbol; $("#acList").classList.add("hidden");
  $("#fPrice").value = ""; lookupSymbol(x.symbol, true); $("#fShares").focus();
}
$("#fSymbol").addEventListener("input", (e) => {
  clearTimeout(acTimer);
  const q = e.target.value.trim();
  $("#fInfo").textContent = "";
  if (q.length < 1) return showAc([]);
  acTimer = setTimeout(async () => { try { showAc(await api("/api/search?q=" + encodeURIComponent(q))); } catch { showAc([]); } }, 250);
});
$("#fSymbol").addEventListener("keydown", (e) => {
  const ul = $("#acList");
  if (ul.classList.contains("hidden")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    acIdx = (acIdx + (e.key === "ArrowDown" ? 1 : -1) + acItems.length) % acItems.length;
    ul.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === acIdx));
  } else if (e.key === "Enter" && acIdx >= 0) { e.preventDefault(); pickAc(acIdx); }
  else if (e.key === "Escape") { e.preventDefault(); ul.classList.add("hidden"); }
});
$("#fSymbol").addEventListener("blur", () => setTimeout(() => { $("#acList").classList.add("hidden"); lookupSymbol($("#fSymbol").value, false); }, 200));
$("#acList").addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) { e.preventDefault(); pickAc(+li.dataset.i); } });
$("#cancelBtn").onclick = () => dlg.close();
$("#lotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = JSON.stringify({ symbol: $("#fSymbol").value.trim().toUpperCase(), shares: +$("#fShares").value, price: +$("#fPrice").value, date: $("#fDate").value });
  try {
    if (state.editId) await api("/api/lots/" + state.editId, { method: "PUT", body });
    else await api("/api/lots", { method: "POST", body });
  } catch (err) { $("#fInfo").innerHTML = `<span class="down">${err.message}</span>`; return; }
  dlg.close();
  await loadLots(); await refresh(true);
});

$("#lots").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.edit) openDialog(state.lots.find((l) => l.id === b.dataset.edit));
  if (b.dataset.addfor) openDialog(null, b.dataset.addfor);
  if (b.dataset.del && confirm("Delete this purchase?")) {
    await api("/api/lots/" + b.dataset.del, { method: "DELETE" });
    await loadLots(); await refresh(true);
  }
});

// ---- Controls ----
$("#addBtn").onclick = () => openDialog();
$("#refresh").onclick = () => refresh(true);
$("#base").value = state.base;
$("#base").onchange = (e) => { state.base = e.target.value; localStorage.setItem("base", state.base); refresh(); };
document.querySelectorAll("#holdings th").forEach((th) => th.onclick = () => {
  const k = th.dataset.k;
  state.sort = { k, dir: state.sort.k === k ? -state.sort.dir : (k === "symbol" ? 1 : -1) };
  renderAll();
});
$("#ranges").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.range = b.dataset.r;
  document.querySelectorAll("#ranges button").forEach((x) => x.classList.toggle("active", x === b));
  renderHistory();
});
$("#exportBtn").onclick = (e) => {
  e.preventDefault();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state.lots.map(({ id, ...l }) => l), null, 2)], { type: "application/json" }));
  a.download = "portfolio.json"; a.click();
};
$("#importBtn").onclick = (e) => { e.preventDefault(); $("#importFile").click(); };
$("#importFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (!confirm("Replace all current holdings with the imported file?")) return;
  try { await api("/api/lots/import", { method: "POST", body: await f.text() }); await loadLots(); await refresh(); }
  catch (err) { alert("Import failed: " + err.message); }
  e.target.value = "";
};

(async () => {
  chartDefaults();
  await loadLots();
  renderAll();
  await refresh();
  setInterval(() => refresh(), 60000);
})();
