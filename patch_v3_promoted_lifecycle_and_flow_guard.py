from pathlib import Path
from datetime import datetime
import shutil
import sys

FILE = Path("server/v3AutoTrade.js")
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = Path(f"backup_v3_lifecycle_flow_guard_{STAMP}")

if not FILE.exists():
    print("❌ Missing server/v3AutoTrade.js")
    sys.exit(1)

BACKUP.mkdir(exist_ok=True)
shutil.copy2(FILE, BACKUP / "v3AutoTrade.js")

text = FILE.read_text()
original = text

# 1) Add lifecycle to the V3-built candidate so executeTrade does NOT recompute and lower RR.
old_target = """    targetSource: target.source || v3?.targets?.targetSource || 'v3_liquidity',
  };"""

new_target = """    targetSource: target.source || v3?.targets?.targetSource || 'v3_liquidity',
    lifecycle: {
      allowed: true,
      sl: {
        stopLossPips: +slPips.toFixed(1),
        stopLossPrice: stopLoss,
        invalidationReason: 'V3 promoted liquidity/invalidation stop',
      },
      tp: {
        allowed: true,
        takeProfitPips: +rewardPips.toFixed(1),
        takeProfitPrice: takeProfit,
        targetReason: `V3 promoted target from ${target.source || 'liquidity'}`,
        targetSource: target.source || v3?.targets?.targetSource || 'v3_liquidity',
      },
      source: 'v3_promoted_lifecycle',
    },
  };"""

if old_target not in text:
    print("⚠️ Could not find targetSource return block, maybe lifecycle already added.")
else:
    text = text.replace(old_target, new_target, 1)

# 2) Add institutional-flow guard helper.
helper_marker = "function safeV3Promotions(scan, log) {"

helper = """function institutionalFlowOpposesV3(item = {}, direction = null) {
  const flow = item?.institutionalFlow || {};
  if (!direction || !flow?.detected || !flow?.direction || flow.direction === 'neutral') return false;

  const tradeSign = direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : null;
  if (!tradeSign) return false;

  return flow.direction !== tradeSign;
}

"""

if "function institutionalFlowOpposesV3" not in text:
    if helper_marker not in text:
        print("❌ Could not find safeV3Promotions marker.")
        sys.exit(1)
    text = text.replace(helper_marker, helper + helper_marker, 1)

# 3) Use V3 execution confidence for V3-only lane instead of letting low legacy confidence suppress V3.
old_conf = """    const confidence = envNum(
      item?.confidence ?? v3?.confidence,
      Number.isFinite(v3ExecutionConfidence) ? v3ExecutionConfidence : v3?.score
    );"""

new_conf = """    const legacyConfidence = envNum(item?.confidence ?? v3?.confidence, NaN);
    const confidence = Number.isFinite(v3ExecutionConfidence)
      ? Math.max(Number.isFinite(legacyConfidence) ? legacyConfidence : 0, v3ExecutionConfidence)
      : legacyConfidence;"""

if old_conf not in text:
    print("⚠️ Could not find confidence block, maybe already patched.")
else:
    text = text.replace(old_conf, new_conf, 1)

# 4) Add flowOpposes variable.
old_entry_status = """    const news = item?.newsRisk || v3?.newsRisk || {};
    const entryStatus = item?.entryTiming?.status || v3?.entryTiming?.status || '';"""

new_entry_status = """    const news = item?.newsRisk || v3?.newsRisk || {};
    const entryStatus = item?.entryTiming?.status || v3?.entryTiming?.status || '';
    const flowOpposes = institutionalFlowOpposesV3(item, direction);"""

if old_entry_status not in text:
    print("⚠️ Could not find news/entryStatus block, maybe already patched.")
else:
    text = text.replace(old_entry_status, new_entry_status, 1)

# 5) Prevent promotion when institutional flow directly opposes the V3 trade.
old_safe_news = """      !news.blocked &&
      !text.includes('news_block') &&"""

new_safe_news = """      !news.blocked &&
      !flowOpposes &&
      !text.includes('news_block') &&"""

if old_safe_news in text and "!flowOpposes" not in text[text.find("const safe ="):text.find("if (!safe)")]:
    text = text.replace(old_safe_news, new_safe_news, 1)

# 6) Improve not-promoted log to show this exact blocker.
old_log_piece = """        `targetSource=${builtV3Candidate?.targetSource || 'n/a'} ` +
        `reason="${text || 'missing safe execution fields'}"`"""

new_log_piece = """        `targetSource=${builtV3Candidate?.targetSource || 'n/a'} ` +
        `flowOpposes=${flowOpposes} ` +
        `reason="${flowOpposes ? 'institutional flow opposes V3 direction' : (text || 'missing safe execution fields')}"`"""

if old_log_piece in text:
    text = text.replace(old_log_piece, new_log_piece, 1)

if text == original:
    print("⚠️ No changes made. Inspect server/v3AutoTrade.js manually.")
else:
    FILE.write_text(text)
    print("✅ Patched V3 promoted lifecycle + opposite-flow guard.")
    print(f"Backup saved in {BACKUP}")
