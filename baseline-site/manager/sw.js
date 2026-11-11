// Upgrade tombstone: authenticated data is never cached by this application.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (/^basma-(manager|employee)-/.test(name)) await caches.delete(name);
  await self.registration.unregister();
  await self.clients.claim();
})()));
