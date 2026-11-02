const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const START = "2026-10-05";
const OWNERS = ["me", "gf"];
const COLORS = { me: "#4f8cff", gf: "#ec4899", bench: "#f59e0b", eu: "#a78bfa" };
const BENCH = "QQQ", GLOBAL = "VT";
const state = {
  lots: [], quotes: {}, fx: {}, rows: {}, about: {},
  base: "USD",
  sort: { k: "valueBase", dir: -1 },
  selected: null, editId: null,
  hidden: JSON.parse(localStorage.getItem("hiddenLines2") || "{}"),
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
const isSell = (l) => l.side === "sell";
const byWhen = (a, b) => lotWhen(a).localeCompare(lotWhen(b)) || isSell(a) - isSell(b);
// Match sells to the oldest buys first. left: shares of each buy still held; cost: buy cost of the shares each sell used up.
function fifo(lots) {
  const left = new Map(), cost = new Map(), open = [];
  for (const l of [...lots].sort(byWhen)) {
    if (!isSell(l)) { left.set(l, l.shares); open.push(l); continue; }
    let n = l.shares, c = 0;
    while (n > 1e-9 && open.length) { const b = open[0], k = Math.min(n, left.get(b)); left.set(b, left.get(b) - k); n -= k; c += k * b.price; if (left.get(b) <= 1e-9) open.shift(); }
    cost.set(l, c);
  }
  return { left, cost };
}

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
  const lot = { symbol: String(b.symbol || "").trim().toUpperCase(), shares: +b.shares, price: +b.price, date: String(b.date || ""), time: /^\d\d:\d\d$/.test(b.time || "") ? b.time : "", owner: ownerOf(b), ...(b.side === "sell" ? { side: "sell" } : {}) };
  if (!lot.symbol || !(lot.shares > 0) || !(lot.price >= 0)) throw new Error("Please enter a ticker, shares and price");
  return lot;
}

