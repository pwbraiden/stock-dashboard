# Stock Portfolio Dashboard

Interactive dashboard for your stock holdings: shares, buy prices (multiple purchases per stock), live prices, gain/loss and % return, allocation and price-history charts.

## Run

```
python3 server.py        # no dependencies, Python 3.8+
```

Open http://localhost:8000. Set `PORT=9000` to use another port.

- Holdings are saved in `holdings.json` (created with sample data on first run — delete the sample purchases and add your own).
- Prices come from Yahoo Finance (delayed, auto-refresh every 60 s). Use Yahoo tickers, e.g. `AAPL`, `SAP.DE` (Xetra), `VOD.L` (London), `NESN.SW` (Zurich).
- Buy prices are entered in the stock's own currency; totals can be shown in EUR/USD/GBP/CHF using today's FX rate.
- Export / Import (footer) to back up or move your portfolio as JSON.
