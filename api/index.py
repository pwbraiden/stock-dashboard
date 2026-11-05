"""Yahoo Finance proxy API (Vercel serverless function; also used by server.py locally)."""
import hashlib
import json
import os
import re
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


NDQ_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Accept": "application/json"}
_ndq_cls = {}
_ndq_pool = ThreadPoolExecutor(16)


def nasdaq_live(symbol):
    """(market status, real-time last trade) from Nasdaq for US tickers, incl. pre-market and after hours.
    Yahoo serves Vercel's servers quotes about 10 minutes late."""
    if not re.fullmatch(r"[A-Z]{1,5}(-[A-Z])?", symbol):
        return None, None
    key = "ndq:" + symbol
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 15:
        return hit[1]
    status = price = None
    for cls in [_ndq_cls[symbol]] if symbol in _ndq_cls else ["stocks", "etf"]:
        url = "https://api.nasdaq.com/api/quote/%s/info?assetclass=%s" % (symbol.replace("-", "."), cls)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=NDQ_UA), timeout=4) as r:
                d = json.load(r).get("data")
        except Exception:  # noqa: BLE001
            return None, None
        if not d:
            continue
        _ndq_cls[symbol] = cls
        p = d.get("primaryData") or {}
        status = d.get("marketStatus")
        if p.get("isRealTime"):
            try:
                price = float(p["lastSalePrice"].replace("$", "").replace(",", ""))
            except (KeyError, ValueError):
                pass
        break
    _cache[key] = (time.time(), (status, price))
    return status, price


def quote(symbol):
    live = _ndq_pool.submit(nasdaq_live, symbol)
    try:
        res, meta, currency, scale = chart(symbol, "5d", "1d")
        price = meta.get("regularMarketPrice")
        try:
            status, fresh = live.result(timeout=5)
        except Exception:  # noqa: BLE001
            status = fresh = None
        ext = last_close = None
        if fresh and currency == "USD" and status in ("Open", "Pre-Market", "After-Hours"):
            # Outside regular hours the extended-hours trade is the price, and "today" is measured from the last close.
            if status != "Open":
                last_close, ext = price, {"extLabel": "Pre-market" if status == "Pre-Market" else "After hours"}
            price, meta = fresh, {**meta, "regularMarketTime": int(time.time())}
        prev = None
        closes = [c for c in (res.get("indicators", {}).get("quote", [{}])[0].get("close") or []) if c is not None]
        if len(closes) >= 2:
            prev = closes[-2]
        prev = last_close or meta.get("previousClose") or prev
        return {
            "symbol": symbol,
            "name": meta.get("longName") or meta.get("shortName") or symbol,
            "currency": currency,
            "price": price * scale if price is not None else None,
            "previousClose": prev * scale if prev else None,
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
            "marketTime": meta.get("regularMarketTime"),
            **(ext or {}),
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
    res = qsummary(symbol, "upgradeDowngradeHistory,price,earningsTrend")
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
        "fwd": next12(res), "symbol": symbol, "name": pr.get("shortName") or pr.get("longName") or symbol, "currency": currency,
        "price": price, "target": target, "_splits": splits, "n": len(now), "upside": (target / price - 1) * 100,
        "offHigh": (price / max(high, price) - 1) * 100, "week": (price / wk[-1] - 1) * 100 if wk else None, "past": past,
    }


def next12(res):
    """Consensus revenue and EPS for the next 12 months: this and next fiscal year's estimates, time-weighted."""
    tr = {t.get("period"): t for t in (res.get("earningsTrend") or {}).get("trend") or []}
    y0, y1 = tr.get("0y"), tr.get("+1y")
    if not (y0 and y1 and y0.get("endDate")):
        return None
    w = min(max((ts_of(y0["endDate"]) - time.time()) / (365 * 86400), 0), 1)
    est = lambda k: [((t.get(k) or {}).get("avg") or {}).get("raw") for t in (y0, y1)]  # noqa: E731
    blend = lambda a: w * a[0] + (1 - w) * a[1] if None not in a else None  # noqa: E731
    return {"rev": blend(est("revenueEstimate")), "eps": blend(est("earningsEstimate"))}


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


