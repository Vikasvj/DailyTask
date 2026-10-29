export function metricStatus(
  value,
  goal,
  date,
  asOf,
  {
    hasData = true,
    knownFrom = null,
    todayPendingWithoutData = true,
  } = {},
) {
  if (date > asOf) return 'future';
  if (!hasData && !(date === asOf && todayPendingWithoutData)) return 'no_data';
  if (value >= goal) return 'completed';
  if (date === asOf) return 'pending';
  if (knownFrom && date < knownFrom) return 'no_data';
  if (value > 0) return 'partial';
  return 'missed';
}

export function isEligibleActivityStatus(status) {
  return ['completed', 'partial', 'missed', 'pending'].includes(status);
}

export function overallCalendarStatus(date, asOf, statuses) {
  if (date > asOf) return 'future';
  const eligible = statuses.filter(isEligibleActivityStatus);
  if (eligible.length === 0) {
    if (statuses.includes('no_data')) return 'no_data';
    if (statuses.includes('rest_day')) return 'rest_day';
    return 'not_started';
  }
  if (eligible.every((status) => status === 'completed')) return 'completed';
  if (eligible.some((status) => status === 'completed' || status === 'partial')) {
    return 'partial';
  }
  if (eligible.includes('pending')) return 'pending';
  return 'missed';
}
