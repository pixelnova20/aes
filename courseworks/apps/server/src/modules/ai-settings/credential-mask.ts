/** Return a recognizable credential hint without exposing its middle or length. */
export function maskApiKey(apiKey: string) {
  const value = apiKey.trim();
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(12)}${value.slice(-4)}`;
}