ABOUT = {
    'NVDA': 'Graphics chips that power most AI training and gaming',
    'AMD': "Computer, gaming and AI chips; Nvidia and Intel's main rival",
    'AVGO': 'Networking and custom AI chips, plus VMware software',
    'TSM': 'Makes the chips designed by Apple, Nvidia and others',
    'MU': 'Memory chips for computers, phones and AI servers',
    'MRVL': 'Custom AI and data-centre networking chips',
    'ANET': 'High-speed network switches for cloud and AI data centres',
    'VRT': 'Power and cooling equipment for data centres',
    'DELL': 'PCs, servers and AI server systems',
    'PLTR': 'Data-analysis and AI software for governments and companies',
    'QCOM': 'Chips that run most Android phones, plus car and PC chips',
    'INTC': 'PC and server processors; also building chip factories',
    'CRWV': 'Rents out Nvidia GPU cloud computing for AI',
    'ORCL': 'Database software and a fast-growing AI cloud business',
    'MSFT': 'Windows, Office, Azure cloud and a big stake in OpenAI',
    'GOOGL': 'Google search, YouTube, Android and Google Cloud',
    'META': 'Facebook, Instagram and WhatsApp, funded by ads',
    'AMZN': 'Online shopping plus AWS, the biggest cloud provider',
    'LRCX': 'Machines that etch and deposit layers on chips',
    'AMAT': 'The largest maker of chip-manufacturing equipment',
    'KLAC': 'Machines that inspect chips for defects during production',
    'CEG': 'Largest US nuclear power producer, selling power to data centres',
    'VST': 'Power plants (gas and nuclear) selling electricity to the grid',
    'COHR': 'Lasers and optical parts for data-centre networks',
    'CLS': 'Builds servers and network gear for big tech companies',
    'SMCI': 'Builds AI servers packed with Nvidia chips',
    'NBIS': 'AI cloud computing provider (spun out of Yandex)',
    'ALAB': 'Connectivity chips that link AI processors in data centres',
    'ARM': 'Designs the chip blueprints used in nearly all smartphones',
    'ASML': 'Sole maker of the machines needed to print the most advanced chips',
    'CRM': 'Salesforce: software for managing sales and customers',
    'NOW': 'Software that automates company IT and workflows',
    'ADBE': 'Photoshop, Acrobat and other creative software',
    'INTU': 'TurboTax, QuickBooks and Credit Karma',
    'WDAY': 'HR and finance software for large companies',
    'SNOW': 'Cloud data warehouse for storing and analysing company data',
    'DDOG': 'Monitors apps and cloud servers for problems',
    'CRWD': 'Cybersecurity that protects company computers',
    'PANW': 'Cybersecurity firewalls and software',
    'ZS': 'Cloud cybersecurity for secure internet access',
    'NET': 'Cloudflare: speeds up and protects websites',
    'MDB': 'Database software used by app developers',
    'TEAM': 'Jira and Confluence: teamwork software',
    'HUBS': 'Marketing and sales software for small businesses',
    'SHOP': 'Lets businesses build online shops',
    'FTNT': 'Network security hardware and software',
    'ADSK': 'AutoCAD design software for architects and engineers',
    'TTD': 'Platform that buys online ads for advertisers',
    'APP': 'Ad tech that helps apps and games find users',
    'U': 'Unity: engine used to build video games',
    'OKTA': 'Login and identity security for companies',
    'DOCU': 'Electronic signatures and contract software',
    'GTLB': 'Software for developers to build and ship code',
    'IOT': 'Samsara: sensors and software for fleets and factories',
    'S': 'SentinelOne: AI-based cybersecurity',
    'CDNS': 'Software used to design chips',
    'SNPS': 'Software used to design chips',
    'JPM': 'Largest US bank',
    'BAC': 'Bank of America: major US consumer and investment bank',
    'WFC': 'Wells Fargo: large US consumer bank',
    'C': 'Citigroup: global bank',
    'GS': 'Goldman Sachs: investment bank and trading',
    'MS': 'Morgan Stanley: investment bank and wealth management',
    'SCHW': 'Charles Schwab: stock broker and wealth manager',
    'BLK': "BlackRock: world's largest fund manager (iShares ETFs)",
    'AXP': 'American Express credit cards',
    'V': 'Visa card payment network',
    'MA': 'Mastercard payment network',
    'COF': 'Capital One: credit cards and consumer bank',
    'PYPL': 'PayPal and Venmo online payments',
    'HOOD': 'Robinhood: app for trading stocks and crypto',
    'SOFI': 'Online bank for loans and investing',
    'KKR': 'Private equity and investment firm',
    'BX': "Blackstone: world's largest alternative investment firm",
    'APO': 'Apollo: private credit and investment firm, plus insurance',
    'SPGI': 'S&P Global: credit ratings and stock indexes',
    'MCO': "Moody's: credit ratings and financial data",
    'ICE': 'Owns the New York Stock Exchange and mortgage tech',
    'CME': "Runs the world's biggest futures exchange",
    'PNC': 'Large US regional bank',
    'USB': 'U.S. Bancorp: large US regional bank',
    'TFC': 'Truist: US regional bank in the Southeast',
    'ARES': 'Private credit and investment firm',
    'COIN': 'Coinbase: largest US crypto exchange',
    'AFRM': 'Affirm: buy now, pay later loans',
    'NU': 'Nubank: digital bank in Brazil and Latin America',
    'GE': 'GE Aerospace: jet engines for airlines and military',
    'CAT': 'Caterpillar: construction and mining machinery',
    'HON': 'Honeywell: aerospace, automation and building tech',
    'RTX': 'Raytheon: jet engines, missiles and defence systems',
    'LMT': 'Lockheed Martin: fighter jets (F-35) and missiles',
    'BA': 'Boeing: passenger planes and defence aircraft',
    'UNP': 'Union Pacific: freight railroad in the western US',
    'UPS': 'Package delivery',
    'ETN': 'Eaton: electrical equipment for buildings and data centres',
    'NOC': 'Northrop Grumman: stealth bombers, space and defence',
    'WM': 'Waste Management: rubbish collection and landfills',
    'URI': 'United Rentals: rents out construction equipment',
    'PWR': 'Quanta: builds power lines and grid infrastructure',
    'CARR': 'Carrier: heating and air conditioning',
    'JCI': 'Johnson Controls: building heating, cooling and security',
    'FDX': 'FedEx: package delivery',
    'CSX': 'Freight railroad in the eastern US',
    'NSC': 'Norfolk Southern: freight railroad in the eastern US',
    'GEV': 'GE Vernova: gas turbines, wind and grid equipment',
    'TDG': 'TransDigm: specialist aircraft parts',
    'CMI': 'Cummins: engines and power generators',
    'HWM': 'Howmet: engine parts and fasteners for aircraft',
    'ODFL': 'Old Dominion: trucking for shared loads',
    'XYL': 'Xylem: water pumps and treatment',
    'JBHT': 'J.B. Hunt: trucking and rail freight',
    'CHRW': 'C.H. Robinson: arranges freight shipping for companies',
    'SAIA': 'Trucking for shared loads',
    'AAL': 'American Airlines',
    'KTOS': 'Kratos: military drones and defence tech',
    'AVAV': 'AeroVironment: small military drones',
    'BLDR': 'Builders FirstSource: building materials for homebuilders',
    'DAL': 'Delta Air Lines',
    'UAL': 'United Airlines',
    'BWXT': 'Nuclear reactors for navy submarines and power',
    'MAS': 'Masco: taps, paint and home-improvement products',
    'LLY': 'Eli Lilly: weight-loss (Zepbound) and diabetes drugs',
    'UNH': 'UnitedHealth: largest US health insurer',
    'JNJ': 'Johnson & Johnson: medicines and medical devices',
    'ABBV': 'AbbVie: immunology drugs (Skyrizi, Rinvoq) and Botox',
    'MRK': 'Merck: cancer drug Keytruda and vaccines',
    'PFE': 'Pfizer: medicines and vaccines',
    'TMO': 'Thermo Fisher: lab equipment and supplies',
    'ABT': 'Abbott: medical devices, diagnostics and nutrition',
    'DHR': 'Danaher: lab and diagnostics equipment',
    'ISRG': 'Intuitive Surgical: da Vinci surgical robots',
    'AMGN': 'Amgen: biotech medicines',
    'GILD': 'Gilead: HIV and liver disease drugs',
    'VRTX': 'Vertex: cystic fibrosis and pain drugs',
    'REGN': 'Regeneron: eye and allergy drugs (Eylea, Dupixent)',
    'BMY': 'Bristol Myers Squibb: cancer and heart drugs',
    'MDT': 'Medtronic: medical devices like pacemakers',
    'SYK': 'Stryker: hip/knee implants and surgical equipment',
    'BSX': 'Boston Scientific: heart and other medical devices',
    'CVS': 'CVS: pharmacies and Aetna health insurance',
    'CI': 'Cigna: health insurance and pharmacy benefits',
    'ELV': 'Elevance: health insurer (Anthem)',
    'HCA': 'HCA: largest US hospital operator',
    'ZTS': 'Zoetis: medicines and vaccines for pets and livestock',
    'MRNA': 'Moderna: mRNA vaccines',
    'BIIB': "Biogen: Alzheimer's and MS drugs",
    'DXCM': 'Dexcom: glucose monitors for diabetics',
    'IDXX': 'IDEXX: diagnostic tests for vets',
    'HUM': 'Humana: Medicare health insurer',
    'NVO': 'Novo Nordisk: Ozempic and Wegovy',
    'AZN': 'AstraZeneca: cancer and other medicines',
    'ACM': 'AECOM: designs and manages infrastructure projects',
    'AAPL': 'iPhone, Mac and services',
    'SAP.DE': 'Business software for finance and supply chains',
    'TSLA': 'Tesla: electric cars, batteries and robotaxis',
    'NFLX': 'Netflix streaming',
}


