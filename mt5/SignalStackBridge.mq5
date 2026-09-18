#property strict
#property version   "1.24"
#property description "Signal Stack outbound bridge for MetaTrader VPS"

#include <Trade/Trade.mqh>
CTrade trade;

input string SignalStackBaseUrl = "https://app.ssforexclub.com";
input string TerminalId = "ftmo-primary";
input string TerminalToken = "";
input int PollSeconds = 2;
input ulong SignalStackMagic = 560091247;

// Risk policy remains 1.21. Bridge v1.24 keeps deterministic broker fill
// reconciliation and adds read-only Signal Stack deal history so exact FTMO
// outcomes can feed the account/engine/pair learning loop.
const string BRIDGE_VERSION = "1.24";
const string RISK_POLICY_VERSION = "1.21";
const double BASE_RISK_PERCENT = 1.0;
const double POST_SL_RISK_PERCENT = 0.5;
const double DAILY_LOSS_LOCK_PERCENT = 2.0;
const double STOP_LOSS_PIPS = 10.0;
const double BREAK_EVEN_PIPS = 10.0;
const double FIRST_PARTIAL_PIPS = 15.0;
const double FIRST_PARTIAL_PERCENT = 80.0;
const double FINAL_TAKE_PROFIT_PIPS = 18.0;

string AccountLogin() { return IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)); }
string AccountServer() { return AccountInfoString(ACCOUNT_SERVER); }

string JsonEscape(string s) {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", "\\r");
   StringReplace(s, "\n", "\\n");
   return s;
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
   while(start < StringLen(json) && StringGetCharacter(json, start) == ' ') start++;
   int end = start;
   while(end < StringLen(json)) {
      ushort c = StringGetCharacter(json, end);
      if((c >= '0' && c <= '9') || c == '.' || c == '-') end++;
      else break;
   }
   string raw = StringSubstr(json, start, end - start);
   return raw == "" ? fallback : StringToDouble(raw);
}

bool ExtractBool(string json, string key, bool fallback = false) {
   string marker = "\"" + key + "\":";
   int start = StringFind(json, marker);
   if(start < 0) return fallback;
   start += StringLen(marker);
   string tail = StringSubstr(json, start, 5);
   StringToLower(tail);
   if(StringFind(tail, "true") == 0) return true;
   if(StringFind(tail, "false") == 0) return false;
   return fallback;
}

string CompactSignalSymbol(string symbol) {
   string compact = symbol;
   StringReplace(compact, "_", "");
   StringReplace(compact, "/", "");
   return compact;
}

bool TrySelectSymbol(string symbol) {
   if(symbol == "") return false;
   return SymbolSelect(symbol, true);
}

string ResolveMt5Symbol(string signalSymbol) {
   string raw = signalSymbol;
   if(TrySelectSymbol(raw)) return raw;

   string compact = CompactSignalSymbol(raw);
   if(TrySelectSymbol(compact)) return compact;

   string sim = compact + ".sim";
   if(TrySelectSymbol(sim)) return sim;

   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++) {
      string candidate = SymbolName(i, false);
      if(StringFind(candidate, compact) == 0 && TrySelectSymbol(candidate)) return candidate;
   }
   return "";
}

void LogSymbolResolution(string signalSymbol) {
   string resolved = ResolveMt5Symbol(signalSymbol);
   if(resolved == "") Print("Signal Stack symbol resolution FAILED: ", signalSymbol);
   else Print("Signal Stack symbol map: ", signalSymbol, " -> ", resolved);
}

bool PostJson(string path, string body, string &response, int &status) {
   string url = SignalStackBaseUrl + path;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + TerminalToken + "\r\n";
   char data[]; char result[]; string result_headers;

   StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   int dataSize = ArraySize(data);
   if(dataSize > 0 && data[dataSize - 1] == 0) ArrayResize(data, dataSize - 1);

   ResetLastError();
   status = WebRequest("POST", url, headers, 8000, data, result, result_headers);
   if(status == -1) {
      Print("Signal Stack WebRequest failed. Error=", GetLastError(), " URL=", url);
      return false;
   }

   response = CharArrayToString(result, 0, -1, CP_UTF8);
   if(status < 200 || status >= 300) {
      Print("Signal Stack HTTP status=", status, " URL=", url, " Response=", response);
   }
   return status >= 200 && status < 300;
}

// ─────────────────────────────────────────────────────────────────────────────
// New York trading-day state
// ─────────────────────────────────────────────────────────────────────────────
int DayOfWeekForUtcDate(int year, int month, int day, int hour = 0) {
   MqlDateTime dt;
   dt.year = year; dt.mon = month; dt.day = day;
   dt.hour = hour; dt.min = 0; dt.sec = 0;
   datetime stamp = StructToTime(dt);
   MqlDateTime out;
   TimeToStruct(stamp, out);
   return out.day_of_week;
}

int FirstSundayDay(int year, int month) {
   int dow = DayOfWeekForUtcDate(year, month, 1);
   return 1 + ((7 - dow) % 7);
}

