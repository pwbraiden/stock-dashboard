const $ = (s) => document.querySelector(s);
const START = "2026-10-27";
const OWNERS = ["me", "gf"];
const COLORS = { me: "#4f8cff", gf: "#ec4899", bench: "#f59e0b" };
const BENCH = "QQQ";
const state = {
  lots: [], quotes: {}, fx: {}, rows: {},
  base: localStorage.getItem("base") || "EUR",
  sort: { k: "valueBase", dir: -1 },
  selected: null, editId: null,
  hidden: JSON.parse(localStorage.getItem("hiddenLines") || '{"me":true}'),
  names: { me: "Me", gf: "Girlfriend", ...JSON.parse(localStorage.getItem("names") || "{}") },
};
const charts = {};

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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const p2 = (n) => String(n).padStart(2, "0");
const localDay = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const localWhen = (t) => { const d = new Date(t * 1000); return `${localDay(t)}T${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const lotWhen = (l) => `${l.date || ""}T${l.time || "00:00"}`;
const ownerOf = (l) => (l.owner === "gf" ? "gf" : "me");

const SAMPLE = [
  { symbol: "AAPL", shares: 10, price: 150, date: "2023-03-15", owner: "me" },
  { symbol: "NVDA", shares: 20, price: 45, date: "2023-01-20", owner: "me" },
  { symbol: "MSFT", shares: 8, price: 310, date: "2023-05-02", owner: "gf" },
  { symbol: "SAP.DE", shares: 12, price: 120, date: "2023-09-01", owner: "gf" },
];
const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const saveLots = () => localStorage.setItem("lots", JSON.stringify(state.lots));
function loadLots() {
  const raw = localStorage.getItem("lots");
  if (raw == null) {
    state.lots = SAMPLE.map((l) => ({ ...l, id: newId(), sample: true }));
    saveLots();
  } else state.lots = JSON.parse(raw);
  $("#sampleBanner").classList.toggle("hidden", !state.lots.some((l) => l.sample));
}
function cleanLot(b) {
  const lot = { symbol: String(b.symbol || "").trim().toUpperCase(), shares: +b.shares, price: +b.price, date: String(b.date || ""), time: /^\d\d:\d\d$/.test(b.time || "") ? b.time : "", owner: ownerOf(b) };
  if (!lot.symbol || !(lot.shares > 0) || !(lot.price >= 0)) throw new Error("Please enter a ticker, shares and price");
  return lot;
}

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

function computeRows(lotsAll) {
  const groups = {};
  for (const l of lotsAll) (groups[l.symbol] ||= []).push(l);
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
  const { k, dir } = state.sort;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (typeof x === "string") return dir * x.localeCompare(y);
    return dir * ((x ?? -Infinity) - (y ?? -Infinity));
  });
  return rows;
}

function renderOwner(o) {
  const B = state.base, rows = (state.rows[o] = computeRows(state.lots.filter((l) => ownerOf(l) === o)));
  const box = document.querySelector(`.owner[data-owner=${o}]`);
  box.querySelector(".oname").textContent = state.names[o];
  const value = rows.reduce((s, r) => s + (r.valueBase || 0), 0);
  const cost = rows.reduce((s, r) => s + (r.valueBase != null ? r.costBase : 0), 0);
  const day = rows.reduce((s, r) => s + (r.dayBase || 0), 0), gain = value - cost;
  box.querySelector(".totals").innerHTML = rows.length ? `
    <span>Value<b>${money(value, B)}</b></span>
    <span>Invested<b>${money(cost, B)}</b></span>
    <span>Gain / loss<b class="${cls(gain)}">${signed(gain, B)} <small>${cost ? pct((gain / cost) * 100) : ""}</small></b></span>
    <span>Today<b class="${cls(day)}">${signed(day, B)}</b></span>` : "";
  box.querySelector(".empty").classList.toggle("hidden", rows.length > 0);
  const tb = box.querySelector("tbody");
  tb.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><div class="sym">${esc(r.symbol)}</div><div class="name" title="${esc(r.name)}">${r.error ? '<span class="down">Price unavailable</span>' : esc(r.name)}</div></td>
      <td class="num">${num(r.shares)}</td>
      <td class="num">${money(r.avg, r.cur)}</td>
      <td class="num"><b>${money(r.price, r.cur)}</b><div class="small ${cls(r.dayPct)}">${pct(r.dayPct)}</div></td>
      <td class="num"><b>${money(r.valueBase, B)}</b></td>
      <td class="num"><span class="pill ${cls(r.retPct)}">${pct(r.retPct)}</span><div class="small ${cls(r.gainBase)}">${signed(r.gainBase, B)}</div></td>`;
    tr.onclick = () => openStock(o, r.symbol);
    tb.appendChild(tr);
  }
  box.querySelectorAll("th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.k === state.sort.k);
    th.classList.toggle("asc", th.dataset.k === state.sort.k && state.sort.dir === 1);
  });
}

