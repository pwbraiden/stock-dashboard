# Stock Portfolio Dashboard

Interactive dashboard for your stock holdings: shares, buy prices (multiple purchases per stock), live prices, gain/loss and % return, allocation and price-history charts.

## Hosted

Deployed on Vercel (free Hobby plan): `vercel deploy --prod` from this folder. `api/index.py` is the serverless function; `public/` is the static site.

## Run locally

```
python3 server.py        # no dependencies, Python 3.8+
```

Open http://localhost:8000. Set `PORT=9000` to use another port.

- Holdings are saved in your browser's local storage (per device/browser). Use Export / Import to move them.
- Prices come from Yahoo Finance (delayed, auto-refresh every 60 s). Use Yahoo tickers, e.g. `AAPL`, `SAP.DE` (Xetra), `VOD.L` (London), `NESN.SW` (Zurich).
- Buy prices are entered in the stock's own currency; totals can be shown in EUR/USD/GBP/CHF using today's FX rate.
- Export / Import (footer) to back up or move your portfolio as JSON.
