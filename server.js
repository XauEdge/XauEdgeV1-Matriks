import http from 'node:http';
import { cfg } from './config.js';
import { loadState, getState, updateState, addEvent } from './storage.js';
import { generateSetup, hardConfirmation } from './analysis.js';
import { validateWithOpenAI } from './openai.js';
import { telegramInit, sendTelegram, pollTelegram, setupMessage, confirmationMessage, statusMessage } from './telegram.js';

let telegramOffset = 0;
let processingConfirmation = false;

function json(res, code, body) { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(body)); }
async function readBody(req) { let d=''; for await (const c of req) d+=c; if(d.length>2_000_000) throw new Error('body too large'); return d ? JSON.parse(d) : {}; }
function auth(req) { return !cfg.ingestKey || req.headers['x-ingest-key'] === cfg.ingestKey; }
function chatAllowed(id) { return !cfg.telegramChatId || String(id) === cfg.telegramChatId; }

async function createSetup(reason='manual') {
  const st = getState();
  if (st.cooldownUntil && Date.now() < st.cooldownUntil) return {ok:false,reason:'COOLDOWN'};
  if (!st.latestMarket) return {ok:false,reason:'NO_MARKET_DATA'};
  if (st.state === 'WAITING_ZONE' || st.state === 'RECHECKING') return {ok:false,reason:'SETUP_ALREADY_ACTIVE',setup:st.setup};
  const result = generateSetup(st.latestMarket);
  addEvent('setup_analysis', {reason, result});
  if (!result.ok) {
    await updateState(s => { s.state='IDLE'; s.setup=null; });
    return result;
  }
  await updateState(s => { s.state='WAITING_ZONE'; s.setup=result.setup; });
  await sendTelegram(setupMessage(result.setup));
  return result;
}

async function confirmIfTouched() {
  if (processingConfirmation) return;
  const st = getState();
  const setup = st.setup;
  if (st.state !== 'WAITING_ZONE' || !setup || !st.latestMarket) return;
  if (Date.now() < (st.lastConfirmationAt || 0) + cfg.confirmCooldownSeconds*1000) return;
  if (Date.now() > setup.expiresAt) {
    await updateState(s=>{s.state='IDLE';s.setup=null;});
    await sendTelegram('<b>⚠️ XAU EDGE</b>\nSETUP EXPIRED.');
    return;
  }
  const price = Number(st.latestMarket.tick?.bid || st.latestMarket.tick?.last);
  const buffer = cfg.zoneTouchBufferPoints * cfg.pointSize;
  if (!(price >= setup.zone.low-buffer && price <= setup.zone.high+buffer)) {
    const broken = setup.direction==='BUY' ? price < setup.zone.low-buffer : price > setup.zone.high+buffer;
    const farBreak = setup.direction==='BUY' ? price < setup.sl : price > setup.sl;
    if (broken || farBreak) {
      await updateState(s=>{s.state='INVALID'; s.lastConfirmationAt=Date.now(); s.cooldownUntil=Date.now()+cfg.postConfirmCooldownMinutes*60000;});
      addEvent('zone_broken',{price,setupId:setup.id});
      await sendTelegram('<b>⚠️ XAU EDGE</b>\nZONE BROKEN / SETUP INVALID.\nNo entry.');
      setTimeout(()=>updateState(s=>{ if(s.state==='INVALID'){s.state='IDLE';s.setup=null;} }).catch(()=>{}), cfg.postConfirmCooldownMinutes*60000);
    }
    return;
  }

  processingConfirmation = true;
  await updateState(s=>{s.state='RECHECKING';s.lastConfirmationAt=Date.now();});
  try {
    const technical = hardConfirmation(st.latestMarket, setup);
    let ai = {enabled:false,confirm:false,confidence:0,reasons:['AI disabled']};
    if (technical.valid) ai = await validateWithOpenAI(st.latestMarket, setup, technical);
    const confirmed = technical.valid && ai.confirm === true && Number(ai.confidence) >= 65;
    addEvent('confirmation',{technical,ai,confirmed});
    if (confirmed) {
      await updateState(s=>{s.state='CONFIRMED';s.cooldownUntil=Date.now()+cfg.postConfirmCooldownMinutes*60000;});
      await sendTelegram(confirmationMessage(setup,ai,technical));
    } else {
      await updateState(s=>{s.state='INVALID';s.cooldownUntil=Date.now()+Math.min(15,cfg.postConfirmCooldownMinutes)*60000;});
      await sendTelegram(confirmationMessage(setup,{...ai,confirm:false},technical));
    }
  } finally {
    processingConfirmation = false;
  }
}

