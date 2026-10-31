"""Yahoo Finance proxy API (Vercel serverless function; also used by server.py locally)."""
import json
import time
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler

UA = {"User-Agent": "Mozilla/5.0"}  # Yahoo rate-limits fuller browser/python UAs

_cache = {}


def fetch_json(url, ttl):
    now = time.time()
    hit = _cache.get(url)
    if hit and now - hit[0] < ttl:
        return hit[1]
    err = None
    for host in ("query1", "query2"):
        try:
            req = urllib.request.Request(url.replace("query1", host), headers=UA)
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.load(r)
            break
        except Exception as e:  # noqa: BLE001
            err = e
    else:
        if hit:
            return hit[1]
        raise err
    _cache[url] = (now, data)
    return data


def chart(symbol, rng="1d", interval="1d", ttl=30, period1=None, events=""):
    span = "period1=%d&period2=%d" % (period1, int(time.time()) // 60 * 60) if period1 else "range=" + rng
    url = "https://query1.finance.yahoo.com/v8/finance/chart/%s?%s&interval=%s%s" % (
        urllib.parse.quote(symbol), span, interval, "&events=" + events if events else "")
    res = fetch_json(url, ttl)["chart"]["result"][0]
    meta = res["meta"]
    scale = 1.0
    currency = meta.get("currency") or "USD"
    if currency == "GBp":  # London quotes in pence
        currency, scale = "GBP", 0.01
    return res, meta, currency, scale


def quote(symbol):
    try:
        res, meta, currency, scale = chart(symbol, "5d", "1d")
        price = meta.get("regularMarketPrice")
        prev = None
        closes = [c for c in (res.get("indicators", {}).get("quote", [{}])[0].get("close") or []) if c is not None]
        if len(closes) >= 2:
            prev = closes[-2]
        prev = meta.get("previousClose") or prev
        return {
            "symbol": symbol,
            "name": meta.get("longName") or meta.get("shortName") or symbol,
            "currency": currency,
            "price": price * scale if price is not None else None,
            "previousClose": prev * scale if prev else None,
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
            "marketTime": meta.get("regularMarketTime"),
        }
    except Exception as e:  # noqa: BLE001
        return {"symbol": symbol, "error": str(e)}


def history(symbol, rng, start=None):
    period1 = None
    if start:
        period1 = int(time.mktime(time.strptime(start, "%Y-%m-%d"))) - 86400
        days = (time.time() - period1) / 86400
        interval = "5m" if days < 55 else "1h" if days < 700 else "1d"
    else:
        interval = {"1d": "5m", "5d": "30m", "1mo": "1d", "6mo": "1d", "ytd": "1d", "1y": "1d", "5y": "1wk", "max": "1mo"}.get(rng, "1d")
    res, meta, currency, scale = chart(symbol, rng, interval, ttl=120, period1=period1)
    ts = res.get("timestamp") or []
    closes = res.get("indicators", {}).get("quote", [{}])[0].get("close") or []
    pts = [[t, c * scale] for t, c in zip(ts, closes) if c is not None]
    return {"symbol": symbol, "currency": currency, "points": pts}


def search(q):
    url = "https://query1.finance.yahoo.com/v1/finance/search?q=%s&quotesCount=8&newsCount=0" % urllib.parse.quote(q)
    data = fetch_json(url, 300)
    return [
        {"symbol": x["symbol"], "name": x.get("longname") or x.get("shortname") or x["symbol"],
         "exchange": x.get("exchDisp", ""), "type": x.get("typeDisp", "")}
        for x in data.get("quotes", []) if x.get("symbol")
    ]



_crumb = {"t": 0}


def yahoo_auth(force=False):
    """Cookie + crumb needed by Yahoo's quoteSummary endpoint (cached ~1h)."""
    if not force and time.time() - _crumb["t"] < 3600:
        return _crumb["opener"], _crumb["crumb"]
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    try:
        opener.open(urllib.request.Request("https://fc.yahoo.com", headers=UA), timeout=10)
    except Exception:  # noqa: BLE001  (404 still sets the cookie)
        pass
    req = urllib.request.Request("https://query2.finance.yahoo.com/v1/test/getcrumb", headers=UA)
    c = opener.open(req, timeout=10).read().decode()
    _crumb.update(t=time.time(), opener=opener, crumb=c)
    return opener, c


def qsummary(symbol, modules):
    for attempt in (0, 1):
        opener, c = yahoo_auth(force=attempt == 1)
        url = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/%s?modules=%s&crumb=%s" % (
            urllib.parse.quote(symbol), modules, urllib.parse.quote(c))
        try:
            with opener.open(urllib.request.Request(url, headers=UA), timeout=10) as r:
                return json.load(r)["quoteSummary"]["result"][0]
        except Exception:  # noqa: BLE001
            if attempt:
                return None


