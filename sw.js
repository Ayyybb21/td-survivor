// TD Survivor V10.16.0 — Web Push
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x.startsWith("td-survivor-")).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener("push",e=>{let d={};try{d=e.data?e.data.json():{}}catch(_){d={body:e.data?.text()||"League update"}}e.waitUntil(self.registration.showNotification(d.title||"TD Survivor",{body:d.body||"League update",icon:"./icon-192.png",badge:"./icon-192.png",tag:d.tag||"td-survivor",renotify:true,data:{url:d.url||"./"}}));});
self.addEventListener("notificationclick",e=>{e.notification.close();const t=new URL(e.notification.data?.url||"./",self.location.origin).href;e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{for(const c of list){if("focus" in c){c.navigate(t).catch(()=>{});return c.focus();}}return clients.openWindow?clients.openWindow(t):null;}));});
self.addEventListener("fetch",()=>{});