bool IsNewYorkDst(datetime gmtNow) {
   MqlDateTime g;
   TimeToStruct(gmtNow, g);
   int secondSundayMarch = FirstSundayDay(g.year, 3) + 7;
   int firstSundayNovember = FirstSundayDay(g.year, 11);

   MqlDateTime start;
   start.year = g.year; start.mon = 3; start.day = secondSundayMarch;
   start.hour = 7; start.min = 0; start.sec = 0;
   MqlDateTime finish;
   finish.year = g.year; finish.mon = 11; finish.day = firstSundayNovember;
   finish.hour = 6; finish.min = 0; finish.sec = 0;

   datetime startUtc = StructToTime(start);
   datetime finishUtc = StructToTime(finish);
   return gmtNow >= startUtc && gmtNow < finishUtc;
}

datetime NewYorkNow() {
   datetime gmtNow = TimeGMT();
   int offsetHours = IsNewYorkDst(gmtNow) ? -4 : -5;
   return gmtNow + offsetHours * 3600;
}

string NyDayKey() {
   MqlDateTime ny;
   TimeToStruct(NewYorkNow(), ny);
   return StringFormat("%04d%02d%02d", ny.year, ny.mon, ny.day);
}

string DailyStartKey() { return "SS_DAYSTART_" + AccountLogin() + "_" + NyDayKey(); }
string DailyLockKey() { return "SS_DAYLOCK_" + AccountLogin() + "_" + NyDayKey(); }
string ReducedRiskKey() { return "SS_REDUCED_" + AccountLogin() + "_" + NyDayKey(); }
string PositionInitialVolumeKey(ulong ticket) { return "SS_INITVOL_" + AccountLogin() + "_" + IntegerToString((long)ticket); }
string PositionBreakEvenKey(ulong ticket) { return "SS_BE_" + AccountLogin() + "_" + IntegerToString((long)ticket); }
string PositionPartialKey(ulong ticket) { return "SS_P80_" + AccountLogin() + "_" + IntegerToString((long)ticket); }

void EnsureDailyState() {
   string startKey = DailyStartKey();
   if(!GlobalVariableCheck(startKey)) {
      GlobalVariableSet(startKey, AccountInfoDouble(ACCOUNT_BALANCE));
      GlobalVariableSet(DailyLockKey(), 0.0);
      GlobalVariableSet(ReducedRiskKey(), 0.0);
      Print("Signal Stack daily risk baseline initialized. NYDay=", NyDayKey(),
            " StartBalance=", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2));
   }
}

double DailyStartingBalance() {
   EnsureDailyState();
   return GlobalVariableGet(DailyStartKey());
}

bool DailyTradingLocked() {
   EnsureDailyState();
   return GlobalVariableCheck(DailyLockKey()) && GlobalVariableGet(DailyLockKey()) > 0.5;
}

bool ReducedRiskActive() {
   EnsureDailyState();
   return GlobalVariableCheck(ReducedRiskKey()) && GlobalVariableGet(ReducedRiskKey()) > 0.5;
}

double EffectiveRiskPercent() {
   return ReducedRiskActive() ? POST_SL_RISK_PERCENT : BASE_RISK_PERCENT;
}

double DailyLossPercent() {
   double start = DailyStartingBalance();
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(start <= 0.0) return 0.0;
   return MathMax(0.0, ((start - equity) / start) * 100.0);
}

bool IsSignalStackPositionSelected() {
   long magic = PositionGetInteger(POSITION_MAGIC);
   string comment = PositionGetString(POSITION_COMMENT);
   return (ulong)magic == SignalStackMagic || StringFind(comment, "SignalStack") == 0;
}

void CloseAllSignalStackPositions(string reason) {
   trade.SetAsyncMode(false);
   trade.SetExpertMagicNumber(SignalStackMagic);
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !IsSignalStackPositionSelected()) continue;
      if(!trade.PositionClose(ticket)) {
         Print("Signal Stack risk close FAILED ticket=", ticket, " reason=", reason,
               " broker=", trade.ResultRetcodeDescription());
      } else {
         Print("Signal Stack risk close ticket=", ticket, " reason=", reason);
      }
   }
}

void EnforceDailyLossLock() {
   EnsureDailyState();
   double lossPct = DailyLossPercent();
   if(!DailyTradingLocked() && lossPct >= DAILY_LOSS_LOCK_PERCENT) {
      GlobalVariableSet(DailyLockKey(), 1.0);
      Print("SIGNAL STACK DAILY LOCK ACTIVATED: equity drawdown=", DoubleToString(lossPct, 3),
            "% limit=", DoubleToString(DAILY_LOSS_LOCK_PERCENT, 2),
            "%. Closing SignalStack positions and blocking new trades until next NY trading day.");
   }
   if(DailyTradingLocked()) CloseAllSignalStackPositions("2% daily loss lock");
}

// ─────────────────────────────────────────────────────────────────────────────
// MT5 volume geometry and risk sizing
// ─────────────────────────────────────────────────────────────────────────────
double PipSize(string symbol) {
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(digits == 3 || digits == 5) return point * 10.0;
   return point;
}