def targets(symbol):
    """Analyst price targets (mean/median/high/low) from Yahoo financialData."""
    key = "targets:" + symbol
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 6 * 3600:
        return hit[1]
    res = qsummary(symbol, "financialData,price")
    if res is None:
        return None
    fd, pr = res.get("financialData", {}), res.get("price", {})
    raw = lambda k: (fd.get(k) or {}).get("raw")  # noqa: E731
    out = None
    if raw("targetMeanPrice"):
        out = {"mean": raw("targetMeanPrice"), "median": raw("targetMedianPrice"), "high": raw("targetHighPrice"),
               "low": raw("targetLowPrice"), "n": raw("numberOfAnalystOpinions"), "rec": fd.get("recommendationKey"),
               "currency": pr.get("currency")}
    _cache[key] = (time.time(), out)
    return out


BUCKETS = {
    "ai": "NVDA AMD AVGO TSM MU MRVL ANET VRT DELL PLTR QCOM INTC CRWV ORCL MSFT GOOGL META AMZN LRCX AMAT KLAC CEG VST COHR CLS SMCI NBIS ALAB ARM ASML",
    "software": "CRM NOW ADBE INTU WDAY SNOW DDOG CRWD PANW ZS NET MDB TEAM HUBS SHOP FTNT ADSK TTD APP U OKTA DOCU GTLB IOT S CDNS SNPS",
    "financial": "JPM BAC WFC C GS MS SCHW BLK AXP V MA COF PYPL HOOD SOFI KKR BX APO SPGI MCO ICE CME PNC USB TFC ARES COIN AFRM NU",
    "industrials": "GE CAT HON RTX LMT BA UNP UPS ETN NOC WM URI PWR CARR JCI FDX CSX NSC GEV TDG CMI HWM ODFL XYL JBHT CHRW SAIA AAL KTOS AVAV BLDR DAL UAL BWXT MAS",
    "healthcare": "LLY UNH JNJ ABBV MRK PFE TMO ABT DHR ISRG AMGN GILD VRTX REGN BMY MDT SYK BSX CVS CI ELV HCA ZTS MRNA BIIB DXCM IDXX HUM NVO AZN",
}
TARGETS_SINCE = "2026-09-01"
MIN_TARGETS = 10


def ts_of(day):
    return time.mktime(time.strptime(day, "%Y-%m-%d"))


HIST_YEARS = (2026, 2025)


