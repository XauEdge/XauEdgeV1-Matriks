import { cfg } from './config.js';
import {
  atr,
  ema,
  rsi,
  bodyRatio,
  structureState,
  liquiditySweep,
  detectZones,
  clamp
} from './indicators.js';

function normalizeBars(bars = []) {
  return bars
    .map(b => ({
      time: Number(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume || 0)
    }))
    .filter(b =>
      [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)
    )
    .sort((a, b) => a.time - b.time);
}

function trendContext(bars) {
  const closes = bars.map(b => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const last = closes.at(-1);

  let bias = 'NEUTRAL';

  if (e20 && e50 && last > e20 && e20 > e50) {
    bias = 'BULLISH';
  }

  if (e20 && e50 && last < e20 && e20 < e50) {
    bias = 'BEARISH';
  }

  return {
    bias,
    ema20: e20,
    ema50: e50,
    price: last
  };
}

function momentumContext(bars, atrValue) {
  const closes = bars.map(b => b.close);
  const last = bars.at(-1);
  const r = rsi(closes, 14);
  const disp = bodyRatio(last);
  const range = last.high - last.low;

  let bias = 'NEUTRAL';

  if (r >= 55 && last.close > last.open) {
    bias = 'BULLISH';
  }

  if (r <= 45 && last.close < last.open) {
    bias = 'BEARISH';
  }

  return {
    rsi: r,
    bodyRatio: disp,
    range,
    rangeAtr: atrValue ? range / atrValue : 0,
    bias
  };
}

function chooseDirection(m30, m5, structure, sweep, momentum) {
  let bull = 0;
  let bear = 0;

  if (m30.bias === 'BULLISH') bull += 2;
  if (m30.bias === 'BEARISH') bear += 2;

  if (m5.bias === 'BULLISH') bull += 1;
  if (m5.bias === 'BEARISH') bear += 1;

  if (structure.bias === 'BULLISH') bull += 1;
  if (structure.bias === 'BEARISH') bear += 1;

  if (structure.bos === 'BULLISH') bull += 2;
  if (structure.bos === 'BEARISH') bear += 2;

  if (structure.choch === 'BULLISH') bull += 2;
  if (structure.choch === 'BEARISH') bear += 2;

  if (sweep.bullish) bull += 2;
  if (sweep.bearish) bear += 2;

  if (momentum.bias === 'BULLISH') bull += 1;
  if (momentum.bias === 'BEARISH') bear += 1;

  if (bull >= 4 && bull > bear) return 'BUY';
  if (bear >= 4 && bear > bull) return 'SELL';

  return 'NONE';
}

function buildSetup(market) {
  const m5 = normalizeBars(market.m5);
  const m30 = normalizeBars(market.m30);

  if (m5.length < 60 || m30.length < 60) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_MARKET_DATA'
    };
  }

  const price = Number(
    market.tick?.bid ||
    market.tick?.last ||
    m5.at(-1).close
  );

  const a5 = atr(m5, 14);
  const a30 = atr(m30, 14);

  const t30 = trendContext(m30);
  const t5 = trendContext(m5);

  const s30 = structureState(m30);
  const s5 = structureState(m5);

  const sweep = liquiditySweep(m5, 35);
  const mom = momentumContext(m5, a5);
  const zones = detectZones(m5, a5);

  const direction = chooseDirection(
    t30,
    t5,
    s5,
    sweep,
    mom
  );

  if (direction === 'NONE') {
    return {
      ok: false,
      reason: 'NO_DIRECTIONAL_ALIGNMENT',
      diagnostics: {
        t30,
        t5,
        s30,
        s5,
        sweep,
        mom
      }
    };
  }

  const candidateZones = zones
    .filter(z =>
      direction === 'BUY'
        ? z.type === 'DEMAND'
        : z.type === 'SUPPLY'
    )
    .map(z => {
      const entry = (z.low + z.high) / 2;

      const buffer = Math.max(
        a5 * 0.15,
        cfg.pointSize * 3
      );

      const sl =
        direction === 'BUY'
          ? z.low - buffer
          : z.high + buffer;

      const risk = Math.abs(entry - sl);

      const distance = Math.abs(
        price - entry
      );

      return {
        ...z,
        entry,
        sl,
        risk,
        distance
      };
    })
    .filter(z =>
      z.risk > 0 &&
      z.risk <= cfg.maxSlPoints * cfg.pointSize
    )
    .sort((a, b) =>
      (a.distance - b.distance) ||
      (b.quality - a.quality)
    );

  if (!candidateZones.length) {
    return {
      ok: false,
      reason: 'RISK_DISTANCE_TOO_LARGE',
      diagnostics: {
        maxRisk: cfg.maxSlPoints * cfg.pointSize,
        zoneCount: zones.length,
        direction
      }
    };
  }

  const z = candidateZones[0];

  const entry = z.entry;
  const sl = z.sl;
  const risk = z.risk;

  const maxSl = cfg.maxSlPoints * cfg.pointSize;

  const tp1 =
    direction === 'BUY'
      ? entry + risk * Math.max(1.2, cfg.minRR * 0.6)
      : entry - risk * Math.max(1.2, cfg.minRR * 0.6);

  const tp2 =
    direction === 'BUY'
      ? entry + risk * cfg.minRR
      : entry - risk * cfg.minRR;

  const tp3 =
    direction === 'BUY'
      ? entry + risk * (cfg.minRR + 1)
      : entry - risk * (cfg.minRR + 1);

  let score = 0;
  const checks = [];

  const add = (label, pass, pts) => {
    checks.push({
      label,
      pass,
      pts
    });

    if (pass) {
      score += pts;
    }
  };

  add(
    'M30 trend',
    direction === 'BUY'
      ? t30.bias === 'BULLISH'
      : t30.bias === 'BEARISH',
    15
  );

  add(
    'M5 trend',
    direction === 'BUY'
      ? t5.bias === 'BULLISH'
      : t5.bias === 'BEARISH',
    10
  );

  add(
    'M5 structure',
    direction === 'BUY'
      ? s5.bias === 'BULLISH'
      : s5.bias === 'BEARISH',
    10
  );

  add(
    'BOS',
    direction === 'BUY'
      ? s5.bos === 'BULLISH'
      : s5.bos === 'BEARISH',
    15
  );

  add(
    'CHoCH',
    direction === 'BUY'
      ? s5.choch === 'BULLISH'
      : s5.choch === 'BEARISH',
    10
  );

  add(
    'Liquidity sweep',
    direction === 'BUY'
      ? sweep.bullish
      : sweep.bearish,
    15
  );

  add(
    'Momentum',
    direction === 'BUY'
      ? mom.bias === 'BULLISH'
      : mom.bias === 'BEARISH',
    10
  );

  add(
    'Zone quality',
    z.quality >= 1.0,
    5
  );

  add(
    'Risk guard',
    risk <= maxSl,
    5
  );

  score = clamp(score, 0, 100);

  if (score < cfg.minScoreSetup) {
    return {
      ok: false,
      reason: 'SETUP_SCORE_TOO_LOW',
      diagnostics: {
        score,
        checks,
        z,
        t30,
        t5,
        s30,
        s5,
        sweep,
        mom
      }
    };
  }

  return {
    ok: true,
    setup: {
      id: crypto.randomUUID(),
      symbol: market.symbol || cfg.symbol,
      direction,

      zone: {
        low: z.low,
        high: z.high,
        type: z.type,
        quality: z.quality
      },

      entry,
      sl,
      tp1,
      tp2,
      tp3,

      risk,
      rr: cfg.minRR,
      score,

      createdAt: new Date().toISOString(),
      expiresAt:
        Date.now() +
        cfg.setupTtlMinutes * 60000,

      checks,

      context: {
        m30: t30,
        m5: t5,
        structureM30: s30,
        structureM5: s5,
        sweep,
        momentum: mom,
        atr5: a5,
        atr30: a30
      },

      fundamental: {
        mode: cfg.fundamentalMode,
        status: 'NOT_CONFIGURED'
      }
    }
  };
}

