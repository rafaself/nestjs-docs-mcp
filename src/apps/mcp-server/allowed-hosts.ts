export const DEFAULT_MCP_ALLOWED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '[::1]',
] as const;

export function resolveMcpAllowedHosts(
  value = process.env.NESTJS_DOCS_MCP_ALLOWED_HOSTS,
): string[] {
  const configuredHosts = value
    ?.split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  return configuredHosts?.length
    ? configuredHosts
    : [...DEFAULT_MCP_ALLOWED_HOSTS];
}
