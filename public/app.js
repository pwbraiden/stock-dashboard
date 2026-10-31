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

// Chart starts at the girlfriend's first order (falls back to START).
function chartStart() {
  const dated = state.lots.filter((l) => l.date && l.date >= START);
  const pick = (ls) => ls.reduce((a, l) => (!a || lotWhen(l) < lotWhen(a) ? l : a), null);
  const first = pick(dated.filter((l) => ownerOf(l) === "gf")) || pick(dated);
  return first ? { when: lotWhen(first), lot: first } : { when: START + "T00:00", lot: null };
}

async function renderCompare() {
  const seq = ++cmp.seq;
  const start = chartStart(), startDay = start.when.slice(0, 10);
  const syms = [...new Set(state.lots.map((l) => l.symbol))];
  const get = (s) => api(`/api/history?symbol=${encodeURIComponent(s)}&start=${startDay}`).catch(() => null);
  const [bench, ...hs] = await Promise.all([BENCH, ...syms].map(get));
  if (seq !== cmp.seq) return;
  if (!bench || !bench.points.length) { $("#cmpNote").textContent = `Couldn't load ${BENCH} prices.`; return; }
  const H = {}; syms.forEach((s, i) => (H[s] = hs[i]?.points || []));
  const keys = bench.points.map((p) => p[0]).filter((t) => localWhen(t) >= start.when);
  if (!keys.length) { $("#cmpNote").textContent = `No ${BENCH} prices yet after the first order.`; return; }
  const px = {}; syms.forEach((s) => (px[s] = ffill(H[s], keys)));
  const bpx = ffill(bench.points, keys);
  const fxOf = (s) => { const c = state.quotes[s]?.currency || hs[syms.indexOf(s)]?.currency || "USD"; return state.fx[c] ?? (c === state.base ? 1 : null); };
  // Lots bought before the chart start are measured from their first price after it.
  const firstPx = {}; syms.forEach((s) => (firstPx[s] = px[s].find((p) => p != null) ?? null));
  const line = (o) => {
    const lots = state.lots.filter((l) => ownerOf(l) === o);
    return keys.map((t, i) => {
      const when = localWhen(t); let v = 0, c = 0;
      for (const l of lots) {
        if (l.date && lotWhen(l) > when) continue;
        const p = px[l.symbol][i], f = fxOf(l.symbol);
        const basis = l.date && lotWhen(l) >= start.when ? l.price : firstPx[l.symbol];
        if (p == null || f == null || basis == null) continue;
        v += l.shares * p * f; c += l.shares * basis * f;
      }
      return c > 0 ? (v / c - 1) * 100 : null;
    });
  };
  const b0 = bpx.find((p) => p != null);
  const sd = new Date(start.when);
  $("#startLbl").textContent = sd.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    (start.lot?.time ? ", " + start.lot.time : "") + (start.lot ? ` (first ${start.lot.symbol} order)` : "");
  await loadBetas([...new Set(state.lots.filter((l) => ownerOf(l) === "gf").map((l) => l.symbol))]);
  if (seq !== cmp.seq) return;
  cmp.data = { keys, b0, bLast: [...bpx].reverse().find((p) => p != null), me: line("me"), gf: line("gf"), bench: bpx.map((p) => (p != null && b0 ? (p / b0 - 1) * 100 : null)) };
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
  $("#cmpNote").textContent = `Return on the money put in, in each stock's own currency. ${BENCH} measured from its first price after the start. Buying more doesn't count as a gain.`;
  const span = d.keys.length ? (d.keys[d.keys.length - 1] - d.keys[0]) / 86400 : 0;
  const fmt = (t) => new Date(t * 1000).toLocaleString(undefined, span < 20 ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });
  const labels = d.keys.map(fmt);
  const datasets = series.map((s) => ({ hidden: !!state.hidden[s.key], label: s.label, data: [...d[s.key]], borderColor: s.color, backgroundColor: s.color, pointRadius: 0, borderWidth: s.key === "bench" ? 2 : 2.5, tension: 0.15, spanGaps: true }));
  const wi = whatIf(d);
  if (wi) {
    // Extend the x-axis to the target, spaced like the trading-hours data so far.
    const t0 = d.keys[d.keys.length - 1], tTarget = wi.when ? new Date(wi.when).getTime() / 1000 : null;
    const perDay = d.keys.length / Math.max(1, span);
    const steps = tTarget && tTarget > t0 ? Math.min(Math.max(8, Math.round(perDay * (tTarget - t0) / 86400 * 5 / 7)), d.keys.length * 2) : 8;
    for (let k = 1; k <= steps; k++) labels.push(k === steps ? "Target" + (tTarget ? ": " + fmt(tTarget) : "") : tTarget ? fmt(t0 + (tTarget - t0) * k / steps) : "");
    const n = labels.length - 1;
    datasets.forEach((ds) => ds.data.push(...Array(steps).fill(null)));
    const proj = (key, label, color, end) => {
      const i = d[key].length - 1 - [...d[key]].reverse().findIndex((x) => x != null);
      const data = Array(n + 1).fill(null); data[i] = d[key][i]; data[n] = end;
      datasets.push({ label, data, borderColor: color, backgroundColor: color, borderDash: [6, 4], borderWidth: 2, spanGaps: true, tension: 0,
        pointRadius: data.map((_, j) => (j === n ? 5 : 0)), proj: true });
    };
    proj("bench", `${BENCH} target`, COLORS.bench, wi.benchRet);
    if (wi.gfRet != null && !state.hidden.gf) proj("gf", `${state.names.gf} implied`, COLORS.gf, wi.gfRet);
  }
  charts.cmp?.destroy();
  charts.cmp = new Chart($("#cmpChart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { usePointStyle: true, pointStyle: "line", filter: (item) => item.datasetIndex < series.length },
        onClick: (_, item) => { if (item.datasetIndex >= series.length) return; const k = series[item.datasetIndex].key; state.hidden[k] = !state.hidden[k]; localStorage.setItem("hiddenLines", JSON.stringify(state.hidden)); drawCompare(); } }, tooltip: { filter: (c) => c.raw != null, callbacks: { label: (c) => ` ${c.dataset.label}: ${pct(c.raw)}` } } },
      scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0, callback(v) { return this.getLabelForValue(v).split(", ").slice(0, 2).join(", "); } }, grid: { display: false } },
                y: { ticks: { callback: (v) => v + "%" } } },
    },
  });
}

