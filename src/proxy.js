import { Server as ProxyChainServer } from 'proxy-chain';

export async function startProxyAdapter(server, username, password) {
  if (!server) return null;

  const upstream = new URL(server);
  if (username) upstream.username = username;
  if (password) upstream.password = password;

  const adapter = new ProxyChainServer({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({
      upstreamProxyUrl: upstream.toString(),
    }),
  });

  await adapter.listen();

  return {
    playwrightProxy: { server: `http://127.0.0.1:${adapter.port}` },
    close: () => adapter.close(true),
  };
}
