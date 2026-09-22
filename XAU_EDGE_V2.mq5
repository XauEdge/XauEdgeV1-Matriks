#property strict
#property version   "2.0"
#property description "XAU EDGE V2 market-data bridge"

input string ApiBaseUrl = "https://YOUR-APP.YOUR-ACCOUNT.blitz.cloud";
input string IngestPath = "/ingest";
input string IngestKey = "CHANGE_ME";
input string SymbolName = "XAUUSD";
input int TickThrottleMs = 250;
input int M5Bars = 150;
input int M30Bars = 120;
input int WebTimeoutMs = 5000;

ulong lastSend = 0;
datetime lastM5Bar = 0;

string Num(double v) { return DoubleToString(v, 5); }
string JsonBar(MqlRates r) {
   return StringFormat("{\"time\":%I64d,\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s,\"volume\":%I64d}",
      (long)r.time, Num(r.open), Num(r.high), Num(r.low), Num(r.close), (long)r.tick_volume);
}
string BarsJson(ENUM_TIMEFRAMES tf, int count) {
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(SymbolName, tf, 0, count, rates);
   if(copied <= 0) return "[]";
   string out="[";
   for(int i=0;i<copied;i++) {
      if(i>0) out += ",";
      out += JsonBar(rates[i]);
   }
   out += "]";
   return out;
}
string BuildPayload(bool includeBars) {
   MqlTick t;
   if(!SymbolInfoTick(SymbolName,t)) return "";
   string p="{";
   p += "\"symbol\":\"" + SymbolName + "\",";
   p += "\"tick\":{";
   p += "\"time_msc\":" + LongToString((long)t.time_msc) + ",";
   p += "\"bid\":" + Num(t.bid) + ",";
   p += "\"ask\":" + Num(t.ask) + ",";
   p += "\"last\":" + Num(t.last) + ",";
   p += "\"volume\":" + LongToString((long)t.volume);
   p += "}";
   if(includeBars) {
      p += ",\"m5\":" + BarsJson(PERIOD_M5,M5Bars);
      p += ",\"m30\":" + BarsJson(PERIOD_M30,M30Bars);
   }
   p += "}";
   return p;
}

bool SendMarket(bool includeBars) {
   if(StringLen(ApiBaseUrl)<10 || StringFind(ApiBaseUrl,"YOUR-APP")>=0) {
      Print("XAU EDGE: set ApiBaseUrl first");
      return false;
   }
   string body=BuildPayload(includeBars);
   if(body=="") return false;
   string url=ApiBaseUrl+IngestPath;
   string headers="Content-Type: application/json\r\nx-ingest-key: "+IngestKey+"\r\n";
   char post[], result[];
   string result_headers;
   int n=StringToCharArray(body,post,0,WHOLE_ARRAY,CP_UTF8);
   if(n>0 && post[n-1]==0) ArrayResize(post,n-1);
   ResetLastError();
   int code=WebRequest("POST",url,headers,WebTimeoutMs,post,result,result_headers);
   if(code!=200) {
      PrintFormat("XAU EDGE ingest failed code=%d err=%d body=%s",code,GetLastError(),CharArrayToString(result));
      return false;
   }
   return true;
}

int OnInit() {
   EventSetMillisecondTimer(MathMax(100,TickThrottleMs));
   lastM5Bar=0;
   return(INIT_SUCCEEDED);
}
void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() {
   if(!SymbolSelect(SymbolName,true)) return;
   ulong now=GetTickCount64();
   bool enough=(now-lastSend >= (ulong)MathMax(100,TickThrottleMs));
   if(!enough) return;
   datetime currentBar=iTime(SymbolName,PERIOD_M5,0);
   bool newBar=(currentBar!=0 && currentBar!=lastM5Bar);
   if(newBar) lastM5Bar=currentBar;
   if(SendMarket(newBar)) lastSend=now;
}
void OnTick() {}
