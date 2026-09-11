#property strict
#property version   "1.00"
#property description "Signal Stack outbound bridge for MetaTrader VPS"

#include <Trade/Trade.mqh>
CTrade trade;

input string SignalStackBaseUrl = "https://YOUR-SIGNAL-STACK-DOMAIN";
input string TerminalId = "ftmo-primary";
input string TerminalToken = "";
input int PollSeconds = 2;

string AccountLogin() { return IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)); }
string AccountServer() { return AccountInfoString(ACCOUNT_SERVER); }

string JsonEscape(string s) {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
}

bool PostJson(string path, string body, string &response, int &status) {
   string url = SignalStackBaseUrl + path;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + TerminalToken + "\r\n";
   char data[]; char result[]; string result_headers;
   StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   ResetLastError();
   status = WebRequest("POST", url, headers, 8000, data, result, result_headers);
   if(status == -1) {
      Print("Signal Stack WebRequest failed. Error=", GetLastError(), " URL=", url);
      return false;
   }
   response = CharArrayToString(result, 0, -1, CP_UTF8);
   return status >= 200 && status < 300;
}

bool Contains(string haystack, string needle) { return StringFind(haystack, needle) >= 0; }
string ExtractString(string json, string key) {
   string marker = "\"" + key + "\":\"";
   int start = StringFind(json, marker);
   if(start < 0) return "";
   start += StringLen(marker);
   int end = StringFind(json, "\"", start);
   if(end < 0) return "";
   return StringSubstr(json, start, end - start);
}

double ExtractNumber(string json, string key, double fallback = 0.0) {
   string marker = "\"" + key + "\":";
   int start = StringFind(json, marker);
   if(start < 0) return fallback;
   start += StringLen(marker);
   int end = start;
   while(end < StringLen(json)) {
      ushort c = StringGetCharacter(json, end);
      if((c >= '0' && c <= '9') || c == '.' || c == '-') end++; else break;
   }
   string raw = StringSubstr(json, start, end - start);
   return raw == "" ? fallback : StringToDouble(raw);
}

void Report(string commandId, bool success, string resultJson, string errorText = "") {
   string body = "{\"accountLogin\":\"" + JsonEscape(AccountLogin()) + "\",\"terminalId\":\"" + JsonEscape(TerminalId) + "\",\"commandId\":\"" + JsonEscape(commandId) + "\",\"success\":" + (success ? "true" : "false") + ",\"result\":" + (resultJson == "" ? "{}" : resultJson) + ",\"error\":\"" + JsonEscape(errorText) + "\"}";
   string response; int status;
   PostJson("/api/mt5-ea/report", body, response, status);
}

void HandleCommand(string json) {
   string commandId = ExtractString(json, "id");
   string commandType = ExtractString(json, "command_type");
   if(commandId == "" || commandType == "") return;

   if(commandType == "health") {
      string result = "{\"ok\":true,\"login\":\"" + AccountLogin() + "\",\"server\":\"" + JsonEscape(AccountServer()) + "\",\"terminalId\":\"" + JsonEscape(TerminalId) + "\"}";
      Report(commandId, true, result);
      return;
   }

   if(commandType == "account_summary") {
      string result = "{\"ok\":true,\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2) + ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2) + ",\"marginFree\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2) + "}";
      Report(commandId, true, result);
      return;
   }

   if(commandType == "positions_list") {
      Report(commandId, true, "{\"ok\":true,\"positionCount\":" + IntegerToString(PositionsTotal()) + "}");
      return;
   }

   if(commandType == "order_place") {
      string symbol = ExtractString(json, "symbol");
      string side = ExtractString(json, "side");
      double volume = ExtractNumber(json, "volume", 0.0);
      double sl = ExtractNumber(json, "stopLoss", 0.0);
      double tp = ExtractNumber(json, "takeProfit", 0.0);
      if(symbol == "" || volume <= 0.0 || (side != "buy" && side != "sell")) {
         Report(commandId, false, "{}", "Invalid order payload");
         return;
      }
      trade.SetAsyncMode(false);
      bool ok = side == "buy" ? trade.Buy(volume, symbol, 0.0, sl, tp, "SignalStack") : trade.Sell(volume, symbol, 0.0, sl, tp, "SignalStack");
      if(!ok) { Report(commandId, false, "{}", trade.ResultRetcodeDescription()); return; }
      string result = "{\"ok\":true,\"order\":" + IntegerToString((long)trade.ResultOrder()) + ",\"deal\":" + IntegerToString((long)trade.ResultDeal()) + ",\"price\":" + DoubleToString(trade.ResultPrice(), _Digits) + "}";
      Report(commandId, true, result);
      return;
   }

   if(commandType == "position_close") {
      string positionId = ExtractString(json, "positionId");
      ulong ticket = (ulong)StringToInteger(positionId);
      if(ticket == 0) { Report(commandId, false, "{}", "Invalid position ticket"); return; }
      bool ok = trade.PositionClose(ticket);
      if(!ok) { Report(commandId, false, "{}", trade.ResultRetcodeDescription()); return; }
      Report(commandId, true, "{\"ok\":true}");
      return;
   }

   Report(commandId, false, "{}", "Unsupported command type");
}

void Heartbeat() {
   string body = "{\"accountLogin\":\"" + AccountLogin() + "\",\"terminalId\":\"" + JsonEscape(TerminalId) + "\",\"server\":\"" + JsonEscape(AccountServer()) + "\"}";
   string response; int status;
   PostJson("/api/mt5-ea/heartbeat", body, response, status);
}

void Poll() {
   string body = "{\"accountLogin\":\"" + AccountLogin() + "\",\"terminalId\":\"" + JsonEscape(TerminalId) + "\"}";
   string response; int status;
   if(!PostJson("/api/mt5-ea/poll", body, response, status)) return;
   if(Contains(response, "\"command\":null")) return;
   HandleCommand(response);
}

int OnInit() {
   if(TerminalToken == "") { Print("Signal Stack EA token is required"); return INIT_PARAMETERS_INCORRECT; }
   EventSetTimer(MathMax(PollSeconds, 1));
   Heartbeat();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { static int heartbeatCounter = 0; Poll(); heartbeatCounter++; if(heartbeatCounter >= 15) { Heartbeat(); heartbeatCounter = 0; } }