const chartDefaults = () => {
  Chart.defaults.color = "#8b96ad";
  Chart.defaults.borderColor = "#2a3550";
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
};

const sdlg = $("#stockDialog");
function openStock(o, sym) { state.selected = { o, sym }; renderLots(); if (!sdlg.open) sdlg.showModal(); }
function renderLots() {
  if (!state.selected) return;
  const { o, sym } = state.selected;
  const r = (state.rows[o] || []).find((x) => x.symbol === sym);
  if (!r) { state.selected = null; sdlg.close(); return; }
  $("#dTitle").innerHTML = `${esc(r.symbol)} <span class="muted" style="font-weight:400">${esc(r.name)} · ${esc(state.names[o])}</span> &nbsp;<span>${money(r.price, r.cur)}</span> <span class="${cls(r.dayPct)} small">${pct(r.dayPct)} today</span>`;
  const tb = $("#lots tbody");
  tb.innerHTML = "";
  const sorted = [...r.lots].sort((a, b) => lotWhen(a).localeCompare(lotWhen(b)));
  for (const l of sorted) {
    const cost = l.shares * l.price, val = r.price != null ? l.shares * r.price : null;
    const g = val != null ? val - cost : null, p = g != null && cost ? (g / cost) * 100 : null;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(l.date || "–")}${l.time ? ` <span class="muted">${esc(l.time)}</span>` : ""}</td><td class="num">${num(l.shares)}</td><td class="num">${money(l.price, r.cur)}</td>
      <td class="num">${money(cost, r.cur)}</td><td class="num">${money(val, r.cur)}</td>
      <td class="num ${cls(g)}">${signed(g, r.cur)}</td><td class="num"><span class="pill ${cls(p)}">${pct(p)}</span></td>
      <td class="num"><button class="icon" data-edit="${l.id}" title="Edit">&#9998;</button><button class="icon" data-del="${l.id}" title="Delete">&#x2715;</button></td>`;
    tb.appendChild(tr);
  }
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><b>Total</b></td><td class="num"><b>${num(r.shares)}</b></td><td class="num"><b>${money(r.avg, r.cur)}</b> <span class="muted small">avg</span></td>
    <td class="num"><b>${money(r.cost, r.cur)}</b></td><td class="num"><b>${money(r.value, r.cur)}</b></td>
    <td class="num ${cls(r.gain)}"><b>${signed(r.gain, r.cur)}</b></td><td class="num"><span class="pill ${cls(r.retPct)}">${pct(r.retPct)}</span></td>
    <td class="num"><button class="icon" data-addfor="${esc(r.symbol)}" title="Add purchase">+ Add</button></td>`;
  tb.appendChild(tr);
}
$("#closeStock").onclick = () => { state.selected = null; sdlg.close(); };

function renderAll() { OWNERS.forEach(renderOwner); renderLots(); if (cmp.data) drawCompare(); }

async function refresh() {
  $("#refresh").disabled = true;
  try { await loadQuotes(); renderAll(); renderCompare(); }
  catch (e) { $("#updated").textContent = "Price update failed: " + e.message; }
  finally { $("#refresh").disabled = false; }
}
// ---- Add / edit dialog ----
const dlg = $("#lotDialog");
let acTimer, acItems = [], acIdx = -1;

function openDialog(lot = null, symbol = "", owner = null) {
  OWNERS.forEach((o) => ($(`#fOwner option[value=${o}]`).textContent = state.names[o]));
  $("#fOwner").value = lot ? ownerOf(lot) : owner || localStorage.getItem("lastOwner") || "me";
  state.editId = lot ? lot.id : null;
  $("#lotDialogTitle").textContent = lot ? "Edit purchase" : "Add purchase";
  $("#fSymbol").value = lot ? lot.symbol : symbol;
  $("#fShares").value = lot ? lot.shares : "";
  $("#fPrice").value = lot ? lot.price : "";
  const now = new Date();
  $("#fDate").value = lot ? lot.date : localDay(now / 1000);
  $("#fTime").value = lot ? lot.time || "" : now.toTimeString().slice(0, 5);
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
  let lot;
  try { lot = cleanLot({ symbol: $("#fSymbol").value, shares: $("#fShares").value, price: $("#fPrice").value, date: $("#fDate").value, time: $("#fTime").value, owner: $("#fOwner").value });
  localStorage.setItem("lastOwner", lot.owner); }
  catch (err) { $("#fInfo").innerHTML = `<span class="down">${err.message}</span>`; return; }
  if (state.editId) state.lots = state.lots.map((l) => (l.id === state.editId ? { ...lot, id: l.id } : l));
  else state.lots.push({ ...lot, id: newId() });
  saveLots(); loadLots();
  dlg.close();
  await refresh();
});