def candidate(symbol):
    """Latest target per analyst firm since TARGETS_SINCE vs today's price, plus % off year high, 1-week return,
    and the same snapshot at the open on 1 Jan of HIST_YEARS (targets from 1 Sep of the year before to 1 Jan).
    Yahoo chart prices are split-adjusted, so targets are adjusted for later splits too."""
    res = qsummary(symbol, "upgradeDowngradeHistory,price")
    if not res:
        return None
    hist = (res.get("upgradeDowngradeHistory") or {}).get("history") or []

    def latest(start, end):
        out = {}
        for h in hist:  # newest first
            t = h.get("epochGradeDate", 0)
            if start <= t < end and h.get("currentPriceTarget") and h["firm"] not in out:
                out[h["firm"]] = (t, h["currentPriceTarget"])
        return out

    now = latest(ts_of(TARGETS_SINCE), time.time())
    if len(now) < MIN_TARGETS:
        return {"symbol": symbol, "n": len(now)}
    ch, meta, currency, scale = chart(symbol, interval="1d", ttl=3600, period1=int(ts_of("%d-09-01" % (min(HIST_YEARS) - 1))), events="split")
    splits = list(((ch.get("events") or {}).get("splits") or {}).values())
    avg = lambda d: sum(v / _prod(s["numerator"] / s["denominator"] for s in splits if s["date"] > t) for t, v in d.values()) / len(d)  # noqa: E731
    q = ch.get("indicators", {}).get("quote", [{}])[0]
    rows = [(t, o * scale, h * scale, c * scale) for t, o, h, c in zip(ch.get("timestamp") or [], q.get("open") or [], q.get("high") or [], q.get("close") or [])
            if None not in (o, h, c)]
    price = (meta.get("regularMarketPrice") or 0) * scale or (rows[-1][3] if rows else None)
    if not price:
        return None
    ytd = [r for r in rows if r[0] >= ts_of("%d-01-01" % time.localtime().tm_year)]
    high = max([r[2] for r in ytd] or [price])
    wk = [r[3] for r in rows if r[0] <= time.time() - 7 * 86400]
    target = avg(now)
    past = {}
    for y in HIST_YEARS:
        jan = next((r[1] for r in rows if ts_of("%d-01-01" % y) <= r[0] < ts_of("%d-01-10" % y)), None)  # None if listed later
        d = latest(ts_of("%d-09-01" % (y - 1)), ts_of("%d-01-01" % y))
        t = avg(d) if len(d) >= MIN_TARGETS else None
        past[y] = {"price": jan, "target": t, "n": len(d), "upside": (t / jan - 1) * 100 if t and jan else None,
                   "ret": (price / jan - 1) * 100 if jan else None}
    pr = res.get("price") or {}
    return {
        "symbol": symbol, "name": pr.get("shortName") or pr.get("longName") or symbol, "currency": currency,
        "price": price, "target": target, "_splits": splits, "n": len(now), "upside": (target / price - 1) * 100,
        "offHigh": (price / max(high, price) - 1) * 100, "week": (price / wk[-1] - 1) * 100 if wk else None, "past": past,
    }


def _prod(xs):
    p = 1.0
    for x in xs:
        p *= x
    return p


SEC_UA = {"User-Agent": "stock-dashboard sophiewattne@gmail.com"}  # SEC asks for a contact in the UA
REV_TAGS = ("RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
            "RevenueFromContractWithCustomerIncludingAssessedTax")


def sec_json(url, ttl):
    hit = _cache.get(url)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    with urllib.request.urlopen(urllib.request.Request(url, headers=SEC_UA), timeout=15) as r:
        data = json.load(r)
    _cache[url] = (time.time(), data)
    return data


def _days(a, b):
    return (ts_of(b) - ts_of(a)) / 86400


def ttm(entries, asof, splits=()):
    """Sum of the last 4 reported quarters as known at `asof` (Q4 derived from the annual figure), with
    per-share values adjusted for splits after they were filed. Returns (value, quarter_end) or None."""
    q, ann = {}, {}
    for e in sorted((e for e in entries if ts_of(e["filed"]) <= asof), key=lambda e: e["filed"]):
        d = _days(e["start"], e["end"])
        v = e["val"] / _prod(x["numerator"] / x["denominator"] for x in splits if x["date"] > ts_of(e["filed"]))
        if 80 <= d <= 100:
            q[e["end"]] = (e["start"], v)
        elif 350 <= d <= 380:
            ann[e["end"]] = (e["start"], v)
    for end, (start, v) in ann.items():
        inside = [k for k, (st, _) in q.items() if st >= start and k <= end]
        if len(inside) == 3 and not any(abs(_days(k, end)) < 10 for k in q):
            q[end] = (max(inside), v - sum(q[k][1] for k in inside))
    ends = sorted(q)[-4:]
    if len(ends) < 4 or not 250 <= _days(ends[0], ends[-1]) <= 300 or asof - ts_of(ends[-1]) > 200 * 86400:
        return None
    return sum(q[k][1] for k in ends), ends[-1]


