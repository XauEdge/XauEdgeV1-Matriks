import { cfg } from './config.js';

async function tg(method, body) {
  if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const r = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/${method}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'Telegram API error');
  return j.result;
}
export async function telegramInit() {
  if (!cfg.telegramToken) return;
  try { await tg('deleteWebhook', {drop_pending_updates:false}); } catch {}
}
export async function sendTelegram(text, chatId = cfg.telegramChatId) {
  if (!cfg.telegramToken || !chatId) return;
  await tg('sendMessage', {chat_id:chatId, text, parse_mode:'HTML', disable_web_page_preview:true});
}
export async function pollTelegram(offset = 0) {
  return tg('getUpdates', {timeout:Math.max(1, Math.floor(cfg.telegramPollMs/1000)), offset, allowed_updates:['message']});
}
export function fmt(n) { return Number(n).toFixed(2); }

export function setupMessage(s) {
  const c = s.context;
  return [
    '<b>🔥 XAU EDGE</b>', '',
    `<b>SETUP: ${s.direction}</b>`,
    `ZONE: <b>${fmt(s.zone.low)} - ${fmt(s.zone.high)}</b>`,
    `ENTRY: ${fmt(s.entry)}`,
    `SL: ${fmt(s.sl)}`,
    `TP1: ${fmt(s.tp1)}`,
    `TP2: ${fmt(s.tp2)}`,
    `TP3: ${fmt(s.tp3)}`,
    `RR: 1:${s.rr.toFixed(1)}`,
    '',
    `<b>M30:</b> ${c.m30.bias}`,
    `<b>M5:</b> ${c.m5.bias}`,
    `<b>STRUCTURE:</b> ${c.structureM5.bias}`,
    `<b>SWEEP:</b> ${s.direction==='BUY' ? (c.sweep.bullish?'YES':'NO') : (c.sweep.bearish?'YES':'NO')}`,
    `<b>MOMENTUM:</b> ${c.momentum.bias} | RSI ${c.momentum.rsi.toFixed(1)}`,
    `<b>SCORE:</b> ${s.score}/100`,
    '', '<b>STATUS: WAITING ZONE</b>'
  ].join('\n');
}

export function confirmationMessage(s, ai, technical) {
  const icon = ai.confirm ? '✅' : '❌';
  const head = ai.confirm ? 'ENTRY CONFIRMED' : 'SETUP INVALID';
  const extra = (ai.reasons || []).slice(0,3).join(', ');
  return [
    '<b>🚨 XAU EDGE</b>', '', `${icon} <b>${head}</b>`,
    `SIDE: <b>${s.direction}</b>`, `PRICE: <b>${fmt(technical.evidence?.price ?? s.entry)}</b>`,
    `ENTRY: ${fmt(s.entry)}`, `SL: ${fmt(s.sl)}`, `TP1: ${fmt(s.tp1)}`, `TP2: ${fmt(s.tp2)}`, `TP3: ${fmt(s.tp3)}`,
    '', `TECH SCORE: ${technical.score}/100`, `AI CONFIDENCE: ${Number(ai.confidence||0).toFixed(0)}/100`,
    extra ? `NOTE: ${extra}` : ''
  ].filter(Boolean).join('\n');
}

export function statusMessage(st) {
  const s = st.setup;
  if (!s) return `<b>🔥 XAU EDGE</b>\nSTATE: ${st.state}\nNo active setup.`;
  return ['<b>🔥 XAU EDGE</b>', `STATE: <b>${st.state}</b>`, `SIDE: <b>${s.direction}</b>`, `ZONE: ${fmt(s.zone.low)} - ${fmt(s.zone.high)}`, `ENTRY: ${fmt(s.entry)}`, `SL: ${fmt(s.sl)}`, `SCORE: ${s.score}/100`].join('\n');
}
