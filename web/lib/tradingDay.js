export const NEW_YORK_TIME_ZONE = 'America/New_York';

const dateKeyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function newYorkDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = Object.fromEntries(
    dateKeyFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isSameNewYorkTradingDay(value, reference = new Date()) {
  const valueKey = newYorkDateKey(value);
  const referenceKey = newYorkDateKey(reference);
  return Boolean(valueKey && referenceKey && valueKey === referenceKey);
}
