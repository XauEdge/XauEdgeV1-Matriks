import http from "node:http";
import { cfg } from "./config.js";
import {
  loadState,
  getState,
  updateState,
  addEvent
} from "./storage.js";
import {
  generateSetup,
  hardConfirmation
} from "./analysis.js";
import { validateWithOpenAI } from "./openai.js";
import {
  telegramInit,
  sendTelegram,
  pollTelegram,
  setupMessage,
  confirmationMessage,
  statusMessage
} from "./telegram.js";

let telegramOffset = 0;
let processingConfirmation = false;
let marketBusy = false;
let latestMarket = null;

function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json"
  });
  res.end(JSON.stringify(body));
}

function chatAllowed(id) {
  return (
    !cfg.telegramChatId ||
    String(id) === String(cfg.telegramChatId)
  );
}

async function biquote(path) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    10000
  );

  try {
    const response = await fetch(
      `https://biquote.io${path}`,
      {
        signal: controller.signal,
        headers: {
          accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.error ||
        `Biquote HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBars(data) {
  const raw = Array.isArray(data?.bars)
    ? data.bars
    : Array.isArray(data)
      ? data
      : [];

  return raw
    .filter(b => !b.isOpen)
    .map(b => ({
      time: Number(
        b.time ??
        (
          b.openTime
            ? new Date(b.openTime).getTime() / 1000
            : NaN
        )
      ),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(
        b.volume ??
        b.tickVolume ??
        0
      )
    }))
    .filter(b =>
      Number.isFinite(b.time) &&
      Number.isFinite(b.open) &&
      Number.isFinite(b.high) &&
      Number.isFinite(b.low) &&
      Number.isFinite(b.close)
    )
    .sort(
      (a, b) => a.time - b.time
    );
}

async function fetchMarket() {
  const [
    tick,
    m5Data,
    m30Data
  ] = await Promise.all([
    biquote("/api/XAUUSD"),
    biquote(
      "/api/XAUUSD/ohlc?interval=5m&limit=120"
    ),
    biquote(
      "/api/XAUUSD/ohlc?interval=30m&limit=120"
    )
  ]);

  const price = Number(
    tick?.mid ??
    tick?.price ??
    tick?.last ??
    tick?.close
  );

  if (!Number.isFinite(price)) {
    throw new Error(
      "BIQUOTE_NO_PRICE"
    );
  }

  const m5 = normalizeBars(m5Data);
  const m30 = normalizeBars(m30Data);

  if (m5.length < 60) {
    throw new Error(
      `BIQUOTE_M5_ONLY_${m5.length}_BARS`
    );
  }

  if (m30.length < 60) {
    throw new Error(
      `BIQUOTE_M30_ONLY_${m30.length}_BARS`
    );
  }

  return {
    symbol: cfg.symbol,

    timestamp:
      tick?.timestamp ||
      new Date().toISOString(),

    tick: {
      bid: Number(
        tick?.bid ?? price
      ),
      ask: Number(
        tick?.ask ?? price
      ),
      last: price,
      mid: price,
      volume: Number(
        tick?.volume ?? 0
      )
    },

    m5,
    m30,

    source: "BIQUOTE"
  };
}

async function refreshMarket() {
  if (marketBusy) {
    return latestMarket;
  }

  marketBusy = true;

  try {
    const market =
      await fetchMarket();

    latestMarket = market;

    await updateState({
      latestMarket: market
    });

    console.log(
      `BIQUOTE OK | XAUUSD ${market.tick.mid} | M5 ${market.m5.length} | M30 ${market.m30.length}`
    );

    await confirmIfTouched();

    return market;

  } catch (error) {
    console.error(
      `BIQUOTE ERROR: ${error.message}`
    );

    return latestMarket;

  } finally {
    marketBusy = false;
  }
}

async function createSetup(
  reason = "manual"
) {
  const state =
    getState();

  if (
    state.cooldownUntil &&
    Date.now() <
    state.cooldownUntil
  ) {
    return {
      ok: false,
      reason: "COOLDOWN"
    };
  }

  if (
    state.state === "WAITING_ZONE" ||
    state.state === "RECHECKING"
  ) {
    return {
      ok: false,
      reason:
        "SETUP_ALREADY_ACTIVE",
      setup: state.setup
    };
  }

  await refreshMarket();

  const market =
    latestMarket ||
    getState().latestMarket;

  if (!market) {
    return {
      ok: false,
      reason: "NO_MARKET_DATA"
    };
  }

  console.log(
    `SIGNAL ANALYSIS | ${market.symbol} | ${market.tick.mid}`
  );

  const result =
    generateSetup(market);

  addEvent(
    "setup_analysis",
    {
      reason,
      result
    }
  );

  if (!result.ok) {
    await updateState({
      state: "IDLE",
      setup: null
    });

    return result;
  }

  await updateState({
    state: "WAITING_ZONE",
    setup: result.setup
  });

  await sendTelegram(
    setupMessage(result.setup)
  );

  return result;
}

async function confirmIfTouched() {
  if (processingConfirmation) {
    return;
  }

  const state =
    getState();

  const setup =
    state.setup;

  const market =
    latestMarket ||
    state.latestMarket;

  if (
    state.state !== "WAITING_ZONE" ||
    !setup ||
    !market
  ) {
    return;
  }

  if (
    Date.now() <
    (
      state.lastConfirmationAt || 0
    ) +
    cfg.confirmCooldownSeconds * 1000
  ) {
    return;
  }

  if (
    Date.now() >
    setup.expiresAt
  ) {
    await updateState({
      state: "IDLE",
      setup: null
    });

    await sendTelegram(
      "<b>⚠️ XAU EDGE</b>\nSETUP EXPIRED."
    );

    return;
  }

  const price =
    Number(
      market.tick?.bid ??
      market.tick?.mid ??
      market.tick?.last
    );

  if (!Number.isFinite(price)) {
    return;
  }

  const buffer =
    cfg.zoneTouchBufferPoints *
    cfg.pointSize;

  const inside =
    price >=
      setup.zone.low - buffer &&
    price <=
      setup.zone.high + buffer;

  if (!inside) {
    const broken =
      setup.direction === "BUY"
        ? price <
          setup.zone.low - buffer
        : price >
          setup.zone.high + buffer;

    const slBroken =
      setup.direction === "BUY"
        ? price < setup.sl
        : price > setup.sl;

    if (
      broken ||
      slBroken
    ) {
      await updateState({
        state: "INVALID",
        lastConfirmationAt:
          Date.now(),
        cooldownUntil:
          Date.now() +
          cfg.postConfirmCooldownMinutes *
          60000
      });

      addEvent(
        "zone_broken",
        {
          price,
          setupId: setup.id
        }
      );

      await sendTelegram(
        [
          "<b>⚠️ XAU EDGE</b>",
          "",
          "❌ <b>SETUP INVALID</b>",
          "ZONE BROKEN",
          `PRICE: <b>${price.toFixed(2)}</b>`,
          "NO ENTRY"
        ].join("\n")
      );
    }

    return;
  }

  processingConfirmation = true;

  await updateState({
    state: "RECHECKING",
    lastConfirmationAt:
      Date.now()
  });

  try {
    const technical =
      hardConfirmation(
        market,
        setup
      );

    const ai =
      await validateWithOpenAI(
        market,
        setup,
        technical
      );

    const confirmed =
      technical.valid &&
      ai.confirm === true &&
      Number(ai.confidence) >= 65;

    addEvent(
      "confirmation",
      {
        technical,
        ai,
        confirmed
      }
    );

    if (confirmed) {
      await updateState({
        state: "CONFIRMED",
        cooldownUntil:
          Date.now() +
          cfg.postConfirmCooldownMinutes *
          60000
      });

      await sendTelegram(
        confirmationMessage(
          setup,
          ai,
          technical
        )
      );

    } else {
      await updateState({
        state: "INVALID",
        cooldownUntil:
          Date.now() +
          Math.min(
            15,
            cfg.postConfirmCooldownMinutes
          ) *
          60000
      });

      await sendTelegram(
        confirmationMessage(
          setup,
          {
            ...ai,
            confirm: false
          },
          technical
        )
      );
    }

  } catch (error) {
    console.error(
      `CONFIRMATION ERROR: ${error.message}`
    );

    await updateState({
      state: "WAITING_ZONE"
    });

  } finally {
    processingConfirmation = false;
  }
}

async function handleCommand(
  message
) {
  const chatId =
    message.chat?.id;

  if (
    !chatAllowed(chatId)
  ) {
    return;
  }

  const command =
    String(
      message.text || ""
    )
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();

  if (
    command === "/signal" ||
    command === "/start"
  ) {
    const result =
      await createSetup(
        "telegram"
      );

    if (!result.ok) {
      await sendTelegram(
        [
          "<b>🔥 XAU EDGE</b>",
          `NO SETUP: ${result.reason}`
        ].join("\n"),
        chatId
      );
    }

    return;
  }

  if (
    command === "/status"
  ) {
    await sendTelegram(
      statusMessage(
        getState()
      ),
      chatId
    );

    return;
  }

  if (
    command === "/cancel"
  ) {
    await updateState({
      state: "IDLE",
      setup: null,
      cooldownUntil: 0
    });

    await sendTelegram(
      "<b>🔥 XAU EDGE</b>\nACTIVE SETUP CANCELLED.",
      chatId
    );

    return;
  }

  if (
    command === "/help"
  ) {
    await sendTelegram(
      [
        "<b>🔥 XAU EDGE</b>",
        "",
        "/signal = cari setup",
        "/status = status",
        "/cancel = batalkan setup",
        "",
        "SETUP → WAITING ZONE →",
        "RECHECK → ENTRY CONFIRMED"
      ].join("\n"),
      chatId
    );
  }
}

async function telegramLoop() {
  while (true) {
    try {
      const updates =
        await pollTelegram(
          telegramOffset
        );

      for (
        const update
        of updates
      ) {
        telegramOffset =
          update.update_id + 1;

        if (
          update.message
        ) {
          await handleCommand(
            update.message
          );
        }
      }

    } catch (error) {
      console.error(
        `TELEGRAM ERROR: ${error.message}`
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            3000
          )
      );
    }
  }
}

async function marketLoop() {
  await refreshMarket();

  setInterval(
    () => {
      refreshMarket()
        .catch(error =>
          console.error(
            `MARKET LOOP: ${error.message}`
          )
        );
    },
    3000
  );
}

async function start() {
  await loadState();

  await telegramInit();

  console.log(
    "🔥 XAU EDGE V2"
  );

  console.log(
    "Starting Biquote market feed..."
  );

  await marketLoop();

  telegramLoop();

  const server =
    http.createServer(
      async (
        req,
        res
      ) => {
        try {
          const url =
            new URL(
              req.url,
              `http://${req.headers.host || "localhost"}`
            );

          if (
            req.method === "GET" &&
            url.pathname === "/health"
          ) {
            const state =
              getState();

            return json(
              res,
              200,
              {
                ok: true,
                state:
                  state.state,
                hasMarket:
                  !!latestMarket,
                price:
                  latestMarket
                    ?.tick?.mid ??
                  null,
                source:
                  latestMarket
                    ?.source ??
                  null,
                updatedAt:
                  state.updatedAt
              }
            );
          }

          if (
            req.method === "GET" &&
            url.pathname === "/state"
          ) {
            return json(
              res,
              200,
              getState()
            );
          }

          if (
            req.method === "POST" &&
            url.pathname === "/signal"
          ) {
            const result =
              await createSetup(
                "http"
              );

            return json(
              res,
              result.ok
                ? 200
                : 409,
              result
            );
          }

          if (
            req.method === "POST" &&
            url.pathname === "/ingest"
          ) {
            return json(
              res,
              410,
              {
                ok: false,
                error:
                  "MT5 disabled. Biquote is the market source."
              }
            );
          }

          return json(
            res,
            404,
            {
              ok: false,
              error:
                "not_found"
            }
          );

        } catch (error) {
          console.error(
            `SERVER ERROR: ${error.message}`
          );

          return json(
            res,
            500,
            {
              ok: false,
              error:
                error.message
            }
          );
        }
      }
    );

  server.listen(
    cfg.port,
    () => {
      console.log(
        `XAU EDGE V2 listening on :${cfg.port}`
      );
    }
  );

  process.on(
    "SIGTERM",
    () =>
      server.close(
        () =>
          process.exit(0)
      )
  );

  process.on(
    "SIGINT",
    () =>
      server.close(
        () =>
          process.exit(0)
      )
  );
}

start().catch(
  error => {
    console.error(
      "FATAL:",
      error
    );

    process.exit(1);
  }
);
