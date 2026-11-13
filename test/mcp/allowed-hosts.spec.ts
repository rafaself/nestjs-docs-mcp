import {
  DEFAULT_MCP_ALLOWED_HOSTS,
  resolveMcpAllowedHosts,
} from '../../src/mcp/allowed-hosts.js';

describe('MCP allowed hosts', () => {
  const originalAllowedHosts = process.env.NESTJS_DOCS_MCP_ALLOWED_HOSTS;

  afterEach(() => {
    if (originalAllowedHosts === undefined)
      delete process.env.NESTJS_DOCS_MCP_ALLOWED_HOSTS;
    else process.env.NESTJS_DOCS_MCP_ALLOWED_HOSTS = originalAllowedHosts;
  });

  it('uses the loopback fallback when the environment variable is unset', () => {
    delete process.env.NESTJS_DOCS_MCP_ALLOWED_HOSTS;

    expect(resolveMcpAllowedHosts()).toEqual(DEFAULT_MCP_ALLOWED_HOSTS);
  });

  it.each(['', ' , , '])(
    'uses the loopback fallback when the environment value %j has no hosts',
    (value) => {
      process.env.NESTJS_DOCS_MCP_ALLOWED_HOSTS = value;

      expect(resolveMcpAllowedHosts()).toEqual(DEFAULT_MCP_ALLOWED_HOSTS);
    },
  );

  it('parses custom comma-separated hosts and trims whitespace', () => {
    process.env.NESTJS_DOCS_MCP_ALLOWED_HOSTS = 'docs.local, 127.0.0.1, [::1] ';

    expect(resolveMcpAllowedHosts()).toEqual([
      'docs.local',
      '127.0.0.1',
      '[::1]',
    ]);
  });
});