async function loadQuotes() {
  const syms = [...new Set(state.lots.map((l) => l.symbol))];
  const need = syms.filter((x) => !(x in state.about));
  const aboutP = need.length ? api("/api/about?symbols=" + encodeURIComponent(need.join(","))).then((a) => Object.assign(state.about, a)).catch(() => {}) : null;
  state.quotes = syms.length ? await api("/api/quotes?symbols=" + encodeURIComponent(syms.join(","))) : {};
  await aboutP;
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
    const f = fifo(lots), buys = lots.filter((l) => !isSell(l)), sells = lots.filter(isSell);
    let shares = buys.reduce((s, l) => s + f.left.get(l), 0);
    if (shares < 1e-9) shares = 0;
    const cost = buys.reduce((s, l) => s + f.left.get(l) * l.price, 0);
    const bought = buys.reduce((s, l) => s + l.shares * l.price, 0);
    const proceeds = sells.reduce((s, l) => s + l.shares * l.price, 0);
    const realized = proceeds - sells.reduce((s, l) => s + f.cost.get(l), 0);
    const value = !shares ? 0 : q.price != null ? shares * q.price : null;
    const gain = value != null ? value - cost + realized : null;
    const dayChange = q.price != null && q.previousClose ? shares * (q.price - q.previousClose) : null;
    return {
      symbol, lots, fifo: f, q, cur, shares, cost, value, gain, realized, soldOut: !shares,
      name: q.name || symbol,
      avg: shares ? cost / shares : null, price: q.price,
      dayPct: q.previousClose ? (q.price / q.previousClose - 1) * 100 : null,
      retPct: gain != null && bought ? (gain / bought) * 100 : null,
      costBase: fx != null ? cost * fx : null,
      boughtBase: fx != null ? bought * fx : null,
      proceedsBase: fx != null ? proceeds * fx : null,
      valueBase: value != null && fx != null ? value * fx : null,
      gainBase: gain != null && fx != null ? gain * fx : null,
      dayBase: dayChange != null && fx != null ? dayChange * fx : null,
      error: q.error,
    };
  });
  const { k, dir } = state.sort;
  rows.sort((a, b) => {
    if (a.soldOut !== b.soldOut) return a.soldOut - b.soldOut;
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
  const ok = rows.filter((r) => r.valueBase != null);
  const cost = ok.reduce((s, r) => s + r.boughtBase, 0), sold = ok.reduce((s, r) => s + r.proceedsBase, 0);
  const day = rows.reduce((s, r) => s + (r.dayBase || 0), 0), gain = value + sold - cost;
  box.querySelector(".totals").innerHTML = rows.length ? `
    <span>Value<b>${money(value, B)}</b></span>
    <span>Invested<b>${money(cost, B)}</b></span>${sold ? `
    <span>Sold for<b>${money(sold, B)}</b></span>` : ""}
    <span>Gain / loss<b class="${cls(gain)}">${signed(gain, B)} <small>${cost ? pct((gain / cost) * 100) : ""}</small></b></span>
    <span>Today<b class="${cls(day)}">${signed(day, B)}</b></span>` : "";
  box.querySelector(".empty").classList.toggle("hidden", rows.length > 0);
  const tb = box.querySelector("tbody");
  tb.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.soldOut) tr.className = "soldout";
    tr.innerHTML = `
      <td><div class="sym">${esc(r.symbol)}</div><div class="name" title="${esc(r.name)}">${r.error ? '<span class="down">Price unavailable</span>' : esc(r.name)}</div>${state.about[r.symbol] ? `<div class="about">${esc(state.about[r.symbol])}</div>` : ""}</td>
      <td class="num">${r.soldOut ? "–" : num(r.shares)}</td>
      <td class="num">${money(r.avg, r.cur)}</td>
      <td class="num"><b>${money(r.price, r.cur)}</b><div class="small ${cls(r.dayPct)}">${pct(r.dayPct)}</div></td>
      <td class="num">${r.soldOut ? '<span class="muted">Sold</span>' : `<b>${money(r.valueBase, B)}</b>`}</td>
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
  const sorted = [...r.lots].sort(byWhen);
  for (const l of sorted) {
    const sell = isSell(l), left = sell ? 0 : r.fifo.left.get(l);
    const cost = sell ? r.fifo.cost.get(l) : left * l.price;
    const val = sell ? l.shares * l.price : r.price != null ? left * r.price : null;
    const g = val != null ? val - cost : null, p = g != null && cost ? (g / cost) * 100 : null;
    const sharesCell = sell ? `<span class="tag sell">Sold</span> ${num(l.shares)}`
      : left < l.shares - 1e-9 ? `${num(l.shares)}<div class="small muted">${left > 1e-9 ? num(left) + " left" : "all sold"}</div>` : num(l.shares);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(l.date || "–")}${l.time ? ` <span class="muted">${esc(l.time)}</span>` : ""}</td><td class="num">${sharesCell}</td><td class="num">${money(l.price, r.cur)}</td>
      <td class="num">${sell ? '<span class="muted small">cost</span> ' : ""}${money(cost, r.cur)}</td><td class="num">${sell ? '<span class="muted small">got</span> ' : ""}${money(val, r.cur)}</td>
      <td class="num ${cls(g)}">${signed(g, r.cur)}</td><td class="num"><span class="pill ${cls(p)}">${pct(p)}</span></td>
      <td class="num"><button class="icon" data-edit="${l.id}" title="Edit">&#9998;</button><button class="icon" data-del="${l.id}" title="Delete">&#x2715;</button></td>`;
    tb.appendChild(tr);
  }
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><b>Total</b></td><td class="num"><b>${r.soldOut ? "–" : num(r.shares)}</b></td><td class="num"><b>${money(r.avg, r.cur)}</b> <span class="muted small">avg</span></td>
    <td class="num"><b>${money(r.cost, r.cur)}</b></td><td class="num"><b>${money(r.value, r.cur)}</b></td>
    <td class="num ${cls(r.gain)}"><b>${signed(r.gain, r.cur)}</b></td><td class="num"><span class="pill ${cls(r.retPct)}">${pct(r.retPct)}</span></td>
    <td class="num"><button class="icon" data-addfor="${esc(r.symbol)}" title="Add a buy">+ Buy</button>${r.soldOut ? "" : `<button class="icon" data-sellfor="${esc(r.symbol)}" title="Add a sale">Sell</button>`}</td>`;
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

function setSideUi() {
  const sell = $("#fSide").value === "sell";
  $("#lotDialogTitle").textContent = (state.editId ? "Edit " : "Add ") + (sell ? "sale" : "purchase");
  $("#fDateLbl").textContent = sell ? "Sale date" : "Purchase date";
}
$("#fSide").onchange = setSideUi;
function openDialog(lot = null, symbol = "", owner = null, side = "buy") {
  OWNERS.forEach((o) => ($(`#fOwner option[value=${o}]`).textContent = state.names[o]));
  $("#fOwner").value = lot ? ownerOf(lot) : owner || localStorage.getItem("lastOwner") || "me";
  state.editId = lot ? lot.id : null;
  $("#fSide").value = lot ? (isSell(lot) ? "sell" : "buy") : side;
  setSideUi();
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
  try { lot = cleanLot({ symbol: $("#fSymbol").value, shares: $("#fShares").value, price: $("#fPrice").value, date: $("#fDate").value, time: $("#fTime").value, owner: $("#fOwner").value, side: $("#fSide").value });
  if (isSell(lot)) {
    const others = state.lots.filter((l) => l.id !== state.editId && l.symbol === lot.symbol && ownerOf(l) === lot.owner);
    const when = lotWhen(lot), before = others.filter((l) => lotWhen(l) <= when);
    const held = before.reduce((s, l) => s + (isSell(l) ? -l.shares : l.shares), 0);
    if (lot.shares > held + 1e-9) throw new Error(`${state.names[lot.owner]} only held ${num(Math.max(0, held))} ${lot.symbol} shares on that date`);
  }
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
  if (b.dataset.sellfor) openDialog(null, b.dataset.sellfor, state.selected?.o, "sell");
  if (b.dataset.del && confirm(isSell(state.lots.find((l) => l.id === b.dataset.del) || {}) ? "Delete this sale?" : "Delete this purchase?")) {
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
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const key = (l) => [l.symbol, l.shares, l.price, l.date, l.time, ownerOf(l), isSell(l) ? "sell" : ""].join("|");
    const have = new Set(state.lots.map(key));
    const add = JSON.parse(await f.text()).map(cleanLot).filter((l) => !have.has(key(l)) && have.add(key(l)));
    const skipped = add.length ? "" : " (all were already there)";
    if (!confirm(`Add ${add.length} trade${add.length === 1 ? "" : "s"} to your holdings?${skipped}`) || !add.length) return;
    state.lots = [...state.lots, ...add.map((l) => ({ ...l, id: newId() }))];
    saveLots(); loadLots(); await refresh();
  }
  catch (err) { alert("Import failed: " + err.message); }
};
// ---- Return since START: me vs girlfriend vs QQQ ----
const cmp = { seq: 0, data: null };

