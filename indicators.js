import { cfg } from './config.js';

export function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function sma(values, n) {
  if (values.length < n) return null;
  const a = values.slice(-n);
  return a.reduce((s, x) => s + x, 0) / n;
}

export function ema(values, n) {
  if (!values.length) return null;
  const k = 2 / (n + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

export function trueRange(bars) {
  if (!bars.length) return [];

  const out = [bars[0].high - bars[0].low];

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const p = bars[i - 1];

    out.push(
      Math.max(
        b.high - b.low,
        Math.abs(b.high - p.close),
        Math.abs(b.low - p.close)
      )
    );
  }

  return out;
}

export function atr(bars, n = 14) {
  return sma(trueRange(bars), n);
}

export function rsi(closes, n = 14) {
  if (closes.length <= n) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];

    if (d >= 0) gain += d;
    else loss -= d;
  }

  if (loss === 0) return 100;

  const rs = (gain / n) / (loss / n);
  return 100 - (100 / (1 + rs));
}

export function bodyRatio(b) {
  const range = Math.max(b.high - b.low, 1e-9);
  return Math.abs(b.close - b.open) / range;
}

export function upperWick(b) {
  return b.high - Math.max(b.open, b.close);
}

export function lowerWick(b) {
  return Math.min(b.open, b.close) - b.low;
}

export function candleDirection(b) {
  if (b.close > b.open) return 'bullish';
  if (b.close < b.open) return 'bearish';
  return 'doji';
}

export function swingPoints(bars, left = 2, right = 2) {
  const highs = [];
  const lows = [];

  for (let i = left; i < bars.length - right; i++) {
    let hi = true;
    let lo = true;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;

      if (bars[j].high >= bars[i].high) hi = false;
      if (bars[j].low <= bars[i].low) lo = false;
    }

    if (hi) {
      highs.push({
        index: i,
        price: bars[i].high,
        time: bars[i].time
      });
    }

    if (lo) {
      lows.push({
        index: i,
        price: bars[i].low,
        time: bars[i].time
      });
    }
  }

  return { highs, lows };
}

export function structureState(bars) {
  if (bars.length < 15) {
    return {
      bias: 'NEUTRAL',
      bos: null,
      choch: null,
      lastSwingHigh: null,
      lastSwingLow: null
    };
  }

  const s = swingPoints(bars, 2, 2);

  const lastHigh = s.highs.at(-1);
  const prevHigh = s.highs.at(-2);

  const lastLow = s.lows.at(-1);
  const prevLow = s.lows.at(-2);

  const lastClose = bars.at(-1).close;

  let bias = 'NEUTRAL';
  let bos = null;
  let choch = null;

  if (lastHigh && prevHigh && lastLow && prevLow) {
    if (
      lastHigh.price > prevHigh.price &&
      lastLow.price > prevLow.price
    ) {
      bias = 'BULLISH';
    }

    if (
      lastHigh.price < prevHigh.price &&
      lastLow.price < prevLow.price
    ) {
      bias = 'BEARISH';
    }

    if (lastClose > lastHigh.price) {
      bos = 'BULLISH';
    }

    if (lastClose < lastLow.price) {
      bos = 'BEARISH';
    }

    if (
      bias === 'BULLISH' &&
      lastClose < lastLow.price
    ) {
      choch = 'BEARISH';
    }

    if (
      bias === 'BEARISH' &&
      lastClose > lastHigh.price
    ) {
      choch = 'BULLISH';
    }
  }

  return {
    bias,
    bos,
    choch,
    lastSwingHigh: lastHigh?.price ?? null,
    lastSwingLow: lastLow?.price ?? null,
    swings: s
  };
}

export function liquiditySweep(bars, lookback = 30) {
  const recent = bars.slice(
    -Math.min(bars.length, lookback + 5)
  );

  if (recent.length < 8) {
    return {
      bullish: false,
      bearish: false,
      level: null
    };
  }

  const before = recent.slice(0, -2);

  const last = recent.at(-1);
  const prev = recent.at(-2);

  const highs = swingPoints(before, 2, 2).highs;
  const lows = swingPoints(before, 2, 2).lows;

  const lastPoolHigh =
    highs.at(-1)?.price ??
    Math.max(...before.map(b => b.high));

  const lastPoolLow =
    lows.at(-1)?.price ??
    Math.min(...before.map(b => b.low));

  const bearish =
    last.high > lastPoolHigh &&
    last.close < lastPoolHigh;

  const bullish =
    last.low < lastPoolLow &&
    last.close > lastPoolLow;

  const prevBull =
    prev.low < lastPoolLow &&
    prev.close > lastPoolLow;

  const prevBear =
    prev.high > lastPoolHigh &&
    prev.close < lastPoolHigh;

  return {
    bullish: bullish || prevBull,
    bearish: bearish || prevBear,
    level:
      bullish || prevBull
        ? lastPoolLow
        : bearish || prevBear
          ? lastPoolHigh
          : null
  };
}

export function detectZones(bars, atrValue) {
  if (bars.length < 20 || !atrValue) {
    return [];
  }

  const zones = [];

  const start = Math.max(3, bars.length - 45);

  const maxRisk =
    cfg.maxSlPoints * cfg.pointSize;

  const maxZoneWidth =
    maxRisk * 1.7;

  for (let i = start; i < bars.length - 3; i++) {
    const b = bars[i];
    const n1 = bars[i + 1];
    const n2 = bars[i + 2];

    const move = Math.abs(n2.close - b.close);

    const displacement =
      move >= atrValue * 0.8 &&
      bodyRatio(n2) >= 0.55;

    if (!displacement) continue;

    if (
      b.close < b.open &&
      n2.close > n2.open
    ) {
      const low = b.low;
      const high = Math.max(b.open, b.close);
      const width = high - low;

      if (
        width > 0 &&
        width <= maxZoneWidth
      ) {
        zones.push({
          type: 'DEMAND',
          low,
          high,
          origin: b.time,
          quality: move / atrValue,
          width
        });
      }
    }

    if (
      b.close > b.open &&
      n2.close < n2.open
    ) {
      const low = Math.min(b.open, b.close);
      const high = b.high;
      const width = high - low;

      if (
        width > 0 &&
        width <= maxZoneWidth
      ) {
        zones.push({
          type: 'SUPPLY',
          low,
          high,
          origin: b.time,
          quality: move / atrValue,
          width
        });
      }
    }
  }

  return zones
    .filter(z =>
      Number.isFinite(z.low) &&
      Number.isFinite(z.high) &&
      z.high > z.low
    )
    .sort((a, b) => {
      if (b.quality !== a.quality) {
        return b.quality - a.quality;
      }

      return b.origin - a.origin;
    })
    .slice(0, 12);
}

export function nearestZone(zones, price, side) {
  const filtered = zones.filter(z =>
    side === 'BUY'
      ? z.type === 'DEMAND' &&
        z.high <= price + price * 0.01
      : z.type === 'SUPPLY' &&
        z.low >= price - price * 0.01
  );

  if (!filtered.length) return null;

  return filtered
    .sort((a, b) =>
      Math.abs(((a.low + a.high) / 2) - price) -
      Math.abs(((b.low + b.high) / 2) - price)
    )
    .at(0);
    }
