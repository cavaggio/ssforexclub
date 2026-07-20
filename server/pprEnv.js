const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled', 'active']);

function enabledEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return ENABLED_VALUES.has(String(raw).trim().toLowerCase());
}

export function pprRuntimeConfig() {
  const engineMode = String(process.env.PPR_ENGINE_MODE || 'active').trim().toLowerCase();
  const engineActive = engineMode === 'active' || engineMode === 'live';
  const aiAutoExecutionEnabled = enabledEnv('PPR_AI_AUTO_EXECUTION_ENABLED', true);
  const aiAutoManageEnabled = enabledEnv('PPR_AI_AUTO_MANAGE_ENABLED', true);

  return {
    engineMode,
    engineActive,
    aiAutoExecutionEnabled,
    aiAutoManageEnabled,
  };
}