function ffill(points, keys) {
  const out = []; let j = 0, last = null;
  for (const k of keys) { while (j < points.length && points[j][0] <= k) last = points[j++][1]; out.push(last); }
  return out;
}

function chartStart() {
  return { when: START + "T00:00", lot: null };
}

async function renderCompare() {
  const seq = ++cmp.seq;
  const start = chartStart(), startDay = start.when.slice(0, 10);
  const syms = [...new Set(state.lots.map((l) => l.symbol))];
  const get = (s) => api(`/api/history?symbol=${encodeURIComponent(s)}&start=${startDay}`).catch(() => null);
  const [bench, glob, ...hs] = await Promise.all([BENCH, GLOBAL, ...syms].map(get));
  if (seq !== cmp.seq) return;
  if (!bench || !bench.points.length) { $("#cmpNote").textContent = `Couldn't load ${BENCH} prices.`; return; }
  const H = {}; syms.forEach((s, i) => (H[s] = hs[i]?.points || []));
  const keys = bench.points.map((p) => p[0]).filter((t) => localWhen(t) >= start.when);
  if (!keys.length) { $("#cmpNote").textContent = `No ${BENCH} prices yet after the chart start.`; return; }
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
        const after = l.date && lotWhen(l) >= start.when, basis = after ? l.price : firstPx[l.symbol];
        if (p == null || f == null || basis == null) continue;
        // A sale swaps the shares for cash; one before the start just means fewer shares were held at the start.
        if (isSell(l)) { v -= l.shares * (p - (after ? l.price : 0)) * f; if (!after) c -= l.shares * basis * f; continue; }
        v += l.shares * p * f; c += l.shares * basis * f;
      }
      return c > 0 ? (v / c - 1) * 100 : null;
    });
  };
  const b0 = bpx.find((p) => p != null);
  const gp = glob?.points || [], g0 = gp.find((p) => localWhen(p[0]) >= start.when)?.[1];
  const eu = ffill(gp, keys).map((p) => (p != null && g0 ? (p / g0 - 1) * 100 : null));
  const sd = new Date(start.when);
  $("#startLbl").textContent = sd.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    (start.lot?.time ? ", " + start.lot.time : "") + (start.lot ? ` (first ${start.lot.symbol} order)` : " (market top)");
  await Promise.all([loadBetas(allSyms()), loadWi()]);
  if (seq !== cmp.seq) return;
  cmp.data = { keys, b0, bLast: [...bpx].reverse().find((p) => p != null), me: line("me"), gf: line("gf"), bench: bpx.map((p) => (p != null && b0 ? (p / b0 - 1) * 100 : null)), eu };
  drawCompare();
}

