#!/usr/bin/env python3
"""Stock portfolio dashboard: serves the UI, stores holdings, proxies Yahoo Finance quotes."""
import json
import os
import threading
import time
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA_FILE = os.path.join(ROOT, "holdings.json")
PORT = int(os.environ.get("PORT", "8000"))
UA = {"User-Agent": "Mozilla/5.0"}  # Yahoo rate-limits fuller browser/python UAs

_lock = threading.Lock()
_cache = {}

SAMPLE = [
    {"symbol": "AAPL", "shares": 10, "price": 150.00, "date": "2023-03-15"},
    {"symbol": "AAPL", "shares": 5, "price": 190.00, "date": "2024-06-10"},
    {"symbol": "MSFT", "shares": 8, "price": 310.00, "date": "2023-05-02"},
    {"symbol": "NVDA", "shares": 20, "price": 45.00, "date": "2023-01-20"},
    {"symbol": "SAP.DE", "shares": 12, "price": 120.00, "date": "2023-09-01"},
]


def load_lots():
    if not os.path.exists(DATA_FILE):
        save_lots([dict(l, id=uuid.uuid4().hex) for l in SAMPLE])
    with open(DATA_FILE) as f:
        return json.load(f)


def save_lots(lots):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(lots, f, indent=2)
    os.replace(tmp, DATA_FILE)


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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/api/lots":
                with _lock:
                    return self.send_json(load_lots())
            if u.path == "/api/quotes":
                syms = [s for s in qs.get("symbols", [""])[0].split(",") if s]
                with ThreadPoolExecutor(8) as ex:
                    return self.send_json(dict(zip(syms, ex.map(quote, syms))))
            if u.path == "/api/history":
                return self.send_json(history(qs["symbol"][0], qs.get("range", ["1y"])[0]))
            if u.path == "/api/search":
                return self.send_json(search(qs.get("q", [""])[0]))
        except Exception as e:  # noqa: BLE001
            return self.send_json({"error": str(e)}, 502)
        return super().do_GET()

    def validate(self, body):
        sym = str(body.get("symbol", "")).strip().upper()
        shares, price = float(body["shares"]), float(body["price"])
        if not sym or shares <= 0 or price < 0:
            raise ValueError("invalid lot")
        return {"symbol": sym, "shares": shares, "price": price, "date": str(body.get("date") or "")}

    def do_POST(self):
        if self.path == "/api/lots":
            try:
                lot = self.validate(self.read_body())
            except Exception as e:  # noqa: BLE001
                return self.send_json({"error": str(e)}, 400)
            lot["id"] = uuid.uuid4().hex
            with _lock:
                lots = load_lots()
                lots.append(lot)
                save_lots(lots)
            return self.send_json(lot, 201)
        if self.path == "/api/lots/import":
            try:
                lots = [dict(self.validate(l), id=uuid.uuid4().hex) for l in self.read_body()]
            except Exception as e:  # noqa: BLE001
                return self.send_json({"error": str(e)}, 400)
            with _lock:
                save_lots(lots)
            return self.send_json(lots)
        self.send_error(404)

    def do_PUT(self):
        if self.path.startswith("/api/lots/"):
            lot_id = self.path.rsplit("/", 1)[1]
            try:
                lot = self.validate(self.read_body())
            except Exception as e:  # noqa: BLE001
                return self.send_json({"error": str(e)}, 400)
            with _lock:
                lots = load_lots()
                for i, l in enumerate(lots):
                    if l["id"] == lot_id:
                        lots[i] = dict(lot, id=lot_id)
                        save_lots(lots)
                        return self.send_json(lots[i])
            return self.send_json({"error": "not found"}, 404)
        self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith("/api/lots/"):
            lot_id = self.path.rsplit("/", 1)[1]
            with _lock:
                lots = [l for l in load_lots() if l["id"] != lot_id]
                save_lots(lots)
            return self.send_json({"ok": True})
        self.send_error(404)


if __name__ == "__main__":
    print("Serving on http://localhost:%d" % PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
