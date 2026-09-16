import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'scripts/apply_ict_runtime_gate_fix.mjs');
let source = readFileSync(TARGET, 'utf8');

const legacy = `  } else {\n    out = replaceRequired(\n      out,\n      oldConfirmation,\n      newConfirmation,\n      'final executable-price confirmation block',\n    );\n  }\n\n  const executablePriceDeclarations = out.match(`;

const compatible = `  } else if (\n    out.includes("const executablePrice = direction === 'long' ? protectiveCheck.ask : protectiveCheck.bid;") &&\n    out.includes('Final executable-price confirmation rejected for') &&\n    out.includes('const finalAGrade = evaluateIctAGradeSetup') &&\n    out.includes('sizing = computeFixedDollarSizing({')\n  ) {\n    // The A-grade precision pass intentionally inserts a final setup-quality\n    // decision between the executable-price confirmation and final sizing.\n    // That contract is stricter than the legacy exact-text block, so treat it\n    // as already satisfied instead of rewriting or weakening it.\n  } else {\n    out = replaceRequired(\n      out,\n      oldConfirmation,\n      newConfirmation,\n      'final executable-price confirmation block',\n    );\n  }\n\n  const executablePriceDeclarations = out.match(`;

if (!source.includes(compatible)) {
  if (!source.includes(legacy)) {
    throw new Error('[ICT_RUNTIME_A_GRADE_COMPAT] final-price compatibility anchor missing');
  }
  source = source.replace(legacy, compatible);
  writeFileSync(TARGET, source, 'utf8');
}

for (const marker of [
  "out.includes('const finalAGrade = evaluateIctAGradeSetup')",
  "out.includes('Final executable-price confirmation rejected for')",
  "out.includes('sizing = computeFixedDollarSizing({')",
]) {
  if (!source.includes(marker)) throw new Error(`[ICT_RUNTIME_A_GRADE_COMPAT] missing ${marker}`);
}

console.log('[ICT_RUNTIME_A_GRADE_COMPAT] legacy executable-price patch recognizes the stricter A-grade final-price contract.');