function hardConfirmation(market, setup) {
  const m5 = normalizeBars(market.m5);
  const m30 = normalizeBars(market.m30);

  const price = Number(
    market.tick?.bid ||
    market.tick?.last
  );

  if (!Number.isFinite(price)) {
    return {
      valid: false,
      score: 0,
      reasons: ['NO_PRICE']
    };
  }

  const a5 = atr(m5, 14);
  const t30 = trendContext(m30);
  const t5 = trendContext(m5);
  const s5 = structureState(m5);
  const sweep = liquiditySweep(m5, 35);
  const mom = momentumContext(m5, a5);

  const buffer =
    cfg.zoneTouchBufferPoints *
    cfg.pointSize;

  const inside =
    price >= setup.zone.low - buffer &&
    price <= setup.zone.high + buffer;

  let score = 0;
  const reasons = [];

  const check = (name, pass, pts, failReason) => {
    if (pass) {
      score += pts;
    } else {
      reasons.push(failReason || name);
    }
  };

  check(
    'zone touch',
    inside,
    10,
    'PRICE_NOT_IN_ZONE'
  );

  check(
    'M30 alignment',
    setup.direction === 'BUY'
      ? t30.bias === 'BULLISH'
      : t30.bias === 'BEARISH',
    15,
    'M30_MISALIGNED'
  );

  check(
    'M5 alignment',
    setup.direction === 'BUY'
      ? t5.bias === 'BULLISH'
      : t5.bias === 'BEARISH',
    10,
    'M5_MISALIGNED'
  );

  check(
    'structure',
    setup.direction === 'BUY'
      ? s5.bias === 'BULLISH'
      : s5.bias === 'BEARISH',
    10,
    'STRUCTURE_MISALIGNED'
  );

  check(
    'BOS',
    setup.direction === 'BUY'
      ? s5.bos === 'BULLISH'
      : s5.bos === 'BEARISH',
    15,
    'BOS_NOT_CONFIRMED'
  );

  check(
    'CHoCH',
    setup.direction === 'BUY'
      ? s5.choch === 'BULLISH'
      : s5.choch === 'BEARISH',
    10,
    'CHoCH_NOT_CONFIRMED'
  );

  check(
    'sweep/rejection',
    setup.direction === 'BUY'
      ? sweep.bullish
      : sweep.bearish,
    15,
    'NO_SWEEP_CONFIRMATION'
  );

  check(
    'momentum',
    setup.direction === 'BUY'
      ? mom.bias === 'BULLISH'
      : mom.bias === 'BEARISH',
    10,
    'MOMENTUM_MISALIGNED'
  );

  check(
    'risk',
    setup.risk <=
      cfg.maxSlPoints * cfg.pointSize,
    5,
    'RISK_INVALID'
  );

  const invalid =
    setup.direction === 'BUY'
      ? price < setup.sl
      : price > setup.sl;

  if (invalid) {
    reasons.push('SL_LEVEL_BROKEN');
  }

  return {
    valid:
      inside &&
      !invalid &&
      score >= cfg.minScoreConfirm,

    score,
    reasons,

    evidence: {
      price,
      t30,
      t5,
      s5,
      sweep,
      mom,
      atr5: a5
    }
  };
}

export function generateSetup(market) {
  return buildSetup(market);
}

export {
  hardConfirmation
};