int VolumeDigits(string symbol) {
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   int digits = 0;
   while(digits < 8 && NormalizeDouble(step, digits) != step) digits++;
   return digits;
}

double NormalizeVolumeDown(string symbol, double volume) {
   double minVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0) step = minVol > 0.0 ? minVol : 0.01;
   double capped = MathMin(maxVol, volume);
   double steps = MathFloor((capped + 1e-12) / step);
   double normalized = NormalizeDouble(steps * step, VolumeDigits(symbol));
   if(normalized < minVol) return 0.0;
   return normalized;
}

double RiskSizedVolume(string symbol, string side, double entry, double stop, double riskPercent) {
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskUsd = balance * (riskPercent / 100.0);
   ENUM_ORDER_TYPE orderType = side == "buy" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double hypothetical = 0.0;
   if(!OrderCalcProfit(orderType, symbol, 1.0, entry, stop, hypothetical)) return 0.0;
   double lossPerLot = MathAbs(hypothetical);
   if(lossPerLot <= 0.0) return 0.0;
   return NormalizeVolumeDown(symbol, riskUsd / lossPerLot);
}

double ContractSize(string symbol) {
   double contract = SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   return contract > 0.0 ? contract : 0.0;
}

double NotionalUnitsFromVolume(string symbol, double volume) {
   double contract = ContractSize(symbol);
   return contract > 0.0 && volume > 0.0 ? contract * volume : 0.0;
}

ulong FindNewestSignalStackPosition(string symbol) {
   ulong bestTicket = 0;
   long bestTime = 0;
   for(int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || PositionGetString(POSITION_SYMBOL) != symbol || !IsSignalStackPositionSelected()) continue;
      long t = PositionGetInteger(POSITION_TIME_MSC);
      if(t >= bestTime) { bestTime = t; bestTicket = ticket; }
   }
   return bestTicket;
}

ulong FindPositionByIdentifier(ulong identifier, string symbol) {
   if(identifier == 0) return 0;
   for(int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != symbol) continue;
      if(!IsSignalStackPositionSelected()) continue;
      ulong currentIdentifier = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
      if(currentIdentifier == identifier) return ticket;
   }
   return 0;
}

bool ResolveExecutionFill(string symbol,
                          datetime submittedAt,
                          ulong orderTicket,
                          ulong &dealTicket,
                          ulong &positionTicket,
                          ulong &positionIdentifier,
                          double &fillPrice) {
   dealTicket = trade.ResultDeal();
   positionTicket = 0;
   positionIdentifier = 0;
   fillPrice = trade.ResultPrice();

   for(int attempt = 0; attempt < 20; attempt++) {
      if(orderTicket > 0 && PositionSelectByTicket(orderTicket)) {
         if(PositionGetString(POSITION_SYMBOL) == symbol && IsSignalStackPositionSelected()) {
            positionTicket = orderTicket;
            positionIdentifier = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
            if(fillPrice <= 0.0) fillPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         }
      }

      if(dealTicket > 0 && HistoryDealSelect(dealTicket)) {
         if(positionIdentifier == 0)
            positionIdentifier = (ulong)HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
         if(fillPrice <= 0.0)
            fillPrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
      }

      if(orderTicket > 0 && (dealTicket == 0 || positionIdentifier == 0 || fillPrice <= 0.0)) {
         datetime from = submittedAt > 10 ? submittedAt - 10 : 0;
         HistorySelect(from, TimeCurrent() + 10);
         for(int i = HistoryDealsTotal() - 1; i >= 0; i--) {
            ulong candidate = HistoryDealGetTicket(i);
            if(candidate == 0) continue;
            if((ulong)HistoryDealGetInteger(candidate, DEAL_ORDER) != orderTicket) continue;
            if((ulong)HistoryDealGetInteger(candidate, DEAL_MAGIC) != SignalStackMagic) continue;
            if(HistoryDealGetString(candidate, DEAL_SYMBOL) != symbol) continue;
            ENUM_DEAL_ENTRY dealEntry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(candidate, DEAL_ENTRY);
            if(dealEntry != DEAL_ENTRY_IN && dealEntry != DEAL_ENTRY_INOUT) continue;

            dealTicket = candidate;
            positionIdentifier = (ulong)HistoryDealGetInteger(candidate, DEAL_POSITION_ID);
            fillPrice = HistoryDealGetDouble(candidate, DEAL_PRICE);
            break;
         }
      }

      if(positionTicket == 0 && positionIdentifier > 0)
         positionTicket = FindPositionByIdentifier(positionIdentifier, symbol);

      if(positionTicket == 0) {
         ulong newest = FindNewestSignalStackPosition(symbol);
         if(newest > 0 && PositionSelectByTicket(newest)) {
            datetime openedAt = (datetime)PositionGetInteger(POSITION_TIME);
            if(openedAt >= submittedAt - 2) {
               positionTicket = newest;
               if(positionIdentifier == 0)
                  positionIdentifier = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
               if(fillPrice <= 0.0)
                  fillPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            }
         }
      }

      if(dealTicket > 0 && positionTicket > 0 && positionIdentifier > 0 && fillPrice > 0.0)
         return true;

      Sleep(50);
   }

   return dealTicket > 0 && positionTicket > 0 && positionIdentifier > 0 && fillPrice > 0.0;
}

