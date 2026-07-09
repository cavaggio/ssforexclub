from pathlib import Path
import sys

SCANNER = Path("server/oandaScanner.js")

FUNCTIONS_TO_DEDUPE = [
    "shouldForcePerfectAlignmentExecution",
    "softenPerfectAlignmentRejects",
]

HELPER_CODE = r'''

// === PERFECT ALIGNMENT EXECUTION BYPASS PATCH ===
function shouldForcePerfectAlignmentExecution({
  alignment,
  direction,
  newsRisk,
  pricing,
  maxSpread,
} = {}) {
  const alignScore = Number(alignment?.timeframeAlignmentScore ?? 0);
  const requiredScore = envNumber('FOREX_PERFECT_ALIGNMENT_BYPASS_SCORE', 100);

  if (alignScore < requiredScore) {
    return { allowed: false, reason: `alignment_${alignScore}_below_${requiredScore}` };
  }

  if (!direction) {
    return { allowed: false, reason: 'missing_direction' };
  }

  if (newsRisk?.blocked) {
    return { allowed: false, reason: 'news_blocked' };
  }

  if (Number(pricing?.spreadPips ?? 999) > Number(maxSpread ?? 0)) {
    return { allowed: false, reason: 'spread_blocked' };
  }

  return {
    allowed: true,
    reason: `perfect_alignment_${alignScore}`,
  };
}

function softenPerfectAlignmentRejects(reasons = []) {
  return reasons.filter((reason) => {
    const r = String(reason || '').toLowerCase();

    // Keep real safety/protection blocks hard.
    if (typeof isProtectedHardBlock === 'function' && isProtectedHardBlock(r)) return true;
    if (r.includes('news block')) return true;
    if (r.includes('high-impact') && r.includes('news')) return true;
    if (r.includes('spread too wide')) return true;
    if (r.includes('spread too high')) return true;
    if (r.includes('rr < 1.5')) return true;
    if (r.includes('risk reward below')) return true;
    if (r.includes('missing stop')) return true;
    if (r.includes('missing take profit')) return true;
    if (r.includes('duplicate')) return true;
    if (r.includes('max trades')) return true;
    if (r.includes('daily loss')) return true;
    if (r.includes('credentials')) return true;
    if (r.includes('live trading disabled')) return true;
    if (r.includes('execution disabled')) return true;

    // Convert these to warnings for 100/100 alignment.
    if (
      r.includes('structural confidence') ||
      r.includes('execution confidence') ||
      r.includes('structure reversal risk is high') ||
      r.includes('reversal risk is high') ||
      r.includes('market state is reversal_risk') ||
      r.includes('profile does not allow reversal_risk') ||
      r.includes('forex profile does not allow reversal_risk') ||
      r.includes('late entry') ||
      r.includes('late_entry') ||
      r.includes('overextended') ||
      r.includes('over-extended') ||
      r.includes('risk monitor: last candle body') ||
      r.includes('candle strength') ||
      r.includes('candle has strong') ||
      r.includes('profile floor') ||
      r.includes('institutional flow') ||
      r.includes('flow opposes') ||
      r.includes('flow proxy') ||
      r.includes('impulse invalidated')
    ) {
      return false;
    }

    return true;
  });
}
// === END PERFECT ALIGNMENT EXECUTION BYPASS PATCH ===
'''

def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)

def find_function_end(src, start_idx):
    brace_idx = src.find("{", start_idx)
    if brace_idx == -1:
        die("Could not find opening brace while removing duplicate helper.")

    i = brace_idx
    depth = 0
    state = None
    escape = False

    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

        if state == "single":
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == "'":
                state = None

        elif state == "double":
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                state = None

        elif state == "template":
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == "`":
                state = None

        elif state == "line_comment":
            if ch == "\n":
                state = None

        elif state == "block_comment":
            if ch == "*" and nxt == "/":
                state = None
                i += 1

        else:
            if ch == "'" :
                state = "single"
            elif ch == '"':
                state = "double"
            elif ch == "`":
                state = "template"
            elif ch == "/" and nxt == "/":
                state = "line_comment"
                i += 1
            elif ch == "/" and nxt == "*":
                state = "block_comment"
                i += 1
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i + 1

        i += 1

    die("Could not find function ending brace.")

def remove_all_function_declarations(src, fn_name):
    removed = 0
    needle = f"function {fn_name}"
    while True:
        idx = src.find(needle)
        if idx == -1:
            break

        # Remove nearby extra blank lines before the function.
        start = idx
        while start > 0 and src[start - 1] in " \t\r\n":
            start -= 1
            if start > 1 and src[start - 2:start] == "\n\n":
                break

        end = find_function_end(src, idx)

        # Remove trailing whitespace/newlines after function.
        while end < len(src) and src[end] in " \t\r\n":
            end += 1
            if end < len(src) and src[end - 2:end] == "\n\n":
                break

        src = src[:start] + "\n\n" + src[end:]
        removed += 1

    return src, removed

if not SCANNER.exists():
    die("server/oandaScanner.js not found. Run from repo root.")

text = SCANNER.read_text()
original = text

total_removed = 0
for fn in FUNCTIONS_TO_DEDUPE:
    text, removed = remove_all_function_declarations(text, fn)
    print(f"Removed {removed} duplicate/function copy/copies of {fn}")
    total_removed += removed

# Clean duplicate patch marker comments left behind.
text = text.replace("// === PERFECT ALIGNMENT EXECUTION BYPASS PATCH ===\n\n", "")
text = text.replace("// === END PERFECT ALIGNMENT EXECUTION BYPASS PATCH ===\n", "")

# Insert exactly one clean helper block.
marker_candidates = [
    "// === OPPORTUNITY RANKING PATCH ===",
    "function getNYHour",
    "function envBool",
    "function prioritizeRetraceWatchPairs",
]

inserted = False
for marker in marker_candidates:
    idx = text.find(marker)
    if idx != -1:
        text = text[:idx] + HELPER_CODE + "\n" + text[idx:]
        inserted = True
        break

if not inserted:
    text += "\n" + HELPER_CODE + "\n"

backup = SCANNER.with_suffix(".js.bak_dedupe_perfect_alignment")
backup.write_text(original)
SCANNER.write_text(text)

print("✅ Cleaned duplicate perfect-alignment helpers.")
print(f"🗂️ Backup saved: {backup}")
print("\nVerify counts:")
print('grep -n "function shouldForcePerfectAlignmentExecution\\|function softenPerfectAlignmentRejects" server/oandaScanner.js')