def about(symbol):
    """One plain-English line on what the company does; falls back to Yahoo's industry."""
    if symbol in ABOUT:
        return ABOUT[symbol]
    key = "about:" + symbol
    if key not in _cache:
        a = (qsummary(symbol, "assetProfile") or {}).get("assetProfile") or {}
        _cache[key] = (time.time(), " · ".join(x for x in (a.get("industry"), a.get("sector")) if x))
    return _cache[key][1]


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
            r["about"] = _safe(about, r["symbol"])
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


# ---- Live share: owner's browser saves holdings under a random id; anyone with the id can read them ----
LIVE_ID = re.compile(r"[A-Za-z0-9_-]{16,40}")


def _blob_token():
    return os.environ.get("BLOB_READ_WRITE_TOKEN")


def live_load(lid):
    if os.environ.get("LIVE_DIR"):  # local development
        try:
            with open(os.path.join(os.environ["LIVE_DIR"], lid + ".json")) as f:
                return json.load(f)
        except FileNotFoundError:
            return None
    tok = _blob_token()
    store = tok.split("_")[3]
    url = "https://%s.private.blob.vercel-storage.com/live/%s.json?cache=0" % (store, lid)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + tok}), timeout=8) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def live_store(lid, data):
    body = json.dumps(data).encode()
    if os.environ.get("LIVE_DIR"):
        with open(os.path.join(os.environ["LIVE_DIR"], lid + ".json"), "wb") as f:
            f.write(body)
        return
    req = urllib.request.Request(
        "https://vercel.com/api/blob/?pathname=" + urllib.parse.quote("live/%s.json" % lid), data=body, method="PUT",
        headers={"Authorization": "Bearer " + _blob_token(), "x-api-version": "13", "x-vercel-blob-access": "private",
                 "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-content-type": "application/json",
                 "x-cache-control-max-age": "60"})
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def live_ready():
    return bool(os.environ.get("LIVE_DIR") or _blob_token())