void StoreInitialPositionState(ulong ticket) {
   if(ticket == 0 || !PositionSelectByTicket(ticket)) return;
   if(!GlobalVariableCheck(PositionInitialVolumeKey(ticket)))
      GlobalVariableSet(PositionInitialVolumeKey(ticket), PositionGetDouble(POSITION_VOLUME));
}

void AdjustProtectionToActualFill(ulong ticket) {
   if(ticket == 0 || !PositionSelectByTicket(ticket)) return;
   string symbol = PositionGetString(POSITION_SYMBOL);
   long type = PositionGetInteger(POSITION_TYPE);
   double entry = PositionGetDouble(POSITION_PRICE_OPEN);
   double pip = PipSize(symbol);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double sl = type == POSITION_TYPE_BUY ? entry - STOP_LOSS_PIPS * pip : entry + STOP_LOSS_PIPS * pip;
   double tp = type == POSITION_TYPE_BUY ? entry + FINAL_TAKE_PROFIT_PIPS * pip : entry - FINAL_TAKE_PROFIT_PIPS * pip;
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);
   if(!trade.PositionModify(ticket, sl, tp)) {
      Print("Signal Stack protection realign failed ticket=", ticket, " ", trade.ResultRetcodeDescription());
   }
}

void ManageSignalStackPositions() {
   trade.SetAsyncMode(false);
   trade.SetExpertMagicNumber(SignalStackMagic);

   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !IsSignalStackPositionSelected()) continue;

      string symbol = PositionGetString(POSITION_SYMBOL);
      long type = PositionGetInteger(POSITION_TYPE);
      double entry = PositionGetDouble(POSITION_PRICE_OPEN);
      double current = PositionGetDouble(POSITION_PRICE_CURRENT);
      double currentVol = PositionGetDouble(POSITION_VOLUME);
      double tp = PositionGetDouble(POSITION_TP);
      double pip = PipSize(symbol);
      if(pip <= 0.0 || currentVol <= 0.0) continue;

      string initialKey = PositionInitialVolumeKey(ticket);
      if(!GlobalVariableCheck(initialKey)) GlobalVariableSet(initialKey, currentVol);
      double initialVol = GlobalVariableGet(initialKey);
      double profitPips = type == POSITION_TYPE_BUY ? (current - entry) / pip : (entry - current) / pip;

      if(profitPips >= BREAK_EVEN_PIPS && !GlobalVariableCheck(PositionBreakEvenKey(ticket))) {
         double currentSl = PositionGetDouble(POSITION_SL);
         bool alreadyBetter = type == POSITION_TYPE_BUY
            ? currentSl >= entry
            : (currentSl > 0.0 && currentSl <= entry);
         bool ok = alreadyBetter || trade.PositionModify(ticket, entry, tp);
         if(ok) {
            GlobalVariableSet(PositionBreakEvenKey(ticket), 1.0);
            Print("Signal Stack BE set ticket=", ticket,
                  " profitPips=", DoubleToString(profitPips, 1));
         }
      }

      if(profitPips >= FIRST_PARTIAL_PIPS && !GlobalVariableCheck(PositionPartialKey(ticket))) {
         double minVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
         double closeVol = NormalizeVolumeDown(symbol, initialVol * (FIRST_PARTIAL_PERCENT / 100.0));
         double maxClosable = NormalizeVolumeDown(symbol, MathMax(0.0, currentVol - minVol));
         if(maxClosable > 0.0 && (closeVol <= 0.0 || closeVol > maxClosable)) closeVol = maxClosable;

         if(closeVol > 0.0 && closeVol < currentVol && trade.PositionClosePartial(ticket, closeVol)) {
            GlobalVariableSet(PositionPartialKey(ticket), 1.0);
            if(PositionSelectByTicket(ticket)) {
               double remainingTp = PositionGetDouble(POSITION_TP);
               trade.PositionModify(ticket, entry, remainingTp);
            }
            GlobalVariableSet(PositionBreakEvenKey(ticket), 1.0);
            Print("Signal Stack 80% partial ticket=", ticket,
                  " closedVolume=", DoubleToString(closeVol, VolumeDigits(symbol)),
                  " lots profitPips=", DoubleToString(profitPips, 1));
         }
      }

      if(profitPips >= FINAL_TAKE_PROFIT_PIPS && GlobalVariableCheck(PositionPartialKey(ticket))) {
         if(PositionSelectByTicket(ticket) && trade.PositionClose(ticket)) {
            Print("Signal Stack final 20% closed ticket=", ticket, " at +18p fallback");
         }
      }
   }
}

