"""Yahoo Finance proxy API (Vercel serverless function; also used by server.py locally)."""
import json
import time
import urllib.parse
import urllib.request
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


def chart(symbol, rng="1d", interval="1d", ttl=30):
    url = "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=%s" % (
        urllib.parse.quote(symbol), rng, interval)
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


def history(symbol, rng):
    interval = {"1d": "5m", "5d": "30m", "1mo": "1d", "6mo": "1d", "ytd": "1d", "1y": "1d", "5y": "1wk", "max": "1mo"}.get(rng, "1d")
    res, meta, currency, scale = chart(symbol, rng, interval, ttl=120)
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
            return 200, history(qs["symbol"][0], qs.get("range", ["1y"])[0])
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
