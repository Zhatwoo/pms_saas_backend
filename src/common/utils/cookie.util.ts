export function parseCookieHeader(
  cookieHeader: string | string[] | undefined,
): Record<string, string> {
  const header = Array.isArray(cookieHeader)
    ? cookieHeader.join('; ')
    : cookieHeader || '';

  return header.split(';').reduce<Record<string, string>>((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split('=');

    if (!rawName || rawValue.length === 0) {
      return cookies;
    }

    try {
      cookies[rawName] = decodeURIComponent(rawValue.join('='));
    } catch {
      cookies[rawName] = rawValue.join('=');
    }

    return cookies;
  }, {});
}
