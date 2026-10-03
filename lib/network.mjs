import { fail } from './security.mjs';

export function validateNetworkOptions({ allowedHosts = [], tls, publicOrigin, trustProxy = false } = {}) {
  if (!Array.isArray(allowedHosts) || allowedHosts.some(host => typeof host !== 'string' || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{1,5}$/.test(host))) throw new Error('ALLOWED_HOSTS deve conter nomes/IPs e portas, sem esquema nem caminho.');
  if (typeof trustProxy !== 'boolean') throw new Error('TRUST_PROXY deve ser 1 para autorizar o proxy HTTPS.');
  if (!!publicOrigin !== trustProxy) throw new Error('Configure PUBLIC_ORIGIN e TRUST_PROXY=1 em conjunto.');
  if (trustProxy) {
    let origin;
    try { origin = new URL(publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN deve ser uma origem HTTPS, sem caminho.'); }
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN deve ser uma origem HTTPS, sem caminho.');
    if (tls || allowedHosts.length) throw new Error('O proxy HTTPS usa apenas PUBLIC_ORIGIN; remova TLS e ALLOWED_HOSTS.');
    return { allowedHosts: [], tls: undefined, publicOrigin: origin.origin, trustProxy: true };
  }
  if (allowedHosts.length && !tls) throw new Error('O acesso de outros dispositivos exige TLS_KEY_FILE e TLS_CERT_FILE.');
  return { allowedHosts: allowedHosts.map(host => host.toLowerCase()), tls, trustProxy: false };
}
export function requestAuthority(request, port, options) {
  if (options.trustProxy) {
    const host = String(request.headers.host ?? '').toLowerCase();
    let authority;
    if (/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?$/.test(host)) {
      try { authority = new URL(`https://${host}`).host; } catch { /* Invalid host is rejected below. */ }
    }
    const publicHost = new URL(options.publicOrigin).host;
    if (authority !== publicHost) fail(403, 'Endereço de acesso não autorizado.');
    if (request.headers['x-forwarded-proto'] !== 'https') fail(403, 'Este endereço exige HTTPS.');
    return { secure: true, host: publicHost, scheme: 'https', origin: options.publicOrigin, allowedHosts: [publicHost] };
  }
  const secure = !!request.socket.encrypted;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...options.allowedHosts];
  const host = String(request.headers.host ?? '').toLowerCase();
  if (!hosts.includes(host)) fail(403, 'Endereço de acesso não autorizado.');
  if (options.tls && !secure) fail(403, 'Este endereço exige HTTPS.');
  const scheme = secure ? 'https' : 'http';
  return { secure, host, scheme, origin: `${scheme}://${host}`, allowedHosts: hosts };
}