// ─────────────────────────────────────────────────────────────────────────────
// Detailed position snapshot. MT5 volume (lots) is canonical.
// ─────────────────────────────────────────────────────────────────────────────
string PositionSnapshotJson(ulong ticket) {
   if(ticket == 0 || !PositionSelectByTicket(ticket)) return "";

   string symbol = PositionGetString(POSITION_SYMBOL);
   long type = PositionGetInteger(POSITION_TYPE);
   string side = type == POSITION_TYPE_SELL ? "short" : "long";
   double volume = PositionGetDouble(POSITION_VOLUME);
   double volumeMin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double volumeMax = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double volumeStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double contract = ContractSize(symbol);
   double notionalUnits = NotionalUnitsFromVolume(symbol, volume);
   double entry = PositionGetDouble(POSITION_PRICE_OPEN);
   double current = PositionGetDouble(POSITION_PRICE_CURRENT);
   double sl = PositionGetDouble(POSITION_SL);
   double tp = PositionGetDouble(POSITION_TP);
   double profit = PositionGetDouble(POSITION_PROFIT);
   long openTimeMsc = PositionGetInteger(POSITION_TIME_MSC);
   datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
   long magic = PositionGetInteger(POSITION_MAGIC);
   ulong identifier = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
   string comment = PositionGetString(POSITION_COMMENT);
   bool managed = IsSignalStackPositionSelected();
   int priceDigits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   int volumeDigits = VolumeDigits(symbol);

   string json = "{";
   json += "\"ticket\":\"" + IntegerToString((long)ticket) + "\",";
   json += "\"positionIdentifier\":\"" + IntegerToString((long)identifier) + "\",";
   json += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
   json += "\"side\":\"" + side + "\",";
   json += "\"volume\":" + DoubleToString(volume, volumeDigits) + ",";
   json += "\"sizeUnit\":\"lots\",";
   json += "\"volumeMin\":" + DoubleToString(volumeMin, volumeDigits) + ",";
   json += "\"volumeMax\":" + DoubleToString(volumeMax, volumeDigits) + ",";
   json += "\"volumeStep\":" + DoubleToString(volumeStep, volumeDigits) + ",";
   json += "\"contractSize\":" + DoubleToString(contract, 2) + ",";
   json += "\"notionalUnits\":" + DoubleToString(notionalUnits, 2) + ",";
   json += "\"entryPrice\":" + DoubleToString(entry, priceDigits) + ",";
   json += "\"currentPrice\":" + DoubleToString(current, priceDigits) + ",";
   json += "\"stopLoss\":" + DoubleToString(sl, priceDigits) + ",";
   json += "\"takeProfit\":" + DoubleToString(tp, priceDigits) + ",";
   json += "\"profit\":" + DoubleToString(profit, 2) + ",";
   json += "\"openTime\":\"" + JsonEscape(TimeToString(openTime, TIME_DATE|TIME_SECONDS)) + "\",";
   json += "\"openTimeEpochMs\":" + IntegerToString(openTimeMsc) + ",";
   json += "\"magic\":\"" + IntegerToString(magic) + "\",";
   json += "\"comment\":\"" + JsonEscape(comment) + "\",";
   json += "\"managedBySignalStack\":" + (managed ? "true" : "false");
   json += "}";
   return json;
}

string PositionsSnapshotJson() {
   string positions = "[";
   int count = 0;
   int total = PositionsTotal();

   for(int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      string item = PositionSnapshotJson(ticket);
      if(item == "") continue;
      if(count > 0) positions += ",";
      positions += item;
      count++;
   }

   positions += "]";
   return "{\"ok\":true,\"bridgeVersion\":\"" + BRIDGE_VERSION +
          "\",\"sizeUnit\":\"lots\",\"positionCount\":" + IntegerToString(count) +
          ",\"positions\":" + positions + "}";
}