$("#lots").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.edit) openDialog(state.lots.find((l) => l.id === b.dataset.edit));
  if (b.dataset.addfor) openDialog(null, b.dataset.addfor, state.selected?.o);
  if (b.dataset.del && confirm("Delete this purchase?")) {
    state.lots = state.lots.filter((l) => l.id !== b.dataset.del);
    saveLots(); loadLots(); await refresh();
  }
});

// ---- Controls ----
$("#clearSample").onclick = () => {
  state.lots = state.lots.filter((l) => !l.sample);
  saveLots(); loadLots(); renderAll(); refresh();
};
$("#addBtn").onclick = () => openDialog();
$("#refresh").onclick = () => refresh();
$("#base").value = state.base;
$("#base").onchange = (e) => { state.base = e.target.value; localStorage.setItem("base", state.base); refresh(); };
document.querySelectorAll(".holdings th").forEach((th) => th.onclick = () => {
  const k = th.dataset.k;
  state.sort = { k, dir: state.sort.k === k ? -state.sort.dir : (k === "symbol" ? 1 : -1) };
  renderAll();
});
document.querySelectorAll(".owner").forEach((box) => {
  const o = box.dataset.owner;
  box.querySelector(".addfor").onclick = () => openDialog(null, "", o);
  box.querySelector(".rename").onclick = () => {
    const n = prompt("Name for this portfolio:", state.names[o]);
    if (n && n.trim()) { state.names[o] = n.trim(); localStorage.setItem("names", JSON.stringify(state.names)); renderAll(); }
  };
});
$("#exportBtn").onclick = (e) => {
  e.preventDefault();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state.lots.map(({ id, sample, ...l }) => l), null, 2)], { type: "application/json" }));
  a.download = "portfolio.json"; a.click();
};
$("#importBtn").onclick = (e) => { e.preventDefault(); $("#importFile").click(); };
$("#importFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (!confirm("Replace all current holdings with the imported file?")) return;
  try {
    state.lots = JSON.parse(await f.text()).map((l) => ({ ...cleanLot(l), id: newId() }));
    saveLots(); loadLots(); await refresh();
  }
  catch (err) { alert("Import failed: " + err.message); }
  e.target.value = "";
};
// ---- Return since START: me vs girlfriend vs QQQ ----
const cmp = { seq: 0, data: null };

function ffill(points, keys) {
  const out = []; let j = 0, last = null;
  for (const k of keys) { while (j < points.length && points[j][0] <= k) last = points[j++][1]; out.push(last); }
  return out;
}

