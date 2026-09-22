import { cfg } from './config.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    confirm: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    side: { type: 'string', enum: ['BUY', 'SELL', 'NONE'] },
    reasons: { type: 'array', items: { type: 'string' } },
    invalidation: { type: 'string' }
  },
  required: ['confirm','confidence','side','reasons','invalidation']
};

function timeoutSignal(ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal:c.signal, clear:()=>clearTimeout(t) }; }

export async function validateWithOpenAI(market, setup, technical) {
  if (!cfg.openaiEnabled || !cfg.openaiKey) return { enabled:false, confirm:false, confidence:0, reasons:['OPENAI_VALIDATOR_NOT_CONFIGURED'], invalidation:'AI not configured' };
  const ctl = timeoutSignal(cfg.openaiTimeoutMs);
  try {
    const body = {
      model: cfg.openaiModel,
      input: [
        { role:'system', content:[{type:'input_text', text:'You are the confirmation validator for an XAUUSD trading signal engine. Do not invent market data. Evaluate only the supplied evidence. A hard technical invalidation means confirm=false. The task is classification, not financial advice. Return only the requested JSON schema.'}] },
        { role:'user', content:[{type:'input_text', text: JSON.stringify({
          symbol: market.symbol,
          setup: {direction:setup.direction, zone:setup.zone, entry:setup.entry, sl:setup.sl, tp1:setup.tp1, tp2:setup.tp2, score:setup.score},
          latestTick: market.tick,
          technical
        })}] }
      ],
      text: { format: { type:'json_schema', name:'xau_edge_confirmation', strict:true, schema } }
    };
    const res = await fetch('https://api.openai.com/v1/responses', { method:'POST', headers:{'Authorization':`Bearer ${cfg.openaiKey}`,'Content-Type':'application/json'}, body:JSON.stringify(body), signal:ctl.signal });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const text = json.output_text || json.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('') || '';
    return { enabled:true, ...JSON.parse(text), responseId:json.id };
  } catch (e) {
    return { enabled:true, confirm:false, confidence:0, reasons:['OPENAI_VALIDATION_ERROR'], invalidation:String(e?.message || e) };
  } finally { ctl.clear(); }
}
