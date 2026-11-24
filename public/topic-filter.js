export function validFilter(filter) {
  if (!filter || filter.includes('\u0000')) return false;
  return filter.split('/').every((part, index, parts) =>
    (!part.includes('+') || part === '+') && (!part.includes('#') || (part === '#' && index === parts.length - 1)));
}
export function topicMatches(filter, topic) {
  if (!validFilter(filter)) return false;
  if (topic.startsWith('$') && !filter.startsWith('$')) return false;
  const levels = topic.split('/');
  const parts = filter.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '#') return true;
    if (levels[i] === undefined || (parts[i] !== '+' && parts[i] !== levels[i])) return false;
  }
  return levels.length === parts.length;
}