string HistorySnapshotJson(int requestedLookbackDays) {
   int lookbackDays = MathMax(1, MathMin(30, requestedLookbackDays));
   datetime to = TimeCurrent() + 5;
   datetime from = to - lookbackDays * 86400;
   if(!HistorySelect(from, to)) {
      return "{\"ok\":false,\"bridgeVersion\":\"" + BRIDGE_VERSION +
             "\",\"error\":\"HistorySelect failed\"}";
   }

   string deals = "[";
   int count = 0;
   int total = HistoryDealsTotal();
   const int maxDeals = 1000;

   for(int i = total - 1; i >= 0 && count < maxDeals; i--) {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      ulong magic = (ulong)HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if(magic != SignalStackMagic) continue;

      ulong orderTicket = (ulong)HistoryDealGetInteger(ticket, DEAL_ORDER);
      ulong positionIdentifier = (ulong)HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      ENUM_DEAL_ENTRY dealEntry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(ticket, DEAL_ENTRY);
      ENUM_DEAL_TYPE dealType = (ENUM_DEAL_TYPE)HistoryDealGetInteger(ticket, DEAL_TYPE);
      ENUM_DEAL_REASON dealReason = (ENUM_DEAL_REASON)HistoryDealGetInteger(ticket, DEAL_REASON);
      string symbol = HistoryDealGetString(ticket, DEAL_SYMBOL);
      string comment = HistoryDealGetString(ticket, DEAL_COMMENT);
      double price = HistoryDealGetDouble(ticket, DEAL_PRICE);
      double volume = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      double profit = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      double commission = HistoryDealGetDouble(ticket, DEAL_COMMISSION);
      double swap = HistoryDealGetDouble(ticket, DEAL_SWAP);
      double fee = HistoryDealGetDouble(ticket, DEAL_FEE);
      long timeMsc = HistoryDealGetInteger(ticket, DEAL_TIME_MSC);
      int priceDigits = symbol == "" ? 5 : (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      int volumeDigits = symbol == "" ? 2 : VolumeDigits(symbol);

      string item = "{";
      item += "\"ticket\":\"" + IntegerToString((long)ticket) + "\",";
      item += "\"order\":\"" + IntegerToString((long)orderTicket) + "\",";
      item += "\"positionIdentifier\":\"" + IntegerToString((long)positionIdentifier) + "\",";
      item += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
      item += "\"entry\":\"" + JsonEscape(EnumToString(dealEntry)) + "\",";
      item += "\"type\":\"" + JsonEscape(EnumToString(dealType)) + "\",";
      item += "\"reason\":\"" + JsonEscape(EnumToString(dealReason)) + "\",";
      item += "\"price\":" + DoubleToString(price, priceDigits) + ",";
      item += "\"volume\":" + DoubleToString(volume, volumeDigits) + ",";
      item += "\"profit\":" + DoubleToString(profit, 2) + ",";
      item += "\"commission\":" + DoubleToString(commission, 2) + ",";
      item += "\"swap\":" + DoubleToString(swap, 2) + ",";
      item += "\"fee\":" + DoubleToString(fee, 2) + ",";
      item += "\"timeEpochMs\":" + IntegerToString(timeMsc) + ",";
      item += "\"magic\":\"" + IntegerToString((long)magic) + "\",";
      item += "\"comment\":\"" + JsonEscape(comment) + "\"";
      item += "}";

      if(count > 0) deals += ",";
      deals += item;
      count++;
   }

   deals += "]";
   return "{\"ok\":true,\"bridgeVersion\":\"" + BRIDGE_VERSION +
          "\",\"lookbackDays\":" + IntegerToString(lookbackDays) +
          ",\"dealCount\":" + IntegerToString(count) +
          ",\"deals\":" + deals + "}";
}

void Report(string commandId, bool success, string resultJson, string errorText = "") {
   string body = "{\"accountLogin\":\"" + JsonEscape(AccountLogin()) +
                 "\",\"terminalId\":\"" + JsonEscape(TerminalId) +
                 "\",\"commandId\":\"" + JsonEscape(commandId) +
                 "\",\"success\":" + (success ? "true" : "false") +
                 ",\"result\":" + (resultJson == "" ? "{}" : resultJson) +
                 ",\"error\":\"" + JsonEscape(errorText) + "\"}";
   string response; int status;
   PostJson("/api/mt5-ea/report", body, response, status);
}

void HandleCommand(string json) {
   string commandId = ExtractString(json, "id");
   string commandType = ExtractString(json, "command_type");
   if(commandId == "" || commandType == "") return;

   if(commandType == "health") {
      string result = "{\"ok\":true,\"login\":\"" + AccountLogin() +
                      "\",\"server\":\"" + JsonEscape(AccountServer()) +
                      "\",\"terminalId\":\"" + JsonEscape(TerminalId) +
                      "\",\"bridgeVersion\":\"" + BRIDGE_VERSION +
                      "\",\"riskPolicyVersion\":\"" + RISK_POLICY_VERSION + "\"}";
      Report(commandId, true, result);
      return;
   }

   if(commandType == "account_summary") {
      string result = "{\"ok\":true,\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2) +
                      ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2) +
                      ",\"marginFree\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2) +
                      ",\"dailyStartingBalance\":" + DoubleToString(DailyStartingBalance(),2) +
                      ",\"dailyLossPercent\":" + DoubleToString(DailyLossPercent(),4) +
                      ",\"effectiveRiskPercent\":" + DoubleToString(EffectiveRiskPercent(),2) +
                      ",\"tradingLocked\":" + (DailyTradingLocked() ? "true" : "false") +
                      ",\"bridgeVersion\":\"" + BRIDGE_VERSION +
                      "\",\"riskPolicyVersion\":\"" + RISK_POLICY_VERSION + "\"}";
      Report(commandId, true, result);
      return;
   }

   if(commandType == "positions_list") {
      Report(commandId, true, PositionsSnapshotJson());
      return;
   }

   if(commandType == "history_list") {
      int lookbackDays = (int)ExtractNumber(json, "lookbackDays", 7.0);
      Report(commandId, true, HistorySnapshotJson(lookbackDays));
      return;
   }

   if(commandType == "order_place") {
      EnsureDailyState();
      EnforceDailyLossLock();

      if(DailyTradingLocked()) {
         Report(commandId, false, "{}", "Daily 2% loss lock is active until the next New York trading day");
         return;
      }

      string requestedSymbol = ExtractString(json, "symbol");
      string side = ExtractString(json, "side");
      bool testMode = ExtractBool(json, "testMode", false);
      double explicitVolume = ExtractNumber(json, "volume", 0.0);
      double requestedRisk = ExtractNumber(json, "riskPercent", EffectiveRiskPercent());
      if(requestedRisk <= 0.0) requestedRisk = EffectiveRiskPercent();
      double riskPercent = MathMin(requestedRisk, EffectiveRiskPercent());

      if(requestedSymbol == "" || (side != "buy" && side != "sell")) {
         Report(commandId, false, "{}", "Invalid order payload");
         return;
      }

      string mt5Symbol = ResolveMt5Symbol(requestedSymbol);
      if(mt5Symbol == "") {
         Report(commandId, false, "{}", "Symbol resolution failed for " + requestedSymbol);
         return;
      }

      double entry = side == "buy" ? SymbolInfoDouble(mt5Symbol, SYMBOL_ASK) : SymbolInfoDouble(mt5Symbol, SYMBOL_BID);
      double pip = PipSize(mt5Symbol);
      int digits = (int)SymbolInfoInteger(mt5Symbol, SYMBOL_DIGITS);
      if(entry <= 0.0 || pip <= 0.0) {
         Report(commandId, false, "{}", "No executable market price for " + mt5Symbol);
         return;
      }

      double sl = side == "buy" ? entry - STOP_LOSS_PIPS * pip : entry + STOP_LOSS_PIPS * pip;
      double tp = side == "buy" ? entry + FINAL_TAKE_PROFIT_PIPS * pip : entry - FINAL_TAKE_PROFIT_PIPS * pip;
      sl = NormalizeDouble(sl, digits);
      tp = NormalizeDouble(tp, digits);

      // MT5 executes VOLUME (lots). Normal autonomous orders are risk-sized by
      // the EA; explicit volume is accepted only for the controlled test order.
      double volume = testMode
         ? NormalizeVolumeDown(mt5Symbol, explicitVolume)
         : RiskSizedVolume(mt5Symbol, side, entry, sl, riskPercent);

      if(volume <= 0.0) {
         Report(commandId, false, "{}", testMode ? "Invalid MT5 test volume" : "Could not calculate a broker-valid MT5 volume");
         return;
      }

      if(!testMode) {
         double minVol = SymbolInfoDouble(mt5Symbol, SYMBOL_VOLUME_MIN);
         if(volume < minVol * 5.0 - 1e-9) {
            Report(commandId, false, "{}",
                   "Risk-sized MT5 volume is too small to preserve an 80/20 partial structure at broker minimum volume");
            return;
         }
      }

      Print("Signal Stack order: ", requestedSymbol, " -> ", mt5Symbol,
            " side=", side,
            " volume=", DoubleToString(volume, VolumeDigits(mt5Symbol)), " lots",
            " risk=", DoubleToString(riskPercent, 2),
            "% SL=10p BE=10p P80=15p TP=18p RR=1.56",
            testMode ? " TEST" : "");

      trade.SetAsyncMode(false);
      trade.SetExpertMagicNumber(SignalStackMagic);
      trade.SetTypeFillingBySymbol(mt5Symbol);

      datetime submittedAt = TimeCurrent();
      bool ok = side == "buy"
         ? trade.Buy(volume, mt5Symbol, 0.0, sl, tp, "SignalStack")
         : trade.Sell(volume, mt5Symbol, 0.0, sl, tp, "SignalStack");

      if(!ok) {
         Report(commandId, false, "{}", trade.ResultRetcodeDescription());
         return;
      }

      ulong orderTicket = trade.ResultOrder();
      ulong dealTicket = 0;
      ulong positionTicket = 0;
      ulong positionIdentifier = 0;
      double fillPrice = 0.0;
      bool executionResolved = ResolveExecutionFill(
         mt5Symbol,
         submittedAt,
         orderTicket,
         dealTicket,
         positionTicket,
         positionIdentifier,
         fillPrice
      );

      if(positionTicket > 0) {
         StoreInitialPositionState(positionTicket);
         AdjustProtectionToActualFill(positionTicket);
      }

      Print("Signal Stack execution reconcile order=", orderTicket,
            " deal=", dealTicket,
            " positionTicket=", positionTicket,
            " positionIdentifier=", positionIdentifier,
            " fill=", DoubleToString(fillPrice, digits),
            " resolved=", executionResolved ? "true" : "false");

      double contract = ContractSize(mt5Symbol);
      double notionalUnits = NotionalUnitsFromVolume(mt5Symbol, volume);
      string result = "{\"ok\":true,\"requestedSymbol\":\"" + JsonEscape(requestedSymbol) +
                      "\",\"mt5Symbol\":\"" + JsonEscape(mt5Symbol) +
                      "\",\"order\":" + IntegerToString((long)orderTicket) +
                      ",\"deal\":" + IntegerToString((long)dealTicket) +
                      ",\"positionTicket\":" + IntegerToString((long)positionTicket) +
                      ",\"positionIdentifier\":" + IntegerToString((long)positionIdentifier) +
                      ",\"price\":" + DoubleToString(fillPrice, digits) +
                      ",\"executionResolved\":" + (executionResolved ? "true" : "false") +
                      ",\"retcode\":" + IntegerToString((long)trade.ResultRetcode()) +
                      ",\"retcodeDescription\":\"" + JsonEscape(trade.ResultRetcodeDescription()) + "\"" +
                      ",\"volume\":" + DoubleToString(volume, VolumeDigits(mt5Symbol)) +
                      ",\"sizeUnit\":\"lots\"" +
                      ",\"contractSize\":" + DoubleToString(contract, 2) +
                      ",\"notionalUnits\":" + DoubleToString(notionalUnits, 2) +
                      ",\"riskPercent\":" + DoubleToString(riskPercent, 2) +
                      ",\"stopPips\":10,\"breakEvenPips\":10,\"firstPartialPips\":15" +
                      ",\"firstPartialPercent\":80,\"finalTakeProfitPips\":18" +
                      ",\"blendedRewardRisk\":1.56}";
      Report(commandId, true, result);
      return;
   }

   if(commandType == "position_close") {
      string positionId = ExtractString(json, "positionId");
      ulong ticket = (ulong)StringToInteger(positionId);
      if(ticket == 0) {
         Report(commandId, false, "{}", "Invalid position ticket");
         return;
      }
      trade.SetExpertMagicNumber(SignalStackMagic);
      bool ok = trade.PositionClose(ticket);
      if(!ok) {
         Report(commandId, false, "{}", trade.ResultRetcodeDescription());
         return;
      }
      Report(commandId, true, "{\"ok\":true}");
      return;
   }

   Report(commandId, false, "{}", "Unsupported command type");
}

