export const cfg = {
  symbol: "XAUUSD",

  marketApiUrl: "https://biquote.io/api/XAUUSD",
  ohlcApiUrl: "https://biquote.io/api/XAUUSD/ohlc",
  m5Interval: "5m",
  m30Interval: "30m",

  marketTimeout: 10000,

  pointSize: 0.01,
  maxSlPoints: 500,
  minRR: 1.5,

  minScoreSetup: 55,
  minScoreConfirm: 70,

  setupTtlMinutes: 60,
  zoneTouchBufferPoints: 20,

  m5Bars: 120,
  m30Bars: 120,

  fundamentalMode: "NOT_CONFIGURED",

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  openaiApiKey: process.env.OPENAI_API_KEY,

  port: Number(process.env.PORT || 8080)
};

export default cfg;