def live_get(lid):
    if not live_ready():
        return 503, {"error": "Live sharing isn't set up yet"}
    if not LIVE_ID.fullmatch(lid or ""):
        return 400, {"error": "bad id"}
    d = live_load(lid)
    if not d:
        return 404, {"error": "This live link doesn't exist (any more)"}
    return 200, {"lots": d.get("lots", []), "names": d.get("names", {}), "updated": d.get("updated")}


def live_put(raw):
    if not live_ready():
        return 503, {"error": "Live sharing isn't set up yet"}
    if len(raw) > 300_000:
        return 413, {"error": "too large"}
    b = json.loads(raw)
    lid, key = b.get("id", ""), b.get("key", "")
    if not LIVE_ID.fullmatch(lid) or len(key) < 20 or not isinstance(b.get("lots"), list):
        return 400, {"error": "bad request"}
    kh = hashlib.sha256(key.encode()).hexdigest()
    old = live_load(lid)
    if old and old.get("keyHash") != kh:
        return 403, {"error": "not allowed"}
    live_store(lid, {"keyHash": kh, "lots": b["lots"], "names": b.get("names") or {}, "updated": int(time.time())})
    return 200, {"ok": True}


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
        if u.path == "/api/about":
            syms = [x for x in qs.get("symbols", [""])[0].upper().split(",") if x][:60]
            with ThreadPoolExecutor(8) as ex:
                return 200, dict(zip(syms, ex.map(lambda x: _safe(about, x) or "", syms)))
        if u.path == "/api/suggest":
            b = qs.get("bucket", ["ai"])[0]
            return (200, suggest(b)) if b in BUCKETS else (400, {"error": "unknown bucket"})
        if u.path == "/api/search":
            return 200, search(qs.get("q", [""])[0])
        if u.path == "/api/live":
            return live_get(qs.get("id", [""])[0])
    except Exception as e:  # noqa: BLE001
        return 502, {"error": str(e)}
    return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        handler._send(self, *(route(self.path) or (404, {"error": "not found"})))

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            res = live_put(raw) if urllib.parse.urlparse(self.path).path == "/api/live" else (404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            res = 502, {"error": str(e)}
        handler._send(self, *res)

    @staticmethod
    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