async function handleCommand(msg) {
  const chatId = msg.chat?.id;
  if (!chatAllowed(chatId)) return;
  const text = String(msg.text || '').trim().split(/\s+/)[0].toLowerCase();
  if (text === '/signal' || text === '/start') {
    const r = await createSetup('telegram');
    if (!r.ok) await sendTelegram(`<b>🔥 XAU EDGE</b>\nNO SETUP: ${r.reason}`, chatId);
    return;
  }
  if (text === '/status') { await sendTelegram(statusMessage(getState()), chatId); return; }
  if (text === '/cancel') {
    await updateState(s=>{s.state='IDLE';s.setup=null;s.cooldownUntil=0;});
    await sendTelegram('<b>🔥 XAU EDGE</b>\nACTIVE SETUP CANCELLED.', chatId); return;
  }
  if (text === '/help') {
    await sendTelegram('<b>🔥 XAU EDGE</b>\n/signal = cari setup\n/status = status setup\n/cancel = batalkan setup\n\nSetup tidak menjadi entry sampai harga menyentuh zona dan lolos konfirmasi.', chatId);
  }
}

async function telegramLoop() {
  if (!cfg.telegramToken) return;
  while (true) {
    try {
      const updates = await pollTelegram(telegramOffset);
      for (const u of updates) { telegramOffset = u.update_id + 1; if (u.message) await handleCommand(u.message); }
    } catch (e) { console.error('telegram', e.message); await new Promise(r=>setTimeout(r,3000)); }
  }
}

async function server() {
  await loadState();
  await telegramInit();
  telegramLoop();
  const srv = http.createServer(async (req,res)=>{
    try {
      const url = new URL(req.url, `http://${req.headers.host||'localhost'}`);
      if (req.method==='GET' && url.pathname==='/health') return json(res,200,{ok:true,state:getState().state,updatedAt:getState().updatedAt,hasMarket:!!getState().latestMarket});
      if (req.method==='GET' && url.pathname==='/state') return json(res,200,getState());
      if (req.method==='POST' && url.pathname==='/signal') { if(!auth(req)) return json(res,401,{ok:false}); const r=await createSetup('http'); return json(res,r.ok?200:409,r); }
      if (req.method==='POST' && url.pathname==='/ingest') {
        if(!auth(req)) return json(res,401,{ok:false,error:'unauthorized'});
        const body=await readBody(req);
        if(body.symbol && body.symbol!==cfg.symbol) return json(res,400,{ok:false,error:'symbol_mismatch'});
        await updateState(s=>{s.latestMarket=body;});
        await confirmIfTouched();
        return json(res,200,{ok:true,state:getState().state});
      }
      return json(res,404,{ok:false,error:'not_found'});
    } catch(e) { console.error(e); return json(res,500,{ok:false,error:e.message}); }
  });
  srv.listen(cfg.port,()=>console.log(`XAU EDGE V2 listening on :${cfg.port}`));
  process.on('SIGTERM',()=>srv.close(()=>process.exit(0)));
  process.on('SIGINT',()=>srv.close(()=>process.exit(0)));
}
server().catch(e=>{console.error(e);process.exit(1);});