async function renderCompare() {
  const seq = ++cmp.seq;
  const syms = [...new Set(state.lots.map((l) => l.symbol))];
  const get = (s) => api(`/api/history?symbol=${encodeURIComponent(s)}&start=${START}`).catch(() => null);
  const [bench, ...hs] = await Promise.all([BENCH, ...syms].map(get));
  if (seq !== cmp.seq) return;
  if (!bench || !bench.points.length) { $("#cmpNote").textContent = `Couldn't load ${BENCH} prices.`; return; }
  const H = {}; syms.forEach((s, i) => (H[s] = hs[i]?.points || []));
  const keys = bench.points.map((p) => p[0]).filter((t) => localDay(t) >= START);
  const px = {}; syms.forEach((s) => (px[s] = ffill(H[s], keys)));
  const bpx = ffill(bench.points, keys);
  const fxOf = (s) => { const c = state.quotes[s]?.currency || hs[syms.indexOf(s)]?.currency || "USD"; return state.fx[c] ?? (c === state.base ? 1 : null); };
  // Lots bought before START are measured from their first price on/after START.
  const firstPx = {}; syms.forEach((s) => (firstPx[s] = px[s].find((p) => p != null) ?? null));
  const line = (o) => {
    const lots = state.lots.filter((l) => ownerOf(l) === o);
    return keys.map((t, i) => {
      const when = localWhen(t); let v = 0, c = 0;
      for (const l of lots) {
        if (l.date && lotWhen(l) > when) continue;
        const p = px[l.symbol][i], f = fxOf(l.symbol);
        const basis = l.date && l.date >= START ? l.price : firstPx[l.symbol];
        if (p == null || f == null || basis == null) continue;
        v += l.shares * p * f; c += l.shares * basis * f;
      }
      return c > 0 ? (v / c - 1) * 100 : null;
    });
  };
  const b0 = bpx.find((p) => p != null);
  cmp.data = { keys, me: line("me"), gf: line("gf"), bench: bpx.map((p) => (p != null && b0 ? (p / b0 - 1) * 100 : null)) };
  drawCompare();
}

function drawCompare() {
  const d = cmp.data; if (!d) return;
  const last = (a) => [...a].reverse().find((x) => x != null);
  const series = [
    { key: "me", label: state.names.me, color: COLORS.me },
    { key: "gf", label: state.names.gf, color: COLORS.gf },
    { key: "bench", label: BENCH, color: COLORS.bench },
  ].filter((s) => d[s.key].some((x) => x != null));
  const shown = series.filter((s) => !state.hidden[s.key]);
  $("#cmpSummary").innerHTML = shown.map((s) => { const r = last(d[s.key]);
    return `<span><span class="dot" style="background:${s.color}"></span>${esc(s.label)}<b class="${cls(r)}">${pct(r)}</b></span>`; }).join("");
  $("#cmpNote").textContent = `Return on the money you put in since ${$("#startLbl").textContent}, in each stock's own currency. ${BENCH} measured from its first price on ${$("#startLbl").textContent}. Buying more doesn't count as a gain.`;
  const span = d.keys.length ? (d.keys[d.keys.length - 1] - d.keys[0]) / 86400 : 0;
  const fmt = (t) => new Date(t * 1000).toLocaleString(undefined, span < 20 ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });
  charts.cmp?.destroy();
  charts.cmp = new Chart($("#cmpChart"), {
    type: "line",
    data: { labels: d.keys.map(fmt), datasets: series.map((s) => ({ hidden: !!state.hidden[s.key], label: s.label, data: d[s.key], borderColor: s.color, backgroundColor: s.color, pointRadius: 0, borderWidth: s.key === "bench" ? 2 : 2.5, tension: 0.15, spanGaps: true })) },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { usePointStyle: true, pointStyle: "line" },
        onClick: (_, item) => { const k = series[item.datasetIndex].key; state.hidden[k] = !state.hidden[k]; localStorage.setItem("hiddenLines", JSON.stringify(state.hidden)); drawCompare(); } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${pct(c.raw)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0, callback(v) { return this.getLabelForValue(v).split(", ").slice(0, 2).join(", "); } }, grid: { display: false } },
                y: { ticks: { callback: (v) => v + "%" } } },
    },
  });
}

$("#startLbl").textContent = new Date(START + "T12:00").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

(async () => {
  chartDefaults();
  loadLots();
  renderAll();
  await refresh();
  setInterval(() => refresh(), 60000);
})();