void Heartbeat() {
   EnsureDailyState();
   string body = "{\"accountLogin\":\"" + AccountLogin() +
                 "\",\"terminalId\":\"" + JsonEscape(TerminalId) +
                 "\",\"server\":\"" + JsonEscape(AccountServer()) +
                 "\",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2) +
                 ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2) +
                 ",\"dailyStartingBalance\":" + DoubleToString(DailyStartingBalance(),2) +
                 ",\"dailyLossPercent\":" + DoubleToString(DailyLossPercent(),4) +
                 ",\"effectiveRiskPercent\":" + DoubleToString(EffectiveRiskPercent(),2) +
                 ",\"tradingLocked\":" + (DailyTradingLocked() ? "true" : "false") +
                 ",\"reducedRisk\":" + (ReducedRiskActive() ? "true" : "false") +
                 ",\"bridgeVersion\":\"" + BRIDGE_VERSION +
                 "\",\"riskPolicyVersion\":\"" + RISK_POLICY_VERSION + "\"}";
   string response; int status;
   PostJson("/api/mt5-ea/heartbeat", body, response, status);
}

void Poll() {
   string body = "{\"accountLogin\":\"" + AccountLogin() +
                 "\",\"terminalId\":\"" + JsonEscape(TerminalId) + "\"}";
   string response; int status;
   if(!PostJson("/api/mt5-ea/poll", body, response, status)) return;
   if(Contains(response, "\"command\":null")) return;
   HandleCommand(response);
}

