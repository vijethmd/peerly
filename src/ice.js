'use strict';

const crypto = require('crypto');

/**
 * ICE servers for a client. With TURN_SECRET set, credentials follow the
 * TURN REST API convention (coturn `use-auth-secret`): short-lived
 * username/password pairs derived from a shared secret, so no long-lived
 * TURN password is ever shipped to browsers.
 */
function buildIceServers(ice, { pid = 'peerly', now = Date.now() } = {}) {
  const servers = [{ urls: ice.stunUrls }];
  if (!ice.turnUrls.length) return servers;

  if (ice.turnSecret) {
    const expiresAt = Math.floor(now / 1000) + ice.turnTtlSeconds;
    const username = `${expiresAt}:${pid}`;
    const credential = crypto.createHmac('sha1', ice.turnSecret).update(username).digest('base64');
    servers.push({ urls: ice.turnUrls, username, credential });
  } else {
    servers.push({ urls: ice.turnUrls, username: ice.turnUsername, credential: ice.turnCredential });
  }
  return servers;
}

module.exports = { buildIceServers };
