// The app moved from /v2/ to the site root. Phones that installed the /v2/ service worker fetch
// this one on their next visit: it clears the old caches and unregisters itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('rf-')).map(k => caches.delete(k)));
  await self.registration.unregister();
  for (const client of await self.clients.matchAll()) client.navigate(client.url);
})()));
