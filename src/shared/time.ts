const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const sameDayFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric'
});

function normalizeMidnightHour(value: string): string {
  return value.replace(/^24:/, '00:');
}

export function formatPrimaryReset(resetAtUnixSeconds: number, now = new Date()): string {
  const resetDate = new Date(resetAtUnixSeconds * 1000);
  const isToday = sameDayFormatter.format(resetDate) === sameDayFormatter.format(now);

  if (isToday) {
    return normalizeMidnightHour(timeFormatter.format(resetDate));
  }

  return normalizeMidnightHour(dateTimeFormatter.format(resetDate));
}

export function formatWeeklyReset(resetAtUnixSeconds: number): string {
  return normalizeMidnightHour(dateTimeFormatter.format(new Date(resetAtUnixSeconds * 1000)));
}

export function formatLastUpdated(isoString: string | null): string {
  if (!isoString) {
    return 'Never';
  }

  return normalizeMidnightHour(
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(isoString))
  );
}
