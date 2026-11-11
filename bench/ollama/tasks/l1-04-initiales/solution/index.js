export function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).map(word => word[0].toUpperCase()).join('');
}