int OnInit() {
   if(TerminalToken == "") {
      Print("Signal Stack EA token is required");
      return INIT_PARAMETERS_INCORRECT;
   }

   trade.SetExpertMagicNumber(SignalStackMagic);
   EnsureDailyState();

   Print("Signal Stack bridge v", BRIDGE_VERSION,
         " starting. Login=", AccountLogin(),
         " Server=", AccountServer(),
         " TerminalId=", TerminalId,
         " TokenLength=", StringLen(TerminalToken),
         " Size=MT5 volume(lots)",
         " FillTracking=order+deal+position+history",
         " Policy=1% risk / 0.5% after SL / 2% equity daily lock / SL10 BE10 80%@15 20%@18 / blended RR 1.56");

   LogSymbolResolution("EUR_USD");
   LogSymbolResolution("GBP_USD");
   LogSymbolResolution("USD_JPY");
   LogSymbolResolution("GBP_JPY");

   EventSetTimer(MathMax(PollSeconds, 1));
   EnforceDailyLossLock();
   ManageSignalStackPositions();
   Heartbeat();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
   EventKillTimer();
}

void OnTimer() {
   static int heartbeatCounter = 0;
   EnsureDailyState();
   EnforceDailyLossLock();
   ManageSignalStackPositions();
   Poll();
   heartbeatCounter++;
   if(heartbeatCounter >= 15) {
      Heartbeat();
      heartbeatCounter = 0;
   }
}

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result) {
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD || trans.deal == 0) return;
   if(!HistoryDealSelect(trans.deal)) return;

   long magic = HistoryDealGetInteger(trans.deal, DEAL_MAGIC);
   if((ulong)magic != SignalStackMagic) return;

   ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   ENUM_DEAL_REASON reason = (ENUM_DEAL_REASON)HistoryDealGetInteger(trans.deal, DEAL_REASON);

   if((entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY) && reason == DEAL_REASON_SL) {
      EnsureDailyState();
      GlobalVariableSet(ReducedRiskKey(), 1.0);
      Print("SIGNAL STACK STOP LOSS DETECTED: all subsequent bot trades for NY day ",
            NyDayKey(), " are capped at ",
            DoubleToString(POST_SL_RISK_PERCENT, 2), "% risk.");
   }
}