function drawCompare() {
  const d = cmp.data; if (!d) return;
  const last = (a) => [...a].reverse().find((x) => x != null);
  const series = [
    { key: "me", label: state.names.me, color: COLORS.me },
    { key: "gf", label: state.names.gf, color: COLORS.gf },
    { key: "bench", label: BENCH, color: COLORS.bench },
    { key: "eu", label: "Eunan", color: COLORS.eu },
  ].filter((s) => d[s.key].some((x) => x != null));
  const shown = series.filter((s) => !state.hidden[s.key]);
  $("#cmpSummary").innerHTML = shown.map((s) => { const r = last(d[s.key]);
    return `<span><span class="dot" style="background:${s.color}"></span>${esc(s.label)}<b class="${cls(r)}">${pct(r)}</b></span>`; }).join("");
  $("#cmpNote").textContent = `Return on the money put in, in each stock's own currency. ${BENCH} measured from its first price after the start. Buying more doesn't count as a gain.`;
  const span = d.keys.length ? (d.keys[d.keys.length - 1] - d.keys[0]) / 86400 : 0;
  const fmt = (t) => new Date(t * 1000).toLocaleString(undefined, span < 20 ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });
  const labels = d.keys.map(fmt);
  const datasets = series.map((s) => ({ hidden: !!state.hidden[s.key], label: s.label, data: [...d[s.key]], borderColor: s.color, backgroundColor: s.color, pointRadius: 0, borderWidth: s.key === "bench" || s.key === "eu" ? 2 : 2.5, tension: 0.15, spanGaps: true }));
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
    if (wi.benchRet != null) proj("bench", wi.benchLabel || `${BENCH} target`, COLORS.bench, wi.benchRet);
    for (const o of ["me", "gf"]) if (wi.ret[o] != null && !state.hidden[o]) proj(o, `${state.names[o]} implied`, COLORS[o], wi.ret[o]);
  }
  charts.cmp?.destroy();
  charts.cmp = new Chart($("#cmpChart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { usePointStyle: true, pointStyle: "line", filter: (item) => item.datasetIndex < series.length },
        onClick: (_, item) => { if (item.datasetIndex >= series.length) return; const k = series[item.datasetIndex].key; state.hidden[k] = !state.hidden[k]; localStorage.setItem("hiddenLines2", JSON.stringify(state.hidden)); drawCompare(); } }, tooltip: { filter: (c) => c.raw != null, callbacks: { label: (c) => ` ${c.dataset.label}: ${pct(c.raw)}` } } },
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