def fundamentals(symbol, splits):
    """Trailing-12-month revenue and diluted EPS from SEC filings at 1 Jan of HIST_YEARS and today."""
    ciks = sec_json("https://www.sec.gov/files/company_tickers.json", 7 * 86400)
    cik = next((v["cik_str"] for v in ciks.values() if v["ticker"] == symbol), None)
    if not cik:
        return None
    g = sec_json("https://data.sec.gov/api/xbrl/companyfacts/CIK%010d.json" % cik, 86400)["facts"].get("us-gaap") or {}
    unit = lambda tag: next(iter((g.get(tag) or {}).get("units", {}).values()), [])  # noqa: E731
    eps_entries, seen = [], set()
    for tag in ("EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"):  # loss quarters often have basic only
        new = [e for e in unit(tag) if (e.get("start"), e["end"]) not in seen]
        seen |= {(e.get("start"), e["end"]) for e in new}
        eps_entries += new
    out = {}
    for key, at in [(str(y), ts_of("%d-01-01" % y)) for y in HIST_YEARS] + [("now", time.time())]:
        revs = [r for r in (ttm(unit(t), at) for t in REV_TAGS) if r]
        rev = max(revs, key=lambda r: (r[1], r[0])) if revs else None
        eps = ttm(eps_entries, at, splits)
        out[key] = {"rev": rev and rev[0], "eps": eps and eps[0], "end": (rev or eps or (None, None))[1]}
    return out


def suggest(bucket):
    key = "suggest:" + bucket
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 6 * 3600:
        return hit[1]
    syms = BUCKETS[bucket].split()
    with ThreadPoolExecutor(12) as ex:
        rows = [r for r in ex.map(lambda s: _safe(candidate, s), syms) if r and r.get("target")]
    rows.sort(key=lambda r: -r["upside"])
    top = rows[:5]
    with ThreadPoolExecutor(5) as ex:
        for r, f in zip(top, ex.map(lambda r: _safe(fundamentals, r["symbol"], r["_splits"]), top)):
            r["fund"] = f
    for r in rows:
        r.pop("_splits", None)
    out = {"bucket": bucket, "since": TARGETS_SINCE, "years": HIST_YEARS, "min": MIN_TARGETS, "checked": len(syms), "qualified": len(rows), "top": top}
    _cache[key] = (time.time(), out)
    return out


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:  # noqa: BLE001
        return None


def route(path):
    """Return (status, payload) for an /api/... GET path, or None if not an API route."""
    u = urllib.parse.urlparse(path)
    qs = urllib.parse.parse_qs(u.query)
    try:
        if u.path == "/api/quotes":
            syms = [s for s in qs.get("symbols", [""])[0].split(",") if s][:50]
            with ThreadPoolExecutor(8) as ex:
                return 200, dict(zip(syms, ex.map(quote, syms)))
        if u.path == "/api/history":
            return 200, history(qs["symbol"][0], qs.get("range", ["1y"])[0], qs.get("start", [None])[0])
        if u.path == "/api/targets":
            syms = [s for s in qs.get("symbols", [""])[0].split(",") if s][:30]
            with ThreadPoolExecutor(8) as ex:
                return 200, dict(zip(syms, ex.map(targets, syms)))
        if u.path == "/api/suggest":
            b = qs.get("bucket", ["ai"])[0]
            return (200, suggest(b)) if b in BUCKETS else (400, {"error": "unknown bucket"})
        if u.path == "/api/search":
            return 200, search(qs.get("q", [""])[0])
    except Exception as e:  # noqa: BLE001
        return 502, {"error": str(e)}
    return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status, payload = route(self.path) or (404, {"error": "not found"})
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
