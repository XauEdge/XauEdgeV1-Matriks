# MT5 bridge setup

1. Compile `XAU_EDGE_V2.mq5` in MetaEditor.
2. Put your deployed Blitz URL into `ApiBaseUrl` without a trailing slash.
3. Set `IngestKey` to the same value as Blitz `INGEST_KEY`.
4. Attach the EA to your XAUUSD chart.
5. In MT5 open `Tools -> Options -> Expert Advisors` and enable `Allow WebRequest for listed URL`.
6. Add the Blitz URL, for example `https://xau-edge-v2.yourname.blitz.cloud`.
7. Turn on Algo Trading.

The EA sends the latest tick every throttle interval. M5/M30 history is attached when a new M5 candle starts, so the server has enough context without downloading a full candle history on every tick.
