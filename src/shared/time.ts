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

export function formatRelativeReset(resetAtUnixSeconds: number, now = new Date()): string {
  const resetMs = resetAtUnixSeconds * 1000;
  const deltaMs = resetMs - now.getTime();

  if (deltaMs <= 0) {
    return 'passed';
  }

  const totalMinutes = Math.ceil(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  }

  return `in ${minutes}m`;
}

export function formatResetWithRelative(resetAtUnixSeconds: number, absoluteText: string, now = new Date()): string {
  return `${formatRelativeReset(resetAtUnixSeconds, now)} at ${absoluteText}`;
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