// ---- What-if: QQQ target -> implied move for girlfriend's portfolio via beta ----
const BETA_START = "2023-01-01";
const betas = {};
const betaOverride = JSON.parse(localStorage.getItem("betaOverride") || "{}");
const wiState = JSON.parse(localStorage.getItem("whatIf") || "{}");
async function loadBetas(syms) {
  const need = syms.filter((s) => !(s in betas));
  if (!need.length) return;
  const get = (s) => api(`/api/history?symbol=${encodeURIComponent(s)}&start=${BETA_START}`).catch(() => null);
  const [q, ...hs] = await Promise.all([BENCH, ...need].map(get));
  const rets = (pts) => { const m = {}; for (let i = 1; i < pts.length; i++) m[localDay(pts[i][0])] = pts[i][1] / pts[i - 1][1] - 1; return m; };
  const qr = q ? rets(q.points) : {};
  need.forEach((s, i) => {
    if (s === BENCH) { betas[s] = 1; return; }
    const sr = hs[i] ? rets(hs[i].points) : {};
    const days = Object.keys(sr).filter((k) => k in qr);
    if (days.length < 30) { betas[s] = null; return; }
    const mx = days.reduce((a, k) => a + qr[k], 0) / days.length, my = days.reduce((a, k) => a + sr[k], 0) / days.length;
    let cov = 0, v = 0; for (const k of days) { cov += (qr[k] - mx) * (sr[k] - my); v += (qr[k] - mx) ** 2; }
    betas[s] = v ? cov / v : null;
  });
}
const betaOf = (s) => betaOverride[s] ?? betas[s] ?? null;

