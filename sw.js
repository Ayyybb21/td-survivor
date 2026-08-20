// TD Survivor V10.16.1 — Web Push
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x.startsWith("td-survivor-")).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener("push",e=>{let d={};try{d=e.data?e.data.json():{}}catch(_){d={body:e.data?.text()||"League update"}}e.waitUntil(self.registration.showNotification(d.title||"TD Survivor",{body:d.body||"League update",icon:"./icon-192.png",badge:"./icon-192.png",tag:d.tag||"td-survivor",renotify:true,data:{url:d.url||"./"}}));});
self.addEventListener("notificationclick",e=>{
  e.notification.close();

  // Resolve relative push destinations against the PWA's SERVICE WORKER SCOPE,
  // not the GitHub Pages domain root. For a project Pages site, using
  // self.location.origin incorrectly opens https://username.github.io/ (404).
  const raw=e.notification.data?.url||"./";
  const target=new URL(raw,self.registration.scope).href;

  e.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
      for(const c of list){
        if("focus" in c){
          c.navigate(target).catch(()=>{});
          return c.focus();
        }
      }
      return clients.openWindow?clients.openWindow(target):null;
    })
  );
});
self.addEventListener("fetch",()=>{});
