from pathlib import Path

p = Path("server/edgeIntelligence.js")
txt = p.read_text()

txt = txt.replace(
"""    marketRegime:
      firstDeepDefined(sourceObjects, ['marketRegime', 'market_regime']) ||
      sigRegime?.regime ||
      null,""",
"""    marketRegime: (() => {
      const raw = firstDeepDefined(sourceObjects, ['marketRegime', 'market_regime']);
      if (typeof raw === 'string') return raw;
      if (raw && typeof raw === 'object') return raw.regime || raw.state || null;
      return sigRegime?.regime || null;
    })(),"""
)

p.write_text(txt)
print("Fixed marketRegime normalization")