function whatIf(d) {
  $("#wiNow").textContent = d.bLast ? `(now ${money(d.bLast, "USD")})` : "";
  const target = +wiState.price;
  const tb = $("#wiTable tbody"), editing = $("#wiTable").contains(document.activeElement);
  if (!(target > 0) || !d.bLast) {
    $("#wiOut").innerHTML = ""; $("#wiNote").textContent = ""; $("#wiTable").classList.add("hidden");
    return null;
  }
  const m = target / d.bLast - 1;
  const rows = (state.rows.gf || []).filter((r) => r.valueBase != null);
  const total = rows.reduce((a, r) => a + r.valueBase, 0);
  let pm = 0, wb = 0, missing = [];
  for (const r of rows) { const b = betaOf(r.symbol); if (b == null) { missing.push(r.symbol); continue; } pm += (r.valueBase / total) * b * m; wb += (r.valueBase / total) * b; }
  const gfLast = [...d.gf].reverse().find((x) => x != null);
  const gfRet = gfLast != null && rows.length ? ((1 + gfLast / 100) * (1 + pm) - 1) * 100 : null;
  const B = state.base, name = esc(state.names.gf);
  $("#wiOut").innerHTML = `${BENCH} ${money(d.bLast, "USD")} → <b>${money(target, "USD")}</b> = <b class="${cls(m)}">${pct(m * 100)}</b> move` +
    (rows.length ? `<br>${name}'s portfolio (beta ${wb.toFixed(2)}) → implied <b class="${cls(pm)}">${pct(pm * 100)}</b> = ${signed(total * pm, B)}, value <b>${money(total * (1 + pm), B)}</b>, return since start <b class="${cls(gfRet)}">${pct(gfRet)}</b>` : `<br>${name} has no stocks yet.`);
  if (!editing) {
    tb.innerHTML = rows.map((r) => { const b = betaOf(r.symbol), sm = b != null ? b * m : null;
      return `<tr><td><div class="sym">${esc(r.symbol)}</div></td><td class="num">${((r.valueBase / total) * 100).toFixed(1)}%</td>
        <td class="num"><input type="number" step="0.01" data-beta="${esc(r.symbol)}" value="${b != null ? b.toFixed(2) : ""}" title="${betaOverride[r.symbol] != null ? "Your value" : "Measured from daily prices since 1 Jan 2023"}">${betaOverride[r.symbol] != null ? ' <button class="icon" data-reset="' + esc(r.symbol) + '" title="Use measured beta">↺</button>' : ""}</td>
        <td class="num ${cls(sm)}">${sm != null ? pct(sm * 100) : "–"}</td><td class="num">${money(r.price, r.cur)}</td>
        <td class="num"><b>${sm != null && r.price != null ? money(r.price * (1 + sm), r.cur) : "–"}</b></td></tr>`; }).join("");
  }
  $("#wiTable").classList.toggle("hidden", !rows.length);
  $("#wiNote").textContent = `Beta = how much a stock has moved for each 1% move in ${BENCH}, measured from daily prices since 1 Jan 2023 (or since listing, if later). You can type your own.` +
    (missing.length ? ` No beta for ${missing.join(", ")}, so it's left out.` : "");
  return { benchRet: (target / d.b0 - 1) * 100, gfRet, when: wiState.date ? `${wiState.date}T${wiState.time || "22:00"}` : null };
}

$("#wiPrice").value = wiState.price || ""; $("#wiDate").value = wiState.date || ""; $("#wiTime").value = wiState.time || "";
["wiPrice", "wiDate", "wiTime"].forEach((id) => $("#" + id).addEventListener("input", () => {
  Object.assign(wiState, { price: $("#wiPrice").value, date: $("#wiDate").value, time: $("#wiTime").value });
  localStorage.setItem("whatIf", JSON.stringify(wiState)); drawCompare();
}));
$("#wiClear").onclick = () => { ["wiPrice", "wiDate", "wiTime"].forEach((id) => ($("#" + id).value = "")); for (const k in wiState) delete wiState[k]; localStorage.removeItem("whatIf"); drawCompare(); };
$("#wiTable").addEventListener("change", (e) => {
  const s = e.target.dataset.beta; if (!s) return;
  const v = parseFloat(e.target.value);
  if (isNaN(v)) delete betaOverride[s]; else betaOverride[s] = v;
  localStorage.setItem("betaOverride", JSON.stringify(betaOverride)); e.target.blur(); drawCompare();
});
$("#wiTable").addEventListener("click", (e) => {
  const s = e.target.dataset?.reset; if (!s) return;
  delete betaOverride[s]; localStorage.setItem("betaOverride", JSON.stringify(betaOverride)); drawCompare();
});

(async () => {
  chartDefaults();
  loadLots();
  renderAll();
  await refresh();
  setInterval(() => refresh(), 60000);
})();