const wiMode = () => (["recovery", "targets"].includes(wiState.mode) ? wiState.mode : "beta");
const qqqSrc = () => (/^\d+$/.test(wiState.qsrc || "") ? "banks" : wiState.qsrc === "banks" ? "banks" : "price");
const myQqq = () => (+wiState.price > 0 ? +wiState.price : null);
const targetWhen = () => (wiState.date ? `${wiState.date}T${wiState.time || "22:00"}` : null);
const fmtDay = (day) => new Date(day + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const recoverTo = (now, peak) => (peak == null || now == null ? null : now + (recPct() / 100) * (Math.max(peak, now) - now));

// QQQ target, shared by all methods: own price, drawdown-recovery rule, or a bank's S&P 500 target via beta.
function qqqTarget(d) {
  const src = qqqSrc(), now = d.bLast;
  const imp = src === "price" ? myQqq() : bankAvg() * SPX_TO_QQQ, label = src === "price" ? `${BENCH} target` : `${BENCH} (bank avg)`;
  const line = imp ? `${BENCH} ${money(now, "USD")} → <b>${money(imp, "USD")}</b> = <b class="${cls(imp - now)}">${pct((imp / now - 1) * 100)}</b>`
    : `${BENCH}: <span class="muted">type a QQQ price above</span>`;
  return { imp, line, label };
}

function whatIf(d) {
  const mode = wiMode(), src = qqqSrc();
  $$("#wiMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $$(".whatif [data-for]").forEach((el) => el.classList.toggle("hidden", el.dataset.for === "price" ? src !== "price" : mode !== "recovery"));
  $("#wiQqq").value = src;
  $("#wiNow").textContent = d.bLast ? `(now ${money(d.bLast, "USD")})` : "";
  if (!d.bLast) return null;
  const q = qqqTarget(d), B = state.base, method = mode === "recovery" ? whatIfRecovery : mode === "targets" ? whatIfTargets : whatIfBeta;
  const out = [q.line], missing = new Set(), ret = {}, all = {};
  for (const o of ["me", "gf"]) for (const r of (state.rows[o] || []).filter((r) => r.valueBase != null && !r.soldOut))
    all[r.symbol] = all[r.symbol] ? { ...all[r.symbol], valueBase: all[r.symbol].valueBase + r.valueBase } : { ...r };
  const allRows = Object.values(all).sort((x, y) => y.valueBase - x.valueBase);
  const table = allRows.length ? method(d, allRows, allRows.reduce((a, r) => a + r.valueBase, 0), q) : null;
  const res_rows = [];
  for (const o of ["me", "gf"]) {
    const rows = (state.rows[o] || []).filter((r) => r.valueBase != null && !r.soldOut);
    if (!rows.length) continue;
    const total = rows.reduce((a, r) => a + r.valueBase, 0), name = `<span class="dot" style="background:${COLORS[o]}"></span>${esc(state.names[o])}`;
    const res = method(d, rows, total, q);
    if (!res) { res_rows.push(`<tr><td>${name}</td><td class="num">${money(total, B)}</td><td colspan="3" class="muted">set a QQQ target above</td></tr>`); continue; }
    const last = [...d[o]].reverse().find((x) => x != null);
    ret[o] = last != null ? ((1 + last / 100) * (1 + res.pm) - 1) * 100 : null;
    res.missing.forEach((m) => missing.add(m));
    res_rows.push(`<tr><td>${name}${res.extra ? `<div class="small muted">${res.extra.replace(/^\s*\(|\)\s*$/g, "")}</div>` : ""}</td><td class="num">${money(total, B)}</td><td class="num"><b>${money(total * (1 + res.pm), B)}</b></td>
      <td class="num ${cls(res.pm)}">${signed(total * res.pm, B)}</td><td class="num"><span class="pill ${cls(res.pm)}">${pct(res.pm * 100)}</span></td></tr>`);
  }
  if (res_rows.length) out.push(`<div class="table-wrap"><table class="holdings wi-res"><thead><tr><th>Portfolio</th><th class="num">Today</th><th class="num">If it plays out</th><th class="num">Gain</th><th class="num">Move</th></tr></thead><tbody>${res_rows.join("")}</tbody></table></div>`);
  $("#wiOut").innerHTML = out.join("");
  $("#wiTable").classList.toggle("hidden", !table);
  if (table) {
    $("#wiTable thead").innerHTML = table.head;
    if (!$("#wiTable").contains(document.activeElement)) $("#wiTable tbody").innerHTML = table.body;
  }
  $("#wiNote").textContent = missing.size ? `No data for ${[...missing].join(", ")}, so left out.` : "";
  if (!q.imp && !Object.keys(ret).length) return null;
  return { benchRet: q.imp && d.b0 ? (q.imp / d.b0 - 1) * 100 : null, benchLabel: q.label, ret, when: targetWhen() };
}

// Drawdown recovery: each stock takes back X% of its drop from its high since a date.
const PEAK_START = "2026-10-01";
const peaks = {};
const recFrom = () => wiState.peakFrom || PEAK_START;
const recPct = () => (wiState.rec === undefined || wiState.rec === "" ? 30 : +wiState.rec);
async function loadPeaks(syms, from) {
  const need = syms.filter((s) => !(`${s}|${from}` in peaks));
  if (!need.length) return;
  const hs = await Promise.all(need.map((s) => api(`/api/history?symbol=${encodeURIComponent(s)}&start=${from}`).catch(() => null)));
  need.forEach((s, i) => {
    const ps = (hs[i]?.points || []).filter((p) => localDay(p[0]) >= from && p[1] != null).map((p) => p[1]);
    peaks[`${s}|${from}`] = ps.length ? Math.max(...ps) : null;
  });
}
const allSyms = () => [...new Set(state.lots.map((l) => l.symbol))];

function whatIfRecovery(d, rows, total) {
  const from = recFrom(), fromLbl = fmtDay(from);
  let pm = 0, missing = [];
  const info = rows.map((r) => {
    const peak = peaks[`${r.symbol}|${from}`], ip = recoverTo(r.price, peak), mv = ip != null ? ip / r.price - 1 : null;
    if (mv == null) missing.push(r.symbol); else pm += (r.valueBase / total) * mv;
    return { r, peak, ip, mv, dd: peak ? r.price / Math.max(peak, r.price) - 1 : null };
  });
  const head = `<tr><th>Stock</th><th class="num">High since ${esc(fromLbl)}</th><th class="num">Drawdown</th><th class="num">Price now</th><th class="num">Implied price</th><th class="num">Move</th></tr>`;
  const body = info.map(({ r, peak, ip, mv, dd }) => `<tr><td><div class="sym">${esc(r.symbol)}</div></td>
    <td class="num">${money(peak, r.cur)}</td><td class="num ${cls(dd)}">${dd != null ? pct(dd * 100) : "–"}</td><td class="num">${money(r.price, r.cur)}</td>
    <td class="num"><b>${money(ip, r.cur)}</b></td><td class="num ${cls(mv)}">${mv != null ? pct(mv * 100) : "–"}</td></tr>`).join("");
  return { pm, missing, head, body, cols: 7 };
}

// Price targets: each stock -> analyst consensus or own target; QQQ -> own price or bank S&P 500 target.
// Year-end 2026 S&P 500 targets (Reuters factbox 6 Oct 2026; Bloomberg survey 26 Oct 2026).
// Year-end 2026 S&P 500 targets: [bank, target, date of latest note setting or restating it].
const BANKS = [["BofA", 7400, "2026-09-14"], ["Goldman Sachs", 8000, "2026-10-19"], ["Morgan Stanley", 8000, "2026-10-26"],
  ["J.P. Morgan", 8000, "2026-08-10"], ["Citigroup", 8100, "2026-10-28"], ["UBS", 8100, "2026-09-15"],
  ["Deutsche Bank", 8000, "2026-09-18"], ["Jefferies", 8000, "2026-09-16"], ["Barclays", 7950, "2026-09-09"]];
const BANK_SINCE = "2026-09-01";
const SPX_TO_QQQ = 760 / 8000;
const banksUsed = () => BANKS.filter((b) => b[2] >= BANK_SINCE);
const bankAvg = () => { const u = banksUsed(); return u.reduce((a, b) => a + b[1], 0) / u.length; };
const analyst = {};
async function loadTargets(syms) {
  const need = syms.filter((s) => !(s in analyst));
  if (need.length) await api(`/api/targets?symbols=${need.map(encodeURIComponent).join(",")}`).then((r) => need.forEach((s) => (analyst[s] = r[s] || null))).catch(() => {});
}
function betaFrom(pts, ref) {
  const rets = (p) => { const m = {}; for (let i = 1; i < p.length; i++) m[localDay(p[i][0])] = p[i][1] / p[i - 1][1] - 1; return m; };
  const a = rets(pts), b = rets(ref), days = Object.keys(a).filter((k) => k in b);
  if (days.length < 30) return null;
  const mb = days.reduce((s, k) => s + b[k], 0) / days.length, ma = days.reduce((s, k) => s + a[k], 0) / days.length;
  let cov = 0, v = 0; for (const k of days) { cov += (b[k] - mb) * (a[k] - ma); v += (b[k] - mb) ** 2; }
  return v ? cov / v : null;
}

function whatIfTargets(d, rows, total) {
  const tg = (wiState.tgt ||= {});
  let pm = 0, missing = [];
  const info = rows.map((r) => {
    const a = analyst[r.symbol], t = tg[r.symbol] || {}, mine = t.src === "mine";
    const tp = mine ? (+t.price > 0 ? +t.price : null) : a?.mean ?? null, mv = tp != null && r.price ? tp / r.price - 1 : null;
    if (mv == null) missing.push(r.symbol); else pm += (r.valueBase / total) * mv;
    return { r, a, mine, t, tp, mv };
  });
  const head = `<tr><th>Stock</th><th class="num">Price now</th><th class="num">Consensus</th><th>Use</th><th class="num">Target</th><th class="num">Move</th></tr>`;
  const body = info.map(({ r, a, mine, t, tp, mv }) => `<tr><td><div class="sym">${esc(r.symbol)}</div></td>
      <td class="num">${money(r.price, r.cur)}</td>
      <td class="num">${a ? `<span title="Range ${money(a.low, r.cur)}–${money(a.high, r.cur)}">${money(a.mean, r.cur)}</span><div class="small muted">${a.n} analysts</div>` : '<span class="muted">none</span>'}</td>
      <td><select data-src="${esc(r.symbol)}"><option value="consensus"${mine ? "" : " selected"}>Consensus</option><option value="mine"${mine ? " selected" : ""}>My target</option></select></td>
      <td class="num">${mine ? `<input class="tgt" type="number" step="any" min="0" data-tgt="${esc(r.symbol)}" value="${t.price ?? ""}">` : `<b>${money(tp, r.cur)}</b>`}</td>
      <td class="num ${cls(mv)}">${mv != null ? pct(mv * 100) : "–"}</td></tr>`).join("");
  return { pm, missing, head, body, cols: 7 };
}

function whatIfBeta(d, rows, total, q) {
  if (!q.imp) return null;
  const m = q.imp / d.bLast - 1;
  const head = `<tr><th>Stock</th><th class="num">Beta vs QQQ</th><th class="num">Implied move</th><th class="num">Price now</th><th class="num">Implied price</th></tr>`;
  let pm = 0, wb = 0, missing = [];
  for (const r of rows) { const b = betaOf(r.symbol); if (b == null) { missing.push(r.symbol); continue; } pm += (r.valueBase / total) * b * m; wb += (r.valueBase / total) * b; }
  const body = rows.map((r) => { const b = betaOf(r.symbol), sm = b != null ? b * m : null;
      return `<tr><td><div class="sym">${esc(r.symbol)}</div></td>
        <td class="num"><input type="number" step="0.01" data-beta="${esc(r.symbol)}" value="${b != null ? b.toFixed(2) : ""}" title="${betaOverride[r.symbol] != null ? "Your value" : "Measured from daily prices since 1 Jan 2023"}">${betaOverride[r.symbol] != null ? ' <button class="icon" data-reset="' + esc(r.symbol) + '" title="Use measured beta">↺</button>' : ""}</td>
        <td class="num ${cls(sm)}">${sm != null ? pct(sm * 100) : "–"}</td><td class="num">${money(r.price, r.cur)}</td>
        <td class="num"><b>${sm != null && r.price != null ? money(r.price * (1 + sm), r.cur) : "–"}</b></td></tr>`; }).join("");
  return { pm, missing, head, body, cols: 6, extra: ` (beta ${wb.toFixed(2)})` };
}

const WI = { wiPrice: "price", wiDate: "date", wiTime: "time", wiRec: "rec", wiPeak: "peakFrom" };
const fillWi = () => { for (const id in WI) $("#" + id).value = wiState[WI[id]] ?? ""; $("#wiRec").value = recPct(); $("#wiPeak").value = recFrom(); };
const saveWi = () => localStorage.setItem("whatIf", JSON.stringify(wiState));
const loadWi = () => {
  const mode = wiMode(), src = qqqSrc(), pk = [];
  if (mode === "recovery") pk.push(...allSyms());
  return Promise.all([pk.length ? loadPeaks(pk, recFrom()) : null, mode === "targets" ? loadTargets(allSyms()) : null]);
};
async function redrawWi() {
  drawCompare(); await loadWi(); drawCompare();
}
$("#wiQqq").addEventListener("change", (e) => {
  const v = (wiState.qsrc = e.target.value);
  if (v === "banks" && !wiState.date) { wiState.date = new Date().getFullYear() + "-12-31"; $("#wiDate").value = wiState.date; }
  saveWi(); redrawWi();
});
fillWi();
Object.keys(WI).forEach((id) => $("#" + id).addEventListener("input", () => { wiState[WI[id]] = $("#" + id).value; saveWi(); redrawWi(); }));
$("#wiMode").addEventListener("click", (e) => { const m = e.target.dataset?.mode; if (!m) return; wiState.mode = m; saveWi(); redrawWi(); });
$("#wiClear").onclick = () => { const { mode, tgt, qsrc } = wiState; for (const k in wiState) delete wiState[k]; Object.assign(wiState, mode ? { mode } : {}, tgt ? { tgt } : {}, qsrc ? { qsrc } : {}); saveWi(); fillWi(); drawCompare(); };
$("#wiTable").addEventListener("change", (e) => {
  const { src, tgt } = e.target.dataset;
  if (src || tgt) {
    const tg = (wiState.tgt ||= {}), sym = src || tgt, t = (tg[sym] ||= {});
    if (src) { t.src = e.target.value; if (src && t.src === "mine" && !(+t.price > 0)) t.price = analyst[sym]?.mean ? +analyst[sym].mean.toFixed(2) : ""; }
    else t.price = e.target.value;
    saveWi(); e.target.blur(); drawCompare(); return;
  }
  const s = e.target.dataset.beta; if (!s) return;
  const v = parseFloat(e.target.value);
  if (isNaN(v)) delete betaOverride[s]; else betaOverride[s] = v;
  localStorage.setItem("betaOverride", JSON.stringify(betaOverride)); e.target.blur(); drawCompare();
});
$("#wiTable").addEventListener("click", (e) => {
  const s = e.target.dataset?.reset; if (!s) return;
  delete betaOverride[s]; localStorage.setItem("betaOverride", JSON.stringify(betaOverride)); drawCompare();
});

// ---- Share link: holdings packed (deflate + base64url) into the URL fragment, never sent to the server ----
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
async function shareLink() {
  const data = { n: state.names, l: state.lots.filter((l) => !l.sample).map((l) => [l.symbol, l.shares, l.price, l.date || "", l.time || "", ownerOf(l), ...(isSell(l) ? ["sell"] : [])]) };
  const json = new TextEncoder().encode(JSON.stringify(data));
  const code = window.CompressionStream ? "z" + b64u(await pipe(json, new CompressionStream("deflate-raw"))) : "j" + b64u(json);
  return `${location.origin}${location.pathname}#s=${code}`;
}
async function readShared() {
  const m = location.hash.match(/^#s=([zj])([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    let bytes = unb64u(m[2]);
    if (m[1] === "z") bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const lots = data.l.map(([symbol, shares, price, date, time, owner, side]) => ({ ...cleanLot({ symbol, shares, price, date, time, owner, side }), id: newId() }));
    const mine = state.lots.filter((l) => !l.sample).length;
    if (mine && !confirm(`Load the shared portfolio (${lots.length} trades)? It replaces the ${mine} trade${mine === 1 ? "" : "s"} saved in this browser.`)) return;
    state.lots = lots; saveLots();
    if (data.n) { state.names = { ...state.names, ...data.n }; localStorage.setItem("names", JSON.stringify(state.names)); }
    loadLots();
  } catch (err) { alert("Couldn't read the shared link: " + err.message); }
}
$("#shareBtn").onclick = async () => {
  const url = await shareLink(), btn = $("#shareBtn");
  if (navigator.share && matchMedia("(pointer: coarse)").matches) { try { await navigator.share({ title: "Our Portfolio", url }); } catch {} return; }
  try { await navigator.clipboard.writeText(url); btn.textContent = "Link copied ✓"; }
  catch { prompt("Copy this link:", url); }
  setTimeout(() => (btn.textContent = "Share"), 2500);
};

// ---- Suggestions: top 5 per bucket by upside to recent analyst targets ----
async function loadSuggest() {
  const b = $("#sgBucket").value, tb = $("#sgTable tbody");
  localStorage.setItem("sgBucket", b);
  tb.innerHTML = `<tr><td colspan="14" class="muted">Loading…</td></tr>`; $("#sgNote").textContent = "";
  try {
    const d = await api("/api/suggest?bucket=" + b);
    if ($("#sgBucket").value !== b) return;
    const ys = [...d.years].sort(), sep = ' class="num grp"';
    const lbl = (y) => `1 Jan ${String(y).slice(2)}`;
    $("#sgTable thead").innerHTML = `<tr><th rowspan="2">Stock</th><th rowspan="2" class="num">Upside</th><th rowspan="2" class="num">Off year high</th><th rowspan="2" class="num">1 week</th>
      <th colspan="${ys.length + 1}"${sep}>Price</th><th colspan="${ys.length + 1}"${sep}>Avg target</th><th colspan="${ys.length + 2}"${sep}>Revenue / EPS (12 months)</th></tr>
      <tr>${[0, 1, 2].map((g) => ys.map((y, i) => `<th${i ? ' class="num"' : sep}>${lbl(y)}</th>`).join("") + `<th class="num">Today</th>` + (g === 2 ? `<th class="num" title="Analyst consensus for the next 12 months">1Y fwd</th>` : "")).join("")}</tr>`;
    const up = (a, b) => a != null && b != null ? cls(b - a) : "";
    const cell = (v, prev, cur, first) => `<td${first ? sep : ' class="num"'}><span class="${up(prev, v)}">${v == null ? "–" : money(v, cur)}</span></td>`;
    tb.innerHTML = d.top.map((r) => {
      const pts = [...ys.map((y) => r.past[y] || {}), { price: r.price, target: r.target, n: r.n }];
      const prices = pts.map((p, i) => cell(p.price, pts[i - 1]?.price, r.currency, !i)).join("");
      const tgts = pts.map((p, i) => p.target == null && p.price != null
        ? `<td${i ? ' class="num"' : sep}>–<div class="small muted">only ${p.n} analysts</div></td>`
        : cell(p.target, pts[i - 1]?.target, r.currency, !i)).join("");
      const fs = [...ys.map((y) => r.fund?.[y] || {}), r.fund?.now || {}, { ...r.fwd, end: "fwd" }];
      const big = (v) => v == null ? "–" : (v < 0 ? "-$" : "$") + (Math.abs(v) >= 1e9 ? (Math.abs(v) / 1e9).toFixed(1) + "B" : (Math.abs(v) / 1e6).toFixed(0) + "M");
      const eps = (v) => v == null ? "–" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
      const fwd = fs.map((f, i) => `<td${i ? ' class="num"' : sep}${f.end ? ` title="${f.end === "fwd" ? "Analyst consensus, next 12 months" : "12 months to " + esc(f.end)}"` : ""}>
        <div class="${up(fs[i - 1]?.rev, f.rev)}">${big(f.rev)}</div>
        <div class="small ${up(fs[i - 1]?.eps, f.eps) || "muted"}">${eps(f.eps)}</div></td>`).join("");
      return `<tr>
      <td><div class="sym">${esc(r.symbol)}</div><div class="name" title="${esc(r.name)}">${esc(r.name)}</div>${r.about ? `<div class="about">${esc(r.about)}</div>` : ""}</td>
      <td class="num"><span class="pill ${cls(r.upside)}">${pct(r.upside)}</span></td>
      <td class="num ${cls(r.offHigh)}">${pct(r.offHigh)}</td>
      <td class="num ${cls(r.week)}">${pct(r.week)}</td>${prices}${tgts}${fwd}</tr>`;
    }).join("") || `<tr><td colspan="14" class="muted">No stocks qualify right now.</td></tr>`;
    $("#sgNote").textContent = `Average of each analyst's latest target since ${fmtDay(d.since)} (min ${d.min} analysts) · ${d.qualified} of ${d.checked} stocks qualify · 1 Jan: open on the first trading day, and targets set from 1 Sep to 1 Jan · Revenue (top) and diluted EPS (bottom) from SEC filings, as reported by each date; 1Y fwd: analyst consensus`;
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="14" class="down">Couldn't load suggestions: ${esc(e.message)}</td></tr>`;
  }
}
$("#sgBucket").value = localStorage.getItem("sgBucket") || "ai";
$("#sgBucket").onchange = loadSuggest;

(async () => {
  chartDefaults();
  loadLots();
  await readShared();
  renderAll();
  loadSuggest();
  await refresh();
  setInterval(() => refresh(), 60000);
})();
