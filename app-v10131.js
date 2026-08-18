
const API_URL = (window.TD_CONFIG?.API_URL || "").trim();
const params = new URLSearchParams(window.location.search);
const URL_TOKEN = params.get("token");
if (URL_TOKEN) localStorage.setItem("td_owner_token", URL_TOKEN);
const OWNER_TOKEN = URL_TOKEN || localStorage.getItem("td_owner_token") || "";

let PLAYERS = [];
let PLAYER_POOL_META = {loaded:false,count:0,source:""};
let playerRenderLimit = 60;

const PLAYER_CACHE_KEY = "td_nfl_player_pool_v1031";
const PLAYER_CACHE_TIME_KEY = "td_nfl_player_pool_v1031_time";
const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000;
const PLAYER_POSITIONS = ["QB","RB","WR","TE"];

function playerHeadshot(playerId){
  return `https://sleepercdn.com/content/nfl/players/${playerId}.jpg`;
}

function normalizeSleeperPlayers(raw){
  const seen=new Map();

  Object.values(raw||{}).forEach(p=>{
    const position=String(p.position||"").toUpperCase();
    if(!PLAYER_POSITIONS.includes(position))return;
    if(!p.player_id || !p.team)return;

    const name=(p.full_name || [p.first_name,p.last_name].filter(Boolean).join(" ")).trim();
    if(!name)return;

    let rawRank=Number.isFinite(Number(p.search_rank)) ? Number(p.search_rank) : 99999;

    // Known Sleeper search-rank anomalies observed in the live NFL feed.
    // They are valid players, so keep them searchable, but do not let the bad
    // rank value place them above established fantasy stars.
    const rankingAnomalies=new Set(["kalif jackson","micah simon"]);
    if(rankingAnomalies.has(name.toLowerCase())){
      rawRank=50000;
    }

    // Sleeper occasionally emits stray top-ranked search values for fringe
    // players. Use lightweight roster metadata as a sanity check so those
    // anomalies do not appear above established stars.
    const yearsExp=Number(p.years_exp);
    const fantasyPos=String(p.fantasy_positions||"");
    const hasDepthRole=Boolean(p.depth_chart_position || p.depth_chart_order);
    if(rawRank<=2 && !hasDepthRole && !Number.isFinite(yearsExp) && !fantasyPos){
      rawRank=50000;
    }

    const item={
      id:String(p.player_id),
      name,
      team:String(p.team||"FA"),
      position,
      photo:playerHeadshot(String(p.player_id)),
      rank:rawRank
    };

    const current=seen.get(item.id);
    if(!current || item.rank<current.rank)seen.set(item.id,item);
  });

  const players=[...seen.values()];

  // Preserve Sleeper's popularity/search ordering, but sanitize obvious ranking
  // anomalies. Some fringe players can occasionally arrive with tiny/invalid
  // search_rank values and jump ahead of established stars.
  //
  // Rules:
  // - Missing/zero/negative ranks are pushed to the deep-player section.
  // - Extremely tiny ranks on fringe/unrecognized entries are softened.
  // - Legitimate Sleeper ranks remain the primary sort.
  players.forEach(p=>{
    let r=Number(p.rank);

    if(!Number.isFinite(r) || r<=0){
      r=99999;
    }

    // A very small rank is only trusted when the feed appears to be treating
    // the player like a true top result. Unknown edge cases get moved lower.
    if(r<3 && !["QB","RB","WR","TE"].includes(p.position)){
      r=99999;
    }

    p.sortRank=r;
  });

  return players.sort((a,b)=>
    a.sortRank-b.sortRank ||
    a.rank-b.rank ||
    a.position.localeCompare(b.position) ||
    a.name.localeCompare(b.name)
  );
}

async function fetchSleeperPlayerPool(){
  // Sleeper recommends keeping the players call infrequent. Fetch active players
  // by position and cache the combined result on-device for 24 hours.
  const responses=await Promise.all(
    PLAYER_POSITIONS.map(pos=>
      fetch(`https://api.sleeper.app/v1/players/nfl?position=${pos}&active=true`,{
        cache:"no-store"
      }).then(r=>{
        if(!r.ok)throw new Error(`Sleeper ${pos} request failed (${r.status})`);
        return r.json();
      })
    )
  );

  const combined={};
  responses.forEach(group=>Object.assign(combined,group||{}));
  const players=normalizeSleeperPlayers(combined);

  if(players.length<100)throw new Error("NFL player feed returned too few players.");

  localStorage.setItem(PLAYER_CACHE_KEY,JSON.stringify(players));
  localStorage.setItem(PLAYER_CACHE_TIME_KEY,String(Date.now()));
  return players;
}

async function loadPlayerPool(){
  const cachedAt=Number(localStorage.getItem(PLAYER_CACHE_TIME_KEY)||0);
  const cachedRaw=localStorage.getItem(PLAYER_CACHE_KEY);

  if(cachedRaw && Date.now()-cachedAt<PLAYER_CACHE_TTL){
    try{
      const cached=JSON.parse(cachedRaw);
      if(Array.isArray(cached) && cached.length>100){
        PLAYERS=cached;
        PLAYER_POOL_META={loaded:true,count:PLAYERS.length,source:"cache"};
        return;
      }
    }catch(_){}
  }

  try{
    PLAYERS=await fetchSleeperPlayerPool();
    PLAYER_POOL_META={loaded:true,count:PLAYERS.length,source:"Sleeper"};
  }catch(err){
    console.error("Player pool load failed",err);

    // Use stale cache if the network is unavailable.
    if(cachedRaw){
      try{
        const cached=JSON.parse(cachedRaw);
        if(Array.isArray(cached) && cached.length){
          PLAYERS=cached;
          PLAYER_POOL_META={loaded:true,count:PLAYERS.length,source:"cached fallback"};
          return;
        }
      }catch(_){}
    }

    // Small emergency fallback keeps pick submission functional if Sleeper is down.
    PLAYERS=[
      {id:"fallback-henry",name:"Derrick Henry",team:"BAL",position:"RB",photo:"",rank:1},
      {id:"fallback-barkley",name:"Saquon Barkley",team:"PHI",position:"RB",photo:"",rank:2},
      {id:"fallback-bijan",name:"Bijan Robinson",team:"ATL",position:"RB",photo:"",rank:3}
    ];
    PLAYER_POOL_META={loaded:true,count:PLAYERS.length,source:"emergency fallback"};
  }
}

function playerInitials(name){
  return String(name||"")
    .split(/\s+/)
    .filter(Boolean)
    .map(x=>x[0])
    .slice(0,2)
    .join("")
    .toUpperCase();
}


let selectedPlayer = null;
let state = null;
let adminState = null;
let ADMIN_TOKEN = localStorage.getItem("td_admin_token") || "";

async function loadAdminState(){
  if(!ADMIN_TOKEN) return null;

  let lastErr=null;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      adminState=await jsonp("adminState",{adminToken:ADMIN_TOKEN});
      return adminState;
    }catch(err){
      lastErr=err;

      // An actual bad commissioner token should fail immediately.
      const msg=String(err?.message||err);
      if(/authorization failed|invalid admin|admin authorization/i.test(msg)){
        throw err;
      }

      // Apps Script JSONP can occasionally fail on iPhone even while the normal
      // league bootstrap endpoint is healthy. Retry transient network/script errors.
      if(attempt<3){
        await new Promise(r=>setTimeout(r,500*attempt));
      }
    }
  }
  throw lastErr||new Error("Could not load commissioner data.");
}
async function adminPost(action, body={}){
  if(!ADMIN_TOKEN) throw new Error("Commissioner token is not saved.");
  await post(action,{adminToken:ADMIN_TOKEN,...body});

  // Do not block the UI waiting for Google Sheets propagation.
  // Reconcile repeatedly in the background instead.
  scheduleLiveReconcile();
}

// V8.2: optimistic admin actions.
// The screen updates FIRST, then Google Sheets syncs in the background.
function renderAllLiveViews(){
  renderAdmin();
  renderHeader();
  renderStandings();
  renderHistory();
}

// Google Apps Script POSTs are sent with no-cors. On some browsers, the fetch
// promise can resolve before the Sheet mutation is visible to a subsequent read.
// Reconcile several times in the background so users never need to manually refresh.
function scheduleLiveReconcile(){
  const delays=[700,1800,3500,6000];
  delays.forEach(ms=>{
    setTimeout(async()=>{
      try{
        await Promise.all([refreshLive(), loadAdminState()]);
        renderAllLiveViews();
      }catch(err){
        console.warn("Background reconcile failed",err);
      }
    },ms);
  });
}

function syncAdminInBackground(action, body, rollback){
  post(action,{adminToken:ADMIN_TOKEN,...body})
    .then(()=>{
      // Start staggered refreshes immediately; one of these will occur after the
      // Google Sheet write has actually become visible.
      scheduleLiveReconcile();
    })
    .catch(err=>{
      if(typeof rollback==="function") rollback();
      renderAllLiveViews();
      alert("The change could not be saved: "+err.message);
    });
}


async function retireOldServiceWorkers(){
  if("serviceWorker" in navigator){
    try{
      const regs=await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r=>r.unregister()));
      const names=await caches.keys();
      await Promise.all(names.filter(n=>n.startsWith("td-survivor-")).map(n=>caches.delete(n)));
    }catch(err){
      console.warn("Could not retire old service worker",err);
    }
  }
}

const TD_APP_VERSION="10.13.1";
const CHAT_URL="https://tivcjqknukuetgaoryqd.supabase.co";
const CHAT_KEY="sb_publishable_B2yPF2zc7iIQHl5VvU53LA_253kELlQ";
let chatMessages=[];

let chatPoll=null;
let chatUnreadPoll=null;
let chatUnreadCount=0;

// Prevent iPhone Safari from auto-zooming when a user focuses a form field.
// Keep native pinch-to-zoom/accessibility intact; only raise focused field text
// to iOS's 16px threshold.
(function installIOSInputZoomFix(){
  const style=document.createElement("style");
  style.id="tdIOSInputZoomFix";
  style.textContent=`
    @supports (-webkit-touch-callout: none) {
      input, textarea, select {
        font-size:16px !important;
      }
    }
  `;
  (document.head||document.documentElement).appendChild(style);
})();

(function installPrimeTimeTheme(){
  const style=document.createElement("style");
  style.id="tdPrimeTimeTheme";
  style.textContent=`
    :root{
      --td-bg:#060708;
      --td-panel:#101317;
      --td-border:#272c33;
      --td-text:#f7f8fa;
      --td-muted:#9aa3ad;
      --td-orange:#ff5a00;
      --td-green:#31d07c;
      --td-yellow:#f5c542;
      --td-red:#ff6673;
    }
    html,body{background:var(--td-bg)!important;color:var(--td-text)!important;}
    body{
      font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;
      background:radial-gradient(circle at 50% -10%,rgba(255,90,0,.10),transparent 26%),linear-gradient(180deg,#050607 0%,#090b0e 100%)!important;
    }
    .app{background:transparent!important;}
    .topbar h1,.panel-head h3,#heroTitle,.rname,.pick,.primary,.navbtn small{
      font-family:"Arial Narrow","Roboto Condensed","Helvetica Neue Condensed",Inter,system-ui,sans-serif!important;
      letter-spacing:-.25px;
    }
    .topbar h1{color:#fff!important;text-transform:uppercase;letter-spacing:-1px!important;}
    .eyebrow{color:#7d8792!important;letter-spacing:1.5px!important;}
    .card,.panel,.stat,.admin-login,.row{
      background:linear-gradient(180deg,#101317 0%,#0d1014 100%)!important;
      border-color:var(--td-border)!important;
      box-shadow:none!important;
    }
    .panel{border:1px solid var(--td-border)!important;}
    .muted,.meta,.week,.stat span,.countdown span{color:var(--td-muted)!important;}
    .pill{border-color:rgba(255,90,0,.45)!important;background:rgba(255,90,0,.12)!important;color:var(--td-orange)!important;}
    .filter{background:#0b0d10!important;border-color:#30353d!important;color:#aeb6bf!important;}
    .filter.active,.primary{
      background:var(--td-orange)!important;
      border-color:var(--td-orange)!important;
      color:#fff!important;
      box-shadow:0 0 0 1px rgba(255,90,0,.25),0 6px 18px rgba(255,90,0,.18)!important;
    }
    .search,input,textarea,select{background:#090b0e!important;border-color:#30353d!important;color:#fff!important;}
    .search:focus-within,input:focus,textarea:focus,select:focus{
      border-color:var(--td-orange)!important;
      box-shadow:0 0 0 2px rgba(255,90,0,.14)!important;
      outline:none!important;
    }
    .round{background:#11151a!important;border-color:#353b44!important;color:#fff!important;}
    .nav{background:#0a0c0f!important;border-top-color:#20252b!important;box-shadow:0 -8px 28px rgba(0,0,0,.35)!important;}
    .navbtn{color:#7f8892!important;background:transparent!important;}
    .navbtn.active{
      color:#fff!important;
      background:linear-gradient(180deg,rgba(255,90,0,.15),rgba(255,90,0,.06))!important;
      box-shadow:inset 0 2px 0 var(--td-orange)!important;
    }
    .rstatus.alive,#myStatus{color:var(--td-green)!important;}
    .rstatus.out{color:var(--td-red)!important;}
    #tdChatUnreadBadge{background:var(--td-orange)!important;box-shadow:0 0 0 2px #0a0c0f!important;}
    #chatView{background:#060708!important;}
    #chatInput{background:#090b0e!important;border-color:#30353d!important;}
    #chatSend{background:var(--td-orange)!important;}
  `;
  (document.head||document.documentElement).appendChild(style);
})();

let updateCheckTimer=null;

function showUpdateBanner(nextVersion){
  if(document.querySelector("#tdUpdateBanner"))return;

  const banner=document.createElement("div");
  banner.id="tdUpdateBanner";
  banner.style.cssText=[
    "position:fixed","left:50%","transform:translateX(-50%)",
    "bottom:92px","width:min(520px,calc(100% - 28px))",
    "z-index:9999","background:#eef2f6","color:#07111f",
    "border-radius:14px","padding:12px 13px",
    "box-shadow:0 12px 40px #0009","display:flex",
    "align-items:center","gap:10px"
  ].join(";");

  banner.innerHTML=`
    <div style="flex:1;">
      <div style="font-size:11px;font-weight:900;">TD Survivor update available</div>
      <div style="font-size:9px;opacity:.72;margin-top:2px;">Version ${nextVersion} is ready.</div>
    </div>
    <button id="tdUpdateNow" style="border:0;border-radius:9px;padding:9px 10px;background:#07111f;color:#fff;font-size:9px;font-weight:900;">Update Now</button>
  `;

  document.body.appendChild(banner);

  document.querySelector("#tdUpdateNow").onclick=async()=>{
    const btn=document.querySelector("#tdUpdateNow");
    btn.disabled=true;
    btn.textContent="Updating…";
    localStorage.setItem("td_last_seen_version",String(nextVersion));

    try{
      // Re-read the manifest at click time so we force the exact latest build.
      const res=await fetch(`version.json?t=${Date.now()}`,{cache:"no-store"});
      const info=res.ok ? await res.json() : null;

      // Pre-fetch the new versioned script with a cache-buster before reloading.
      if(info?.script){
        await fetch(`${info.script}?t=${Date.now()}`,{cache:"reload"}).catch(()=>{});
      }
    }catch(_){}

    const u=new URL(window.location.href);
    u.searchParams.set("_update",Date.now());
    u.searchParams.set("_v",String(nextVersion));
    window.location.replace(u.toString());
  };
}

async function checkForAppUpdate(){
  try{
    const res=await fetch(`version.json?t=${Date.now()}`,{cache:"no-store"});
    if(!res.ok)return;
    const info=await res.json();
    if(info.version && String(info.version)!==TD_APP_VERSION){
      showUpdateBanner(info.version);
    }
  }catch(err){
    console.warn("Update check failed",err);
  }
}

function startUpdateChecks(){
  // Check immediately on every launch.
  checkForAppUpdate();

  // While the app is open, check once per minute instead of every five minutes.
  clearInterval(updateCheckTimer);
  updateCheckTimer=setInterval(checkForAppUpdate,60*1000);

  // iPhone PWAs are often left suspended rather than fully closed. Check again
  // the moment the app becomes visible/active so updates are discovered quickly.
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible")checkForAppUpdate();
  });
  window.addEventListener("pageshow",()=>checkForAppUpdate());
  window.addEventListener("focus",()=>checkForAppUpdate());
}

function demoState(){
  const names=["bb","Tay","Eddie","Brendan","Johnny","Jack","Timmy","Theresa","Ash","Rick","Drew","Byrne","Mac","Ed","Vincie","Big Vince","Dane","Gilchrist","Joe","Logan","Gabe","Vinny"];
  return {
    mode:"demo",
    league:{name:"TD Survivor 2026",week:1,entryFee:20,buybackFee:10,deadline:"Thu • 8:15 PM ET",locked:false,projectedPot:names.length*20,collectedPot:0},
    owner:{id:"demo",name:"bb"},
    entries:[{id:"demo1",label:"bb",paid:false,status:"alive",buybackUsed:false,buybackPaid:false,picks:[]}],
    standings:names.map((label,i)=>({id:"d"+i,label,status:"alive",buybackUsed:false})),
    totalOwners:names.length,totalEntries:names.length,aliveEntries:names.length
  };
}

function jsonp(action, extra={}){
  return new Promise((resolve,reject)=>{
    if(!API_URL || API_URL.includes("PASTE_")) return reject(new Error("Backend URL is not configured."));
    const cb = "tdcb_" + Date.now() + "_" + Math.floor(Math.random()*100000);
    const script = document.createElement("script");
    let finished = false;

    const cleanup=()=>{
      if(finished) return;
      finished=true;
      delete window[cb];
      script.remove();
      clearTimeout(timer);
    };

    window[cb]=(data)=>{
      cleanup();
      if(data?.ok) resolve(data);
      else reject(new Error(data?.error || "Backend error"));
    };

    const u = new URL(API_URL);
    u.searchParams.set("action", action);
    u.searchParams.set("callback", cb);
    u.searchParams.set("_ts", String(Date.now()));
    Object.entries(extra).forEach(([k,v])=>u.searchParams.set(k,v));

    script.src = u.toString();
    script.onerror=()=>{cleanup();reject(new Error("Could not reach the backend."));};
    document.body.appendChild(script);

    const timer=setTimeout(()=>{cleanup();reject(new Error("Backend request timed out."));},18000);
  });
}

async function post(action, body={}){
  if(!API_URL || API_URL.includes("PASTE_")) throw new Error("Backend URL is not configured.");
  await fetch(API_URL,{
    method:"POST",
    mode:"no-cors",
    headers:{"Content-Type":"text/plain;charset=utf-8"},
    body:JSON.stringify({action,...body})
  });
}

const LIVE_STATE_CACHE_KEY="td_last_live_state_v1";

function cacheLiveState(nextState){
  try{
    localStorage.setItem(LIVE_STATE_CACHE_KEY,JSON.stringify({
      savedAt:Date.now(),
      state:nextState
    }));
  }catch(_){}
}

function loadCachedLiveState(){
  try{
    const raw=localStorage.getItem(LIVE_STATE_CACHE_KEY);
    if(!raw)return null;
    const parsed=JSON.parse(raw);
    if(!parsed?.state)return null;

    // Cached state is only a temporary visual fallback. Keep it reasonably fresh.
    if(Date.now()-Number(parsed.savedAt||0) > 24*60*60*1000)return null;
    return parsed.state;
  }catch(_){
    return null;
  }
}

async function refreshLive(){
  state = await jsonp("bootstrap",{token:OWNER_TOKEN});
  state.mode="live";
  cacheLiveState(state);
  render();
}

async function refreshLiveWithRetry(){
  let lastErr=null;

  for(let attempt=1;attempt<=3;attempt++){
    try{
      await refreshLive();
      return true;
    }catch(err){
      lastErr=err;
      console.warn(`Live bootstrap attempt ${attempt} failed`,err);

      // Don't keep retrying genuine account/token failures.
      const msg=String(err?.message||err);
      if(/invalid invite|invalid token|invite link/i.test(msg)){
        throw err;
      }

      if(attempt<3){
        await new Promise(r=>setTimeout(r,700*attempt));
      }
    }
  }

  throw lastErr||new Error("Could not load live league.");
}

async function loadState(){
  if(API_URL && !API_URL.includes("PASTE_") && OWNER_TOKEN){
    try{
      await refreshLiveWithRetry();
      return;
    }catch(err){
      console.error(err);

      const cached=loadCachedLiveState();
      if(cached){
        state=cached;
        state.mode="live";
        render();

        // Quiet banner instead of throwing the user into Demo Mode.
        const note=document.createElement("div");
        note.id="tdCachedLiveNotice";
        note.style.cssText=[
          "position:fixed",
          "left:50%",
          "transform:translateX(-50%)",
          "top:calc(env(safe-area-inset-top) + 8px)",
          "z-index:9998",
          "background:#1b2432",
          "color:#d9e2ec",
          "border:1px solid #38485d",
          "border-radius:999px",
          "padding:6px 10px",
          "font-size:8px",
          "font-weight:800",
          "box-shadow:0 6px 20px #0007",
          "pointer-events:none"
        ].join(";");
        note.textContent="Using last live update • reconnecting…";
        document.body.appendChild(note);

        // Keep trying quietly after the app is usable.
        setTimeout(async()=>{
          try{
            await refreshLiveWithRetry();
            document.querySelector("#tdCachedLiveNotice")?.remove();
          }catch(_){}
        },3500);
        return;
      }

      alert("The live league could not load after several attempts: " + err.message + "\n\nPlease try again in a moment.");
    }
  }

  // Only use Demo Mode when there is genuinely no configured live account.
  state=demoState();
  render();
}

function activeEntry(){
  const id=localStorage.getItem("td_active_entry");
  return state.entries.find(e=>e.id===id) || state.entries[0];
}
function setActiveEntry(id){
  localStorage.setItem("td_active_entry",id);
  render();
}
function usedPlayers(entry){
  const used=new Set();

  (entry.picks||[]).forEach(p=>{
    if(p.playerId) used.add(String(p.playerId));
    if(p.player) used.add(slug(p.player));
  });

  return used;
}
function slug(s){
  return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}

function renderHeader(){
  const topbar=document.querySelector(".topbar");
  if(topbar){
    topbar.style.paddingTop="10px";
    topbar.style.boxSizing="border-box";
  }

  const e=activeEntry();
  document.querySelector("#weekNum").textContent=state.league.week;
  document.querySelector("#deadline").textContent=state.league.deadline;
  document.querySelector("#aliveCount").textContent=state.aliveEntries;
  document.querySelector("#pot").textContent="$"+state.league.projectedPot;
  document.querySelector("#myStatus").textContent=e.status==="alive"?"Alive":"Out";
  document.querySelector("#pickStatus").textContent=state.league.locked?"LOCKED":"OPEN";
  document.querySelector("#pickStatus").style.color=state.league.locked?"#ff8993":"#5be69d";
  document.querySelector("#myStatus").style.color=e.status==="alive"?"#5be69d":"#ff8993";
  document.querySelector("#profileBtn").textContent=(state.owner?.name||"?").slice(0,2).toUpperCase();
  document.querySelector("#usedCount").textContent=usedPlayers(e).size+" used";
  renderEntrySwitcher();
  renderPickHero();
  renderBuybackBucket();
}


function currentWeekPick(entry){
  return (entry?.picks||[]).find(p=>Number(p.week)===Number(state.league.week))||null;
}

function playerByPick(pick){
  if(!pick)return null;
  return PLAYERS.find(p=>String(p.id)===String(pick.playerId))
    || PLAYERS.find(p=>slug(p.name)===slug(pick.player))
    || null;
}

function renderPickHero(){
  const e=activeEntry();
  const pick=currentWeekPick(e);
  const player=playerByPick(pick);

  // IMPORTANT: there is ONE hero card only.
  // Reuse the original top .hero card from index.html; never insert a second
  // player card into the Available TD Scorers panel.
  const hero=document.querySelector(".hero.card");
  if(!hero)return;

  // Clean up the accidental duplicate hero created by V10.12.0 if it exists.
  document.querySelector("#tdDynamicHero")?.remove();

  const hasPick=Boolean(pick?.player);
  const isAlive=e.status==="alive";
  const noPick=isAlive&&!hasPick;

  const accent=noPick ? "#f5c542" : hasPick ? "#31d07c" : "#ff6673";
  const brandOrange="#ff5a00";

  const photo=hasPick
    ? (player?.photo || (pick.playerId ? playerHeadshot(pick.playerId) : ""))
    : "";

  hero.style.border=`1px solid ${accent}`;
  hero.style.background=noPick
    ? "radial-gradient(circle at 84% 30%,rgba(245,197,66,.13),transparent 27%),linear-gradient(135deg,#090a0c,#111419)"
    : hasPick
      ? "radial-gradient(circle at 84% 30%,rgba(49,208,124,.12),transparent 27%),linear-gradient(135deg,#080a0c,#111419)"
      : "linear-gradient(135deg,#160b0d,#111419)";
  hero.style.boxShadow=`0 0 24px ${accent}16`;
  hero.style.overflow="hidden";

  const title=noPick
    ? `<span style="color:${accent};">Pick</span> your TD scorer`
    : hasPick
      ? `Your TD scorer: <span style="color:${accent};">${pick.player}</span>`
      : `This play is eliminated`;

  const rightVisual=hasPick
    ? `
      <div style="width:76px;height:76px;border-radius:50%;border:2px solid ${accent};background:${accent}16;overflow:hidden;box-shadow:0 0 22px ${accent}55;display:flex;align-items:center;justify-content:center;">
        <img src="${photo}" alt="${pick.player}" style="width:100%;height:100%;object-fit:cover;object-position:center top;"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:22px;font-weight:950;">${playerInitials(pick.player)}</div>
      </div>`
    : `
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div style="width:76px;height:76px;border-radius:50%;border:2px solid ${accent};background:${accent}20;box-shadow:0 0 22px ${accent}55;display:flex;align-items:center;justify-content:center;">
          <div style="font-size:34px;filter:grayscale(1);opacity:.42;">👤</div>
        </div>
        ${noPick ? `<div style="margin-top:-6px;padding:4px 8px;border-radius:999px;background:${accent};color:#101010;font-size:7px;font-weight:950;white-space:nowrap;">⚠ NO PICK YET</div>` : ""}
      </div>`;

  hero.innerHTML=`
    <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;">
      <div style="min-width:0;">
        <span class="pill" style="background:${(noPick?accent:brandOrange)}22;color:${noPick?accent:brandOrange};border:1px solid ${(noPick?accent:brandOrange)}55;">
          WEEK <span id="weekNum">${state.league.week}</span>
        </span>

        <h2 id="heroTitle" style="margin:12px 0 7px;font-size:22px;line-height:1.08;letter-spacing:-.5px;">
          ${title}
        </h2>

        <p id="heroText" style="margin:0;color:#9ba9bb;line-height:1.45;">
          ${hasPick
            ? "Rushing or receiving touchdowns only. Passing TDs do not count."
            : "Pick one player to score a rushing or receiving touchdown. Passing TDs do not count."}
        </p>
      </div>

      <div style="display:flex;justify-content:center;align-items:center;">
        ${rightVisual}
      </div>
    </div>

    <div class="countdown" style="margin-top:15px;border-top:1px solid ${accent}22;padding-top:12px;">
      <div>
        <span>Pick deadline</span>
        <strong id="deadline" style="color:${noPick?accent:hasPick?accent:"#fff"};">${state.league.deadline}</strong>
      </div>
      <div class="status" id="pickStatus"
        style="background:${state.league.locked ? (hasPick ? "#073d25" : "#401517") : "#0b4b2c"};color:${state.league.locked ? (hasPick ? accent : "#ff7d88") : "#5be69d"};">
        ${state.league.locked ? "LOCKED" : "OPEN"}
      </div>
    </div>
  `;
}


function renderBuybackBucket(){
  const statusEl=document.querySelector("#myStatus");
  const row=statusEl?.parentElement?.parentElement;
  if(!row)return;

  let box=document.querySelector("#tdBuybackBucket");
  if(!box){
    box=document.createElement("div");
    box.id="tdBuybackBucket";
    box.className=statusEl.parentElement.className;
    box.innerHTML='<div style="font-size:8px;color:#8293a8;">Buy Back</div><div id="tdBuybackValue" style="font-size:13px;font-weight:950;margin-top:7px;"></div>';
    row.appendChild(box);
  }

  row.style.display="grid";
  row.style.gridTemplateColumns="repeat(4,minmax(0,1fr))";
  row.style.gap="7px";

  const e=activeEntry();
  const value=document.querySelector("#tdBuybackValue");
  if(e.buybackUsed){
    value.textContent="USED";
    value.style.color="#94a3b8";
  }else if(e.buybackAvailable || e.status==="alive"){
    value.textContent="AVAILABLE";
    value.style.color="#f4c430";
  }else{
    value.textContent="UNAVAILABLE";
    value.style.color="#ff8993";
  }
}

function historyEntryById(id){
  return (state.leagueEntries||state.standings||[]).find(e=>String(e.id)===String(id));
}

function historyPicksFor(entry){
  return entry?.picks||entry?.pickHistory||[];
}

function renderLeagueHistory(selectedId=null,mode="history"){
  const el=document.querySelector("#history");
  if(!el)return;

  const entries=state.leagueEntries||state.standings||[];
  if(!entries.length){
    el.innerHTML='<div class="muted">League history is unavailable.</div>';
    return;
  }

  const selected=historyEntryById(selectedId)||entries.find(e=>e.status==="alive")||entries[0];
  const picks=historyPicksFor(selected).slice().sort((a,b)=>Number(a.week)-Number(b.week));
  const used=new Set();
  picks.forEach(p=>{
    if(p.playerId)used.add(String(p.playerId));
    if(p.player)used.add(slug(p.player));
  });

  const available=PLAYERS.filter(p=>!used.has(String(p.id))&&!used.has(slug(p.name)));
  el.innerHTML=`
    <div style="display:flex;gap:7px;overflow:auto;padding-bottom:10px;">
      ${entries.map(e=>`<button class="filter tdHistoryEntry ${String(e.id)===String(selected.id)?"active":""}" data-id="${e.id}">${e.label}</button>`).join("")}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 11px;">
      <div><div class="eyebrow">SCOUTING</div><div style="font-size:16px;font-weight:950;">${selected.label}</div></div>
      <div style="display:flex;gap:5px;">
        <button class="filter tdHistMode ${mode==="history"?"active":""}" data-mode="history">History</button>
        <button class="filter tdHistMode ${mode==="available"?"active":""}" data-mode="available">Available</button>
      </div>
    </div>
    <div style="font-size:8px;color:#8293a8;margin-bottom:10px;">${used.size} used • ${available.length} available</div>
    <div id="tdHistoryBody"></div>`;

  const body=el.querySelector("#tdHistoryBody");
  if(mode==="history"){
    body.innerHTML=picks.length?picks.map(p=>{
      const result=String(p.result||"Pending").toLowerCase();
      const hit=/hit|scored|survived|correct|win/.test(result);
      const miss=/miss|out|failed|no td|lost|loss/.test(result);
      const playerColor=hit ? "#31d07c" : miss ? "#ff6673" : "#f7f8fa";
      return `
      <div class="row">
        <span class="week">WEEK ${p.week}</span>
        <span class="pick" style="color:${playerColor}!important;">${p.player}</span>
        <span class="rstatus" style="color:${hit?"#31d07c":miss?"#ff6673":"#9aa3ad"}!important;">${p.result||"Pending"}</span>
      </div>`;
    }).join(""):'<div class="muted">No picks submitted yet.</div>';
  }else{
    body.innerHTML=`
      <input id="tdAvailableSearch" placeholder="Search available players…" style="width:100%;box-sizing:border-box;margin-bottom:9px;background:#091524;color:#fff;border:1px solid #293b53;border-radius:11px;padding:10px 11px;">
      <div id="tdAvailablePlayers"></div>`;
    const draw=()=>{
      const q=(el.querySelector("#tdAvailableSearch")?.value||"").toLowerCase();
      const list=available.filter(p=>!q||p.name.toLowerCase().includes(q)).slice(0,100);
      el.querySelector("#tdAvailablePlayers").innerHTML=list.map(p=>`
        <div class="row">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="${p.photo}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" onerror="this.style.visibility='hidden'">
            <div><div style="font-weight:900;">${p.name}</div><div class="meta">${p.team||"FA"} • ${p.position}</div></div>
          </div>
          <div class="rstatus" style="color:#5be69d;">AVAILABLE</div>
        </div>`).join("") || '<div class="muted">No matches.</div>';
    };
    draw();
    el.querySelector("#tdAvailableSearch").oninput=draw;
  }

  el.querySelectorAll(".tdHistoryEntry").forEach(b=>b.onclick=()=>renderLeagueHistory(b.dataset.id,mode));
  el.querySelectorAll(".tdHistMode").forEach(b=>b.onclick=()=>renderLeagueHistory(selected.id,b.dataset.mode));
}

function openLeagueHistory(entryId){
  document.querySelectorAll(".navbtn").forEach(b=>b.classList.toggle("active",b.dataset.view==="historyView"));
  ["pickView","standingsView","historyView","chatView","adminView"].forEach(id=>{
    document.querySelector("#"+id)?.classList.toggle("hidden",id!=="historyView");
  });
  renderLeagueHistory(entryId,"history");
}

function renderEntrySwitcher(){
  document.querySelector("#entrySwitcher")?.remove();
  const panel=document.querySelector("#pickView");
  const div=document.createElement("div");
  div.id="entrySwitcher";
  div.style.cssText="display:flex;gap:7px;overflow:auto;margin:-3px 0 13px;";
  state.entries.forEach(e=>{
    const b=document.createElement("button");
    b.textContent=e.label;
    b.className="filter"+(e.id===activeEntry().id?" active":"");
    b.onclick=()=>setActiveEntry(e.id);
    div.appendChild(b);
  });
  panel.insertBefore(div,panel.children[1]);
}

async function postSystemMessage(body){
  const proof=await jsonp("chatSystemProof",{adminToken:ADMIN_TOKEN});
  const r=await fetch(`${CHAT_URL}/functions/v1/chat-api`,{
    method:"POST",
    headers:{"Content-Type":"application/json",apikey:CHAT_KEY},
    body:JSON.stringify({action:"system_post",body,systemProof:proof.systemProof})
  });
  const out=await r.json();
  if(!r.ok||!out.ok)throw new Error(out.error||"Chat post failed.");
}

async function decideMyBuyback(entry,accept){
  const verb=accept?`use your one-time $${state.league.buybackFee} buyback and re-enter Week ${state.league.week}`:"decline your buyback and be eliminated permanently";
  if(!confirm(`${entry.label}: ${verb}?`))return;

  try{
    await post("decideBuyback",{token:OWNER_TOKEN,entryId:entry.id,accept:Boolean(accept)});
    const msg=accept
      ? `♻️ ${entry.label} used their buyback and is back in for Week ${state.league.week}.`
      : `☠️ ${entry.label} declined their buyback and is officially eliminated.`;

    // Participant decisions use their authenticated owner chat proof and a
    // special decision announcement action, so no commissioner token is exposed.
    try{
      const proof=await jsonp("chatProof",{token:OWNER_TOKEN});
      const r=await fetch(`${CHAT_URL}/functions/v1/chat-api`,{
        method:"POST",
        headers:{"Content-Type":"application/json",apikey:CHAT_KEY},
        body:JSON.stringify({
          action:"decision_post",
          ownerId:proof.ownerId,
          ownerName:proof.ownerName,
          body:msg,
          authProof:proof.authProof
        })
      });
      const out=await r.json();
      if(!r.ok||!out.ok)throw new Error(out.error||"Chat announcement failed.");
    }catch(chatErr){console.warn("Buyback decision chat post failed",chatErr)}

    setTimeout(()=>window.location.reload(),500);
  }catch(err){
    alert("Buyback: "+err.message);
  }
}

function renderPlayers(){
  const e=activeEntry();
  const used=usedPlayers(e);
  const q=document.querySelector("#search").value.trim().toLowerCase();
  const pos=document.querySelector(".filter.active[data-pos]")?.dataset.pos || "ALL";
  const wrap=document.querySelector("#players");
  wrap.innerHTML="";

  if(!PLAYER_POOL_META.loaded){
    wrap.innerHTML='<div class="muted" style="padding:16px 0;">Loading NFL players…</div>';
    return;
  }

  // If this play is OUT, make that state unmistakable.
  if(e.status!=="alive"){
    const canBuyback=Boolean(e.buybackAvailable);
    wrap.insertAdjacentHTML("beforeend",`
      <div style="padding:14px;border:1px solid ${canBuyback?"#6a5225":"#4a2d33"};border-radius:14px;background:${canBuyback?"#1c180e":"#1b1115"};margin-bottom:12px;">
        <div style="font-size:12px;font-weight:900;color:${canBuyback?"#f7c66a":"#ff8993"};">${canBuyback?"♻️ Second chance?":"This play is eliminated"}</div>
        <div style="font-size:10px;color:#aeb8c6;line-height:1.45;margin-top:5px;">
          ${canBuyback
            ? `Your previous pick did not score. Your one-time buyback is available for <b>Week ${state.league.week} only</b>. Re-enter for $${state.league.buybackFee}?`
            : `This play is OUT and has no active buyback window.`}
        </div>
        ${canBuyback?`
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:11px;">
            <button id="acceptBuyback" class="primary" style="padding:10px 5px;">USE BUYBACK — $${state.league.buybackFee}</button>
            <button id="declineBuyback" style="padding:10px 5px;border-radius:10px;border:1px solid #4a2d33;background:#211217;color:#ff9aa3;font-weight:850;">DECLINE — I'M OUT</button>
          </div>`:""}
      </div>
    `);
    if(canBuyback){
      setTimeout(()=>{
        const yes=document.querySelector("#acceptBuyback"),no=document.querySelector("#declineBuyback");
        if(yes)yes.onclick=()=>decideMyBuyback(e,true);
        if(no)no.onclick=()=>decideMyBuyback(e,false);
      },0);
    }
  }

  let filtered=PLAYERS.filter(p=>
    (pos==="ALL"||p.position===pos) &&
    (!q ||
      p.name.toLowerCase().includes(q) ||
      p.team.toLowerCase().includes(q))
  );

  const limit=q ? Math.max(120,playerRenderLimit) : playerRenderLimit;
  const visible=filtered.slice(0,limit);

  const info=document.createElement("div");
  info.className="muted";
  info.style.cssText="padding:3px 0 8px;";
  info.textContent=`${PLAYER_POOL_META.count} active QB/RB/WR/TE loaded • ${filtered.length} match${filtered.length===1?"":"es"}`;
  wrap.appendChild(info);

  visible.forEach(p=>{
    const id=String(p.id),name=p.name,team=p.team,position=p.position;
    const currentPick=(e.picks||[]).find(x=>Number(x.week)===Number(state.league.week));
    const current=currentPick && (
      String(currentPick.playerId||"")===id ||
      slug(currentPick.player)===slug(name)
    );
    const prior=used.has(id) || used.has(slug(name));
    const eliminated=e.status!=="alive";
    const disabled=eliminated || (prior&&!current) || state.league.locked;
    const initials=playerInitials(name);

    const photo=p.photo
      ? `<img src="${p.photo}" alt="${name}" loading="lazy"
           style="width:46px;height:46px;object-fit:cover;object-position:top center;border-radius:12px;background:#19273b;${eliminated?"filter:grayscale(1);opacity:.45;":""}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='grid';">
         <div class="avatar" style="display:none;${eliminated?"opacity:.45;":""}">${initials}</div>`
      : `<div class="avatar" style="${eliminated?"opacity:.45;":""}">${initials}</div>`;

    const rowStyle=eliminated
      ? 'style="opacity:.42;filter:grayscale(.8);"'
      : '';

    wrap.insertAdjacentHTML("beforeend",`
      <div class="player ${prior&&!current?"disabled":""}" ${rowStyle}>
        <div style="width:46px;height:46px;flex:0 0 46px;">${photo}</div>
        <div class="pinfo">
          <div class="pname">${name}</div>
          <div class="meta">${team} • ${position} ${
            eliminated ? "• Eliminated" :
            current ? "• Current pick" :
            prior ? "• Already used" : ""
          }</div>
        </div>
        <button class="select" ${disabled?"disabled":""} data-id="${id}" data-name="${name}">
          ${eliminated ? "Out" : current ? "Selected" : state.league.locked ? "Locked" : prior ? "Used" : "Select"}
        </button>
      </div>`);
  });

  if(filtered.length>visible.length){
    const more=document.createElement("button");
    more.className="primary";
    more.style.marginTop="12px";
    more.textContent=`Load more (${filtered.length-visible.length} remaining)`;
    more.onclick=()=>{
      playerRenderLimit+=60;
      renderPlayers();
    };
    wrap.appendChild(more);
  }

  if(!filtered.length){
    wrap.insertAdjacentHTML("beforeend",'<div class="muted" style="padding:18px 0;">No players match that search.</div>');
  }

  document.querySelectorAll(".select:not([disabled])").forEach(b=>{
    b.onclick=()=>openModal(b.dataset.id,b.dataset.name);
  });
}

function statusLabel(status){
  return status==="alive" ? "ALIVE" : "OUT";
}

function statusClass(status){
  return status==="alive" ? "alive" : "out";
}

function buybackLabel(entry){
  return entry.buybackUsed ? "Buyback Used" : "Buyback Available";
}

function buybackBadge(entry){
  const used=Boolean(entry.buybackUsed);
  const bg=used ? "#202838" : "#4a3914";
  const fg=used ? "#aab5c5" : "#f7c66a";
  return `<span style="display:inline-block;margin-top:5px;padding:3px 7px;border-radius:999px;background:${bg};color:${fg};font-size:8px;font-weight:850;letter-spacing:.35px;">${buybackLabel(entry)}</span>`;
}

function resultLabel(result){
  if(!result || result==="Pending") return "⏳ Pending";
  if(result==="TD") return "✅ TD";
  if(result==="No TD") return "❌ No TD";
  return result;
}

function renderStandings(){
  const el=document.querySelector("#standings");
  el.innerHTML="";
  const reveal=Boolean(state.league.locked);

  [...state.standings]
    .sort((a,b)=>{
      const order={alive:0,out:1};
      return (order[a.status]??9)-(order[b.status]??9)||a.label.localeCompare(b.label);
    })
    .forEach((e,i)=>{
      const pickLine=reveal
        ? `<div class="meta">${e.currentPick||"No pick submitted"}${e.currentPick ? " • "+resultLabel(e.currentResult) : ""}</div>`
        : `<div class="meta">Pick hidden until lock</div>`;

      el.insertAdjacentHTML("beforeend",`
        <div class="row tdStandingRow" data-entry-id="${e.id}" style="cursor:pointer;">
          <div class="rank">${i+1}</div>
          <div class="rname">
            ${e.label}
            ${pickLine}
            ${buybackBadge(e)}
          </div>
          <div class="rstatus ${statusClass(e.status)}">${statusLabel(e.status)}</div>
        </div>`);
    });

  document.querySelector("#standingsMeta").textContent=
    reveal ? `WEEK ${state.league.week} PICKS • LOCKED • tap a play to scout history` : `${state.totalEntries} plays • picks hidden • tap a play to scout history`;

  el.querySelectorAll(".tdStandingRow").forEach(row=>{
    row.onclick=()=>openLeagueHistory(row.dataset.entryId);
  });
}

function renderHistory(){
  renderLeagueHistory();
}

function renderAdmin(){
  const view=document.querySelector("#adminView");
  if(!ADMIN_TOKEN){
    view.innerHTML=`
      <div class="panel-head"><div><div class="eyebrow">COMMISSIONER</div><h3>Control center</h3></div><span class="admin-badge">PRIVATE</span></div>
      <div class="admin-login">
        <p>Enter the private commissioner token from the Settings sheet once. It will stay saved only on this device.</p>
        <input id="adminTokenInput" class="admin-token" type="password" placeholder="Commissioner token">
        <button id="saveAdminToken" class="primary">Unlock Commissioner Mode</button>
      </div>`;
    document.querySelector("#saveAdminToken").onclick=async()=>{
      const v=document.querySelector("#adminTokenInput").value.trim();
      if(!v)return;
      ADMIN_TOKEN=v;localStorage.setItem("td_admin_token",v);
      try{await loadAdminState();renderAdmin()}catch(err){
        const msg=String(err?.message||err);
        if(/authorization failed|invalid admin|admin authorization/i.test(msg)){
          ADMIN_TOKEN="";localStorage.removeItem("td_admin_token");
        }
        alert(msg);
        renderAdmin();
      }
    };
    return;
  }
  if(!adminState){
    view.innerHTML=`<div class="panel-head"><div><div class="eyebrow">COMMISSIONER</div><h3>Control center</h3></div></div><div class="muted">Loading commissioner data…</div>`;
    loadAdminState().then(renderAdmin).catch(err=>{
      const msg=String(err?.message||err);

      if(/authorization failed|invalid admin|admin authorization/i.test(msg)){
        // Only forget the token when the backend explicitly says it is invalid.
        ADMIN_TOKEN="";
        localStorage.removeItem("td_admin_token");
        alert("Commissioner access failed: "+msg);
        renderAdmin();
        return;
      }

      // Keep the saved token on transient connectivity failures.
      view.innerHTML=`
        <div class="panel-head"><div><div class="eyebrow">COMMISSIONER</div><h3>Control center</h3></div></div>
        <div style="padding:14px;border:1px solid #3a4658;border-radius:12px;background:#0b1624;">
          <div style="font-size:11px;font-weight:900;">Commissioner data didn't load</div>
          <div style="font-size:9px;color:#8998ab;line-height:1.45;margin-top:5px;">Your commissioner token is still saved. This looks like a temporary backend connection hiccup.</div>
          <button id="retryAdminLoad" class="primary" style="margin-top:10px;">Retry Commissioner Data</button>
        </div>`;
      document.querySelector("#retryAdminLoad").onclick=async()=>{
        adminState=null;
        renderAdmin();
      };
    });
    return;
  }

  const entries=adminState.entries||[], owners=adminState.owners||[];
  const alive=entries.filter(e=>e.status==="alive").length;
  const buybacks=entries.filter(e=>e.buybackUsed).length;
  const submitted=entries.filter(e=>e.currentPick).length;
  const projected=entries.length*Number(state.league.entryFee||20)+buybacks*Number(state.league.buybackFee||10);
  const locked=String(adminState.league.week_locked).toUpperCase()==="TRUE";

  view.innerHTML=`
    <div class="panel-head"><div><div class="eyebrow">COMMISSIONER</div><h3>Control center</h3></div><span class="admin-badge">ADMIN</span></div>
    <div class="admin-grid">
      <div><span>Plays</span><b>${entries.length}</b></div>
      <div><span>Alive</span><b>${alive}</b></div>
      <div><span>Submitted</span><b>${submitted}/${alive}</b></div>
      <div><span>Missing</span><b>${Math.max(alive-submitted,0)}</b></div>
      <div><span>Pot</span><b>$${projected}</b></div>
    </div>
    <div class="admin-toolbar">
      <button id="addOwnerAdmin">➕ Add Person</button>
      <button id="addEntryAdmin">➕ Add Play</button>
      <button id="lockAdmin">${locked?"🔓 Unlock Picks":"🔒 Lock Picks"}</button>
      <button id="advanceWeekAdmin">➡️ Advance Week</button>
      <button id="weekAdmin">📅 Manual Week</button>
      <button id="gradeAdmin">🏈 Grade Player</button>
      <button id="setPickAdmin">✏️ Set/Edit Pick</button>
      <button id="overrideAdmin">🛠 Override Entry</button>
      <button id="announceAdmin">📣 Announcement</button>
      <button id="missingPickAdmin">⏰ Missing Picks</button>
      <button id="resetSeasonAdmin">🧹 Reset Season</button>
      <button id="logoutAdmin" class="admin-full">🔐 Forget Admin Token</button>
    </div>
    <div id="adminMessage"></div>
    <div class="admin-section"><h4>PLAYS</h4><div id="adminEntryRows"></div></div>`;

  const rows=document.querySelector("#adminEntryRows");
  entries.forEach(e=>{
    rows.insertAdjacentHTML("beforeend",`<div class="admin-row">
      <div class="admin-row-main"><div class="admin-row-name">${e.label}</div>
      <div class="admin-row-meta">${e.ownerName} • ${e.status.toUpperCase()} • ${e.currentPick||"No pick"} • ${e.paid?"PAID":"UNPAID"}${e.buybackUsed?" • BUYBACK USED":""}</div></div>
      <button class="mini-btn ${e.paid?"good":"warn"}" data-paid="${e.id}">${e.paid?"Paid":"Mark Paid"}</button>
      <button class="mini-btn ${e.buybackUsed?"bad":""}" data-buy="${e.id}" ${(!e.buybackUsed && e.status!=="out")?"disabled":""}>
        ${e.buybackUsed?"Undo Buyback":e.status==="out"?"Use Buyback":"Available"}
      </button>
    </div>`);
  });

  document.querySelectorAll("[data-paid]").forEach(b=>b.onclick=()=>{
    const e=adminState.entries.find(x=>x.id===b.dataset.paid);
    if(!e)return;
    const previous=e.paid;
    e.paid=!previous;

    // Immediate visual response.
    renderAdmin();

    syncAdminInBackground("setPaid",{entryId:e.id,paid:e.paid},()=>{
      e.paid=previous;
    });
  });
  document.querySelectorAll("[data-buy]").forEach(b=>b.onclick=async()=>{
    const e=(adminState.entries||[]).find(x=>x.id===b.dataset.buy);
    if(!e)return;

    if(!e.buybackUsed){
      if(!confirm(`Use the one-time $${state.league.buybackFee} buyback for ${e.label}?`))return;
      const paid=confirm("Has the $10 buyback been paid?");

      b.disabled=true;
      b.textContent="Applying…";

      try{
        await post("buyback",{adminToken:ADMIN_TOKEN,entryId:e.id,buybackPaid:paid});
        b.textContent="✅ Applied — updating…";
        setTimeout(()=>window.location.reload(),1800);
      }catch(err){
        b.disabled=false;
        b.textContent="Buyback";
        alert(err.message);
      }
    }else{
      if(!confirm(`Undo the buyback for ${e.label}?\n\nThis will return the play to OUT + Buyback Available and clear the buyback-paid flag.`))return;

      b.disabled=true;
      b.textContent="Undoing…";

      try{
        await post("undoBuyback",{adminToken:ADMIN_TOKEN,entryId:e.id});
        b.textContent="✅ Undone — updating…";
        setTimeout(()=>window.location.reload(),1800);
      }catch(err){
        b.disabled=false;
        b.textContent="Undo Buyback";
        alert(err.message);
      }
    }
  });
  document.querySelector("#addOwnerAdmin").onclick=async()=>{
    const name=prompt("New participant name:");if(!name)return;
    try{await adminPost("addOwner",{name});alert(`${name} added.`)}catch(err){alert(err.message)}
  };
  document.querySelector("#addEntryAdmin").onclick=async()=>{
    const name=prompt("Owner name to add another play for:");if(!name)return;
    const o=owners.find(x=>x.name.toLowerCase()===name.toLowerCase());
    if(!o){alert("Owner not found.");return}
    try{await adminPost("addEntry",{ownerId:o.id})}catch(err){alert(err.message)}
  };
  document.querySelector("#lockAdmin").onclick=()=>{
    const previous=String(adminState.league.week_locked).toUpperCase()==="TRUE";
    const next=!previous;
    const week=Number(state.league.week);
    const entries=adminState.entries||[];
    const alive=entries.filter(e=>e.status==="alive");
    const submitted=alive.filter(e=>String(e.currentPick||"").trim()).length;

    adminState.league.week_locked=next?"TRUE":"FALSE";
    state.league.locked=next;

    // Immediate visual response.
    renderAdmin();
    renderHeader();

    syncAdminInBackground("lockWeek",{locked:next},()=>{
      adminState.league.week_locked=previous?"TRUE":"FALSE";
      state.league.locked=previous;
    });

    // Chat is informational only; a chat failure never affects locking.
    setTimeout(async()=>{
      try{
        const message=next
          ? [
              `🔒 WEEK ${week} PICKS ARE LOCKED`,
              "",
              `✅ ${submitted}/${alive.length} ALIVE plays submitted.`,
              "👀 Picks are now visible in Standings.",
              "",
              "Good luck 🫡"
            ].join("\n")
          : [
              `🔓 WEEK ${week} PICKS REOPENED`,
              "",
              "The commissioner reopened Week "+week+" picks.",
              "Participants may edit or submit picks until they are locked again."
            ].join("\n");
        await postSystemMessage(message);
      }catch(err){console.warn("Lock chat announcement failed",err)}
    },900);
  };
  document.querySelector("#advanceWeekAdmin").onclick=async()=>{
    const currentWeek=Number(state.league.week);
    const nextWeek=currentWeek+1;
    const entries=adminState.entries||[];

    const aliveEntries=entries.filter(e=>e.status==="alive");
    const missing=aliveEntries.filter(e=>!String(e.currentPick||"").trim());
    const pending=aliveEntries.filter(e=>
      String(e.currentPick||"").trim() &&
      (!String(e.currentResult||"").trim() || String(e.currentResult)==="Pending")
    );
    const eliminatedThisWeek=entries.filter(e=>String(e.currentResult||"").trim()==="No TD");
    const buybacksAvailableNextWeek=eliminatedThisWeek.filter(e=>!e.buybackUsed).length;
    const buybackDecisions=entries.filter(e=>e.buybackAvailable);

    if(!locked){
      alert(`Week ${currentWeek} is still OPEN.\n\nLock picks before advancing the week.`);
      return;
    }

    if(missing.length || pending.length){
      const lines=[];
      if(missing.length){
        lines.push(`${missing.length} ALIVE play${missing.length===1?"":"s"} missing a pick:\n${missing.slice(0,8).map(e=>"• "+e.label).join("\n")}${missing.length>8?`\n• +${missing.length-8} more`:""}`);
      }
      if(pending.length){
        lines.push(`${pending.length} submitted pick${pending.length===1?" is":"s are"} still ungraded:\n${pending.slice(0,8).map(e=>"• "+e.label+" — "+e.currentPick).join("\n")}${pending.length>8?`\n• +${pending.length-8} more`:""}`);
      }
      alert(`Week ${currentWeek} is not ready to close.\n\n${lines.join("\n\n")}\n\nResolve these first, then try Advance Week again.`);
      return;
    }

    let message=`Advance TD Survivor from Week ${currentWeek} to Week ${nextWeek}?\n\n`+
      `🟢 ${aliveEntries.length} plays will carry forward ALIVE.\n`+
      `📜 All Week ${currentWeek} picks/results stay in History.\n`+
      `🚫 Used-player history stays attached to each play.\n`+
      `🔓 Week ${nextWeek} will open for picks automatically.`;

    if(buybackDecisions.length){
      message+=`\n\n♻️ ${buybackDecisions.length} unanswered buyback decision${buybackDecisions.length===1?"":"s"} from Week ${currentWeek} will expire when you advance.`;
    }

    if(!confirm(message))return;

    const deadline=prompt(
      `Week ${nextWeek} pick deadline label:`,
      state.league.deadline
    );
    if(deadline===null)return;

    const btn=document.querySelector("#advanceWeekAdmin");
    btn.disabled=true;
    btn.textContent="Advancing…";

    try{
      await post("advanceWeek",{
        adminToken:ADMIN_TOKEN,
        deadlineLabel:String(deadline||"").trim()
      });

      btn.textContent=`✅ Week ${nextWeek} ready — posting recap…`;

      // Apps Script's normal POST helper is fire-and-forget, so post the recap
      // from the browser after the rollover using a short-lived admin/system proof.
      await new Promise(r=>setTimeout(r,900));

      try{
        const fresh=await jsonp("adminState",{adminToken:ADMIN_TOKEN});
        const freshEntries=fresh.entries||[];
        const aliveNow=freshEntries.filter(e=>e.status==="alive").length;
        const outNow=freshEntries.filter(e=>e.status==="out").length;
        const projectedPot=Number(fresh.projectedPot||fresh.league?.projectedPot||state.league.projectedPot||0);

        const recap=[
          `🏈 WEEK ${currentWeek} COMPLETE`,
          "",
          `✅ Week ${currentWeek} is officially in the books.`,
          `🟢 ${aliveNow} play${aliveNow===1?"":"s"} advance to Week ${nextWeek}.`,
          `🔴 ${eliminatedThisWeek.length} play${eliminatedThisWeek.length===1?" was":"s were"} eliminated this week.`,
          eliminatedThisWeek.length
            ? `♻️ ${buybacksAvailableNextWeek} of ${eliminatedThisWeek.length} eliminated play${eliminatedThisWeek.length===1?"":"s"} ${buybacksAvailableNextWeek===1?"has":"have"} a buyback available for Week ${nextWeek}.`
            : "",
          projectedPot ? `💰 Projected pot: $${projectedPot}` : "",
          "",
          `🔓 WEEK ${nextWeek} IS NOW OPEN`,
          `⏰ Picks due: ${String(deadline||state.league.deadline||"Deadline TBD")}`,
          "",
          "Good luck 🫡"
        ].filter(Boolean).join("\n");

        const proof=await jsonp("chatSystemProof",{adminToken:ADMIN_TOKEN});
        const chatRes=await fetch(`${CHAT_URL}/functions/v1/chat-api`,{
          method:"POST",
          headers:{"Content-Type":"application/json",apikey:CHAT_KEY},
          body:JSON.stringify({
            action:"system_post",
            body:recap,
            systemProof:proof.systemProof
          })
        });
        const chatOut=await chatRes.json();
        if(!chatRes.ok||!chatOut.ok)throw new Error(chatOut.error||"Chat post failed.");
      }catch(chatErr){
        console.warn("Week recap chat post failed",chatErr);
      }

      btn.textContent=`✅ Week ${nextWeek} ready — updating…`;
      setTimeout(()=>window.location.reload(),700);
    }catch(err){
      btn.disabled=false;
      btn.textContent="➡️ Advance Week";
      alert("Could not advance week: "+err.message);
    }
  };

  document.querySelector("#weekAdmin").onclick=async()=>{
    const w=Number(prompt("MANUAL WEEK OVERRIDE\n\nUse Advance Week for normal rollover.\nSet current week:",state.league.week));
    if(!w)return;
    if(!confirm(`Manually set the league to Week ${w}?\n\nThis bypasses the normal rollover safety checks.`))return;
    const deadline=prompt("Deadline label:",state.league.deadline)||state.league.deadline;
    try{
      await post("setWeek",{adminToken:ADMIN_TOKEN,week:w,deadlineLabel:deadline});
      setTimeout(()=>window.location.reload(),1800);
    }catch(err){alert(err.message)}
  };
  document.querySelector("#gradeAdmin").onclick=()=>{
    const existing=document.querySelector("#gradePanel");
    if(existing){existing.remove();return;}

    // Unique current-week players actually used by at least one entry.
    const usedPlayers=[...new Set(
      (adminState.entries||[])
        .map(e=>String(e.currentPick||"").trim())
        .filter(Boolean)
    )].sort((a,b)=>a.localeCompare(b));

    if(!usedPlayers.length){
      alert("No Week "+state.league.week+" picks have been submitted yet.");
      return;
    }

    const panel=document.createElement("div");
    panel.id="gradePanel";
    panel.style.cssText="margin-top:10px;padding:12px;border:1px solid #2b3b52;border-radius:12px;background:#0a1422;";
    panel.innerHTML=`
      <div style="font-size:9px;color:#8290a3;font-weight:800;letter-spacing:.8px;margin-bottom:7px;">GRADE WEEK ${state.league.week}</div>
      <select id="gradePlayerSelect" style="width:100%;background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:11px;margin-bottom:8px;">
        <option value="">Select utilized player…</option>
        ${usedPlayers.map(p=>`<option value="${p.replaceAll('"','&quot;')}">${p}</option>`).join("")}
      </select>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="gradeTdBtn" style="border:1px solid #245f44;background:#123c2a;color:#5be69d;border-radius:10px;padding:11px;font-weight:900;">✅ TD</button>
        <button id="gradeNoTdBtn" style="border:1px solid #68343a;background:#351a20;color:#ff8993;border-radius:10px;padding:11px;font-weight:900;">❌ NO TD</button>
      </div>
      <div id="gradeUsage" style="font-size:9px;color:#738196;margin-top:8px;"></div>
    `;

    document.querySelector("#gradeAdmin").insertAdjacentElement("afterend",panel);

    const select=document.querySelector("#gradePlayerSelect");
    const usage=document.querySelector("#gradeUsage");

    select.onchange=()=>{
      const player=select.value;
      if(!player){usage.textContent="";return;}
      const affected=(adminState.entries||[]).filter(e=>e.currentPick===player);
      const pending=affected.filter(e=>!e.currentResult||e.currentResult==="Pending").length;
      usage.textContent=`${affected.length} play${affected.length===1?"":"s"} selected ${player}${pending!==affected.length?` • ${affected.length-pending} already graded`:""}.`;
    };

    async function submitGrade(scored){
      const player=select.value;
      if(!player){alert("Select a player first.");return;}

      const yes=scored ? "TD" : "NO TD";
      if(!confirm(`Grade ${player} as ${yes}?`))return;

      const td=document.querySelector("#gradeTdBtn");
      const no=document.querySelector("#gradeNoTdBtn");
      td.disabled=true;no.disabled=true;
      td.style.opacity=".5";no.style.opacity=".5";
      usage.textContent=`Saving ${player} as ${yes}…`;

      try{
        // Snapshot affected plays before the page refresh.
        const affected=(adminState.entries||[]).filter(e=>e.currentPick===player);
        const alreadyGraded=affected.some(e=>String(e.currentResult||"").trim() && String(e.currentResult)!=="Pending");
        const labels=affected.map(e=>e.label);
        const eligibleBuybacks=!scored
          ? affected.filter(e=>!e.buybackUsed).length
          : 0;

        await post("gradePlayer",{adminToken:ADMIN_TOKEN,playerName:player,scored});
        usage.textContent="✅ Saved. Posting update…";

        // Give Apps Script a moment to commit, then post ONE grouped result
        // announcement so Chat stays informative instead of noisy.
        await new Promise(r=>setTimeout(r,750));

        try{
          let message;
          if(alreadyGraded){
            message=[
              `🔄 WEEK ${state.league.week} RESULT UPDATED`,
              "",
              scored ? `✅ ${player} is now graded TD.` : `❌ ${player} is now graded NO TD.`,
              `${affected.length} play${affected.length===1?" was":"s were"} affected: ${labels.join(", ")}`
            ].join("\n");
          }else if(scored){
            message=[
              `✅ TOUCHDOWN — ${player}`,
              "",
              `${affected.length} play${affected.length===1?" survives":"s survive"}:`,
              labels.map(x=>"• "+x).join("\n")
            ].join("\n");
          }else{
            message=[
              `❌ NO TD — ${player}`,
              "",
              `${affected.length} play${affected.length===1?" is":"s are"} eliminated:`,
              labels.map(x=>"• "+x).join("\n"),
              eligibleBuybacks
                ? `\n♻️ ${eligibleBuybacks} of ${affected.length} ${eligibleBuybacks===1?"has":"have"} a buyback available for Week ${Number(state.league.week)+1}.`
                : ""
            ].filter(Boolean).join("\n");
          }

          await postSystemMessage(message);
        }catch(chatErr){
          console.warn("Grade chat announcement failed",chatErr);
        }

        // Keep the reliable auto-refresh behavior.
        setTimeout(()=>window.location.reload(),650);
      }catch(err){
        td.disabled=false;no.disabled=false;
        td.style.opacity="1";no.style.opacity="1";
        usage.textContent="";
        alert("Could not save grading result: "+err.message);
      }
    }

    document.querySelector("#gradeTdBtn").onclick=()=>submitGrade(true);
    document.querySelector("#gradeNoTdBtn").onclick=()=>submitGrade(false);
  };
  document.querySelector("#setPickAdmin").onclick=()=>{
    const existing=document.querySelector("#setPickPanel");
    if(existing){existing.remove();return;}

    const entries=[...(adminState.entries||[])].sort((a,b)=>a.label.localeCompare(b.label));

    const panel=document.createElement("div");
    panel.id="setPickPanel";
    panel.style.cssText="margin-top:10px;padding:12px;border:1px solid #2b3b52;border-radius:12px;background:#0a1422;";
    panel.innerHTML=`
      <div style="font-size:9px;color:#8290a3;font-weight:800;letter-spacing:.8px;margin-bottom:8px;">SET / EDIT WEEK ${state.league.week} PICK</div>

      <select id="setPickEntry" style="width:100%;background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:11px;margin-bottom:8px;">
        <option value="">Select play…</option>
        ${entries.map(e=>`<option value="${e.id}">${e.label}</option>`).join("")}
      </select>

      <div style="position:relative;">
        <input id="setPickPlayerSearch"
          autocomplete="off"
          placeholder="Start typing player name…"
          style="width:100%;background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:11px;margin-bottom:5px;">
        <div id="setPickSuggestions"
          style="display:none;position:absolute;left:0;right:0;top:100%;z-index:20;background:#0b1727;border:1px solid #2a3b53;border-radius:10px;overflow:hidden;box-shadow:0 10px 30px #0008;"></div>
      </div>

      <div id="setPickCurrent" style="font-size:9px;color:#738196;margin:5px 0 9px;"></div>

      <label style="display:flex;gap:8px;align-items:flex-start;font-size:9px;color:#9aa8bb;line-height:1.35;margin-bottom:10px;">
        <input id="setPickForce" type="checkbox" style="margin-top:1px;">
        <span>Commissioner override: allow a player this play has already used in a prior week.</span>
      </label>

      <button id="saveSetPick" class="primary">Save Pick</button>
      <div style="font-size:9px;color:#738196;margin-top:8px;line-height:1.4;">
        This can be used even if picks are locked. It changes only the selected play's current-week pick and resets that pick's result to Pending.
      </div>
    `;

    document.querySelector("#setPickAdmin").insertAdjacentElement("afterend",panel);

    const entrySelect=document.querySelector("#setPickEntry");
    const current=document.querySelector("#setPickCurrent");
    const playerInput=document.querySelector("#setPickPlayerSearch");
    const suggestionBox=document.querySelector("#setPickSuggestions");
    let selectedAdminPlayer=null;

    function renderAdminPlayerSuggestions(){
      const q=playerInput.value.trim().toLowerCase();
      selectedAdminPlayer=null;

      if(!q){
        suggestionBox.innerHTML="";
        suggestionBox.style.display="none";
        return;
      }

      const matches=PLAYERS
        .filter(p=>p.name.toLowerCase().includes(q))
        .slice(0,5);

      if(!matches.length){
        suggestionBox.innerHTML='<div style="padding:10px;color:#7f8da1;font-size:10px;">No matching players</div>';
        suggestionBox.style.display="block";
        return;
      }

      suggestionBox.innerHTML=matches.map(p=>`
        <button type="button" data-admin-player="${p.id}"
          style="display:flex;width:100%;align-items:center;gap:9px;text-align:left;border:0;border-bottom:1px solid #203047;background:#0b1727;color:#fff;padding:9px 10px;">
          <img src="${p.photo||""}" alt="" style="width:32px;height:32px;border-radius:8px;object-fit:cover;background:#17263a;"
            onerror="this.style.visibility='hidden';">
          <span style="flex:1;">
            <span style="display:block;font-size:11px;font-weight:850;">${p.name}</span>
            <span style="display:block;font-size:9px;color:#8290a3;margin-top:2px;">${p.team} • ${p.position}</span>
          </span>
        </button>
      `).join("");

      suggestionBox.style.display="block";

      suggestionBox.querySelectorAll("[data-admin-player]").forEach(btn=>{
        btn.addEventListener("click",()=>{
          const p=PLAYERS.find(x=>String(x.id)===btn.dataset.adminPlayer);
          if(!p)return;
          selectedAdminPlayer=p;
          playerInput.value=p.name;
          suggestionBox.style.display="none";
          suggestionBox.innerHTML="";
        });
      });
    }

    playerInput.addEventListener("input",renderAdminPlayerSuggestions);
    playerInput.addEventListener("focus",()=>{
      if(playerInput.value.trim())renderAdminPlayerSuggestions();
    });

    entrySelect.onchange=()=>{
      const e=(adminState.entries||[]).find(x=>x.id===entrySelect.value);
      if(!e){current.textContent="";return;}
      current.textContent=e.currentPick
        ? `Current Week ${state.league.week} pick: ${e.currentPick}${e.currentResult?` • ${e.currentResult}`:""}`
        : `No Week ${state.league.week} pick submitted.`;
      selectedAdminPlayer=null;
      if(e.currentPick){
        playerInput.value=e.currentPick;
        selectedAdminPlayer=PLAYERS.find(p=>p.name.toLowerCase()===e.currentPick.toLowerCase())||null;
      }else{
        playerInput.value="";
      }
      suggestionBox.style.display="none";
    };

    document.querySelector("#saveSetPick").onclick=async()=>{
      const entryId=entrySelect.value;
      const typed=playerInput.value.trim();
      const force=document.querySelector("#setPickForce").checked;

      if(!entryId){alert("Select a play first.");return;}
      if(!typed){alert("Select a player first.");return;}

      const player=
        selectedAdminPlayer ||
        PLAYERS.find(p=>p.name.toLowerCase()===typed.toLowerCase());

      if(!player){
        alert("Select one of the player suggestions first.");
        return;
      }

      const entry=(adminState.entries||[]).find(x=>x.id===entryId);
      const lockedNote=state.league.locked ? "\n\nPicks are currently LOCKED. This commissioner edit will still be allowed." : "";

      if(!confirm(`Set ${entry.label}'s Week ${state.league.week} pick to ${player.name}?${lockedNote}`))return;

      const btn=document.querySelector("#saveSetPick");
      btn.disabled=true;
      btn.textContent="Saving pick…";

      try{
        await post("adminSetPick",{
          adminToken:ADMIN_TOKEN,
          entryId,
          playerId:String(player.id),
          playerName:player.name,
          force
        });

        btn.textContent="✅ Saved — updating…";
        setTimeout(()=>window.location.reload(),1800);
      }catch(err){
        btn.disabled=false;
        btn.textContent="Save Pick";
        alert("Could not save commissioner pick: "+err.message);
      }
    };
  };

  document.querySelector("#overrideAdmin").onclick=()=>{
    const existing=document.querySelector("#overridePanel");
    if(existing){existing.remove();return;}

    const sorted=[...(adminState.entries||[])].sort((a,b)=>a.label.localeCompare(b.label));
    const panel=document.createElement("div");
    panel.id="overridePanel";
    panel.style.cssText="margin-top:10px;padding:12px;border:1px solid #2b3b52;border-radius:12px;background:#0a1422;";
    panel.innerHTML=`
      <div style="font-size:9px;color:#8290a3;font-weight:800;letter-spacing:.8px;margin-bottom:8px;">COMMISSIONER OVERRIDE</div>

      <select id="overrideEntrySelect" style="width:100%;background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:11px;margin-bottom:8px;">
        <option value="">Select play…</option>
        ${sorted.map(e=>`<option value="${e.id}">${e.label}</option>`).join("")}
      </select>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
        <select id="overrideStatus" style="background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:10px;">
          <option value="alive">🟢 Alive</option>
          <option value="out">🔴 Out</option>
        </select>

        <select id="overrideBuyback" style="background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:10px;">
          <option value="available">🟡 Buyback Available</option>
          <option value="used">⚫ Buyback Used</option>
        </select>
      </div>

      <select id="overrideResult" style="width:100%;background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:10px;margin-bottom:8px;">
        <option value="KEEP">Keep current week result</option>
        <option value="Pending">⏳ Pending</option>
        <option value="TD">✅ TD</option>
        <option value="No TD">❌ No TD</option>
      </select>

      <button id="saveOverride" class="primary">Apply Commissioner Override</button>
      <div style="font-size:9px;color:#738196;margin-top:8px;line-height:1.4;">
        Use only to correct mistakes, bugs, or special commissioner rulings. This does not edit the selected player.
      </div>
    `;
    document.querySelector("#overrideAdmin").insertAdjacentElement("afterend",panel);

    const entrySelect=document.querySelector("#overrideEntrySelect");
    entrySelect.onchange=()=>{
      const e=(adminState.entries||[]).find(x=>x.id===entrySelect.value);
      if(!e)return;
      document.querySelector("#overrideStatus").value=e.status==="alive"?"alive":"out";
      document.querySelector("#overrideBuyback").value=e.buybackUsed?"used":"available";
      document.querySelector("#overrideResult").value="KEEP";
    };

    document.querySelector("#saveOverride").onclick=async()=>{
      const entryId=entrySelect.value;
      if(!entryId){alert("Select a play first.");return;}

      const e=(adminState.entries||[]).find(x=>x.id===entryId);
      const status=document.querySelector("#overrideStatus").value;
      const buybackUsed=document.querySelector("#overrideBuyback").value==="used";
      const result=document.querySelector("#overrideResult").value;

      if(!confirm(`Override ${e.label}?\n\nStatus: ${status.toUpperCase()}\nBuyback: ${buybackUsed?"USED":"AVAILABLE"}${result!=="KEEP"?`\nWeek result: ${result}`:""}`))return;

      const btn=document.querySelector("#saveOverride");
      btn.disabled=true;btn.textContent="Saving override…";

      try{
        await post("overrideEntry",{
          adminToken:ADMIN_TOKEN,
          entryId,
          status,
          buybackUsed,
          result
        });

        btn.textContent="✅ Saved — updating…";
        setTimeout(()=>window.location.reload(),1800);
      }catch(err){
        btn.disabled=false;btn.textContent="Apply Commissioner Override";
        alert("Override failed: "+err.message);
      }
    };
  };

  document.querySelector("#announceAdmin").onclick=()=>{
    const sorted=entries.filter(e=>e.currentPick).sort((a,b)=>a.label.localeCompare(b.label));
    const text=`🏈 TD SURVIVOR — WEEK ${state.league.week}\n\n🔒 PICKS ${locked?"LOCKED":"OPEN"}\n\n`+
      sorted.map(e=>`${e.label} — ${e.currentPick}`).join("\n")+
      `\n\n${alive} plays alive • $${projected} pot\n\nGood luck! 🫡`;
    navigator.clipboard?.writeText(text);
    document.querySelector("#adminMessage").innerHTML=`<div class="copybox">${text.replaceAll("\n","<br>")}</div><div class="admin-note">Copied to clipboard.</div>`;
  };
  document.querySelector("#missingPickAdmin").onclick=()=>{
    const existing=document.querySelector("#missingPickPanel");
    if(existing){existing.remove();return;}

    const entries=adminState.entries||[];
    const aliveEntries=entries.filter(e=>e.status==="alive");
    const missing=aliveEntries.filter(e=>!String(e.currentPick||"").trim());
    const submitted=aliveEntries.length-missing.length;

    const panel=document.createElement("div");
    panel.id="missingPickPanel";
    panel.style.cssText="margin-top:10px;padding:13px;border:1px solid #2b3b52;border-radius:12px;background:#0a1422;";

    const names=missing.map(e=>e.label);

    panel.innerHTML=`
      <div style="font-size:9px;color:#8290a3;font-weight:900;letter-spacing:.8px;margin-bottom:8px;">WEEK ${state.league.week} PICK STATUS</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <div style="background:#0d1a2b;border:1px solid #22364f;border-radius:10px;padding:10px;">
          <div style="font-size:9px;color:#8190a4;">Submitted</div>
          <div style="font-size:18px;font-weight:900;margin-top:2px;">${submitted}</div>
        </div>
        <div style="background:#1b1610;border:1px solid #55401d;border-radius:10px;padding:10px;">
          <div style="font-size:9px;color:#c9a95f;">Missing</div>
          <div style="font-size:18px;font-weight:900;color:#f7c66a;margin-top:2px;">${missing.length}</div>
        </div>
      </div>

      <div style="font-size:9px;color:#8795a8;margin-bottom:8px;">
        Deadline: ${state.league.deadline || "Not set"}
      </div>

      <div id="missingPickList" style="max-height:240px;overflow:auto;border:1px solid #213047;border-radius:10px;">
        ${missing.length
          ? missing.map(e=>`
              <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 10px;border-bottom:1px solid #1d2a3c;">
                <span style="font-size:10px;font-weight:800;">${e.label}</span>
                <span style="font-size:8px;color:#f7c66a;font-weight:800;">NO PICK</span>
              </div>
            `).join("")
          : `<div style="padding:14px;color:#5be69d;font-size:10px;font-weight:800;">✅ Every ALIVE play has submitted a pick.</div>`
        }
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;">
        <button id="copyMissingNames" ${missing.length?"":"disabled"}
          style="border:1px solid #2b3b52;background:#15243a;color:#eef2f7;border-radius:10px;padding:10px;font-size:9px;font-weight:800;">
          Copy Names
        </button>
        <button id="copyReminderMessage" ${missing.length?"":"disabled"}
          style="border:1px solid #2b3b52;background:#15243a;color:#eef2f7;border-radius:10px;padding:10px;font-size:9px;font-weight:800;">
          Copy Reminder
        </button>
      </div>

      <div id="missingPickCopied" style="font-size:9px;color:#738196;margin-top:8px;"></div>
    `;

    document.querySelector("#missingPickAdmin").insertAdjacentElement("afterend",panel);

    if(missing.length){
      document.querySelector("#copyMissingNames").onclick=async()=>{
        const text=names.join("\n");
        try{
          await navigator.clipboard.writeText(text);
          document.querySelector("#missingPickCopied").textContent="✅ Missing-play names copied.";
        }catch(_){
          prompt("Copy missing names:",text);
        }
      };

      document.querySelector("#copyReminderMessage").onclick=async()=>{
        const text=
`🏈 TD Survivor — Week ${state.league.week} Reminder

Picks are due ${state.league.deadline || "soon"}.

Still waiting on:
${names.map(n=>"• "+n).join("\n")}

Get those picks in!`;

        try{
          await navigator.clipboard.writeText(text);
          document.querySelector("#missingPickCopied").textContent="✅ Reminder copied to clipboard.";
        }catch(_){
          prompt("Copy reminder:",text);
        }
      };
    }
  };

  document.querySelector("#resetSeasonAdmin").onclick=()=>{
    const existing=document.querySelector("#resetSeasonPanel");
    if(existing){existing.remove();return;}

    const panel=document.createElement("div");
    panel.id="resetSeasonPanel";
    panel.style.cssText="margin-top:10px;padding:13px;border:1px solid #5a3940;border-radius:12px;background:#1a1115;";
    panel.innerHTML=`
      <div style="font-size:9px;color:#ff9aa2;font-weight:900;letter-spacing:.8px;margin-bottom:7px;">PRESEASON / NEW-SEASON RESET</div>
      <div style="font-size:10px;color:#c7ced8;line-height:1.45;margin-bottom:10px;">
        This clears test-season activity while preserving participant accounts and private invite tokens.
      </div>

      <label style="display:block;font-size:9px;color:#98a6b8;margin-bottom:4px;">Starting week</label>
      <input id="resetStartWeek" type="number" min="1" max="25" value="1"
        style="width:100%;background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:10px;margin-bottom:8px;">

      <label style="display:block;font-size:9px;color:#98a6b8;margin-bottom:4px;">Pick deadline label</label>
      <input id="resetDeadline" value="${state.league.deadline}"
        style="width:100%;background:#07111f;color:#fff;border:1px solid #2a3b53;border-radius:10px;padding:10px;margin-bottom:10px;">

      <label style="display:flex;gap:8px;align-items:flex-start;font-size:9px;color:#b8c2cf;line-height:1.35;margin-bottom:8px;">
        <input id="resetPaid" type="checkbox" checked>
        <span>Reset all entry-fee Paid flags to UNPAID.</span>
      </label>

      <label style="display:flex;gap:8px;align-items:flex-start;font-size:9px;color:#b8c2cf;line-height:1.35;margin-bottom:8px;">
        <input id="resetEntries" type="checkbox">
        <span>Also collapse each owner back to ONE play. Leave unchecked to preserve everyone's current number of plays.</span>
      </label>

      <label style="display:flex;gap:8px;align-items:flex-start;font-size:9px;color:#b8c2cf;line-height:1.35;margin-bottom:10px;">
        <input id="resetConfirmBox" type="checkbox">
        <span>I understand this permanently clears all Picks/history/results from the current test season.</span>
      </label>

      <button id="runSeasonReset" class="primary" style="background:#6b1d28;">Reset Test Season</button>
      <div id="resetSeasonNote" style="font-size:9px;color:#8795a8;margin-top:8px;line-height:1.4;">
        Owners, owner IDs, invite tokens, and the admin token are preserved.
      </div>
    `;

    document.querySelector("#resetSeasonAdmin").insertAdjacentElement("afterend",panel);

    document.querySelector("#runSeasonReset").onclick=async()=>{
      const confirmed=document.querySelector("#resetConfirmBox").checked;
      if(!confirmed){
        alert("Check the confirmation box first.");
        return;
      }

      const startWeek=Number(document.querySelector("#resetStartWeek").value||1);
      const deadlineLabel=document.querySelector("#resetDeadline").value.trim();
      const resetPaid=Boolean(document.querySelector("#resetPaid").checked);
      const collapseEntries=Boolean(document.querySelector("#resetEntries").checked);

      const warning=
        `RESET TD SURVIVOR TEST SEASON?\n\n`+
        `This will:\n`+
        `• Delete ALL Picks/history/results\n`+
        `• Set every remaining play to ALIVE\n`+
        `• Restore Buyback Available for every play\n`+
        `• Clear all buyback-paid flags\n`+
        `${resetPaid?"• Set every entry to UNPAID\n":""}`+
        `${collapseEntries?"• Reduce each owner to ONE play\n":"• Preserve each owner's current number of plays\n"}`+
        `• Set the league to Week ${startWeek}\n`+
        `• Open picks\n\n`+
        `Participant accounts and private invite tokens will NOT be deleted.`;

      if(!confirm(warning))return;

      // Require a second typed confirmation for destructive reset.
      const phrase=prompt('Type RESET to confirm the season reset:');
      if(phrase!=="RESET"){
        alert("Reset cancelled.");
        return;
      }

      const btn=document.querySelector("#runSeasonReset");
      btn.disabled=true;
      btn.textContent="Resetting season…";

      try{
        await post("resetSeason",{
          adminToken:ADMIN_TOKEN,
          startWeek,
          deadlineLabel,
          resetPaid,
          collapseEntries
        });

        btn.textContent="✅ Reset complete — updating…";
        setTimeout(()=>window.location.reload(),2200);
      }catch(err){
        btn.disabled=false;
        btn.textContent="Reset Test Season";
        alert("Season reset failed: "+err.message);
      }
    };
  };

  document.querySelector("#logoutAdmin").onclick=()=>{
    if(confirm("Forget the commissioner token on this device?")){
      ADMIN_TOKEN="";adminState=null;localStorage.removeItem("td_admin_token");renderAdmin();
    }
  };
}

function render(){
  renderHeader();
  renderPlayers();
  renderStandings();
  renderHistory();
  renderAdmin();
}

function openModal(id,name){
  selectedPlayer={id,name};
  document.querySelector("#chosen").textContent=name;
  document.querySelector("#modal").classList.remove("hidden");
}
function closeModal(){
  document.querySelector("#modal").classList.add("hidden");
  selectedPlayer=null;
}

document.querySelector("#search").oninput=()=>{playerRenderLimit=60;renderPlayers();};

document.querySelectorAll(".filter[data-pos]").forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll(".filter[data-pos]").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    playerRenderLimit=60;
    renderPlayers();
  };
});


function ensureChatUI(){
  if(document.querySelector("#chatView"))return;
  const adminView=document.querySelector("#adminView");
  if(!adminView)return;

  const chat=document.createElement("section");
  chat.id="chatView";
  chat.className="hidden";
  chat.style.cssText="position:fixed;inset:0 0 56px 0;z-index:20;background:#07111f;overflow:hidden;padding:calc(env(safe-area-inset-top) + 10px) 12px 6px;";
  chat.innerHTML=`
    <div style="height:100%;max-width:680px;margin:0 auto;display:flex;flex-direction:column;min-height:0;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex:0 0 auto;padding:2px 2px 9px;">
        <div><div style="font-size:16px;font-weight:950;">💬 League Chat</div><div style="font-size:9px;color:#78879a;margin-top:2px;">TD Survivor • league room</div></div>
        <div id="chatLive" style="font-size:8px;color:#5be69d;font-weight:900;">● LIVE</div>
      </div>
      <div id="chatMessages" style="flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:2px 0 8px;"></div>
      <div style="flex:0 0 auto;background:#07111f;padding:7px 0 max(4px,env(safe-area-inset-bottom));">
        <div style="display:flex;gap:7px;align-items:stretch;">
          <textarea id="chatInput" maxlength="500" rows="1" placeholder="Message the league…" style="flex:1;min-width:0;resize:none;background:#0c1828;color:#fff;border:1px solid #293b53;border-radius:12px;padding:10px;font:inherit;max-height:72px;"></textarea>
          <button id="chatSend" class="primary" style="width:64px;min-width:64px;padding:0 8px;">Send</button>
        </div>
      </div>
    </div>`;
  adminView.parentNode.insertBefore(chat,adminView);

  const adminBtn=[...document.querySelectorAll(".navbtn")].find(b=>b.dataset.view==="adminView");
  if(adminBtn){
    const chatBtn=document.createElement("button");
    chatBtn.className="navbtn";
    chatBtn.dataset.view="chatView";
    chatBtn.textContent="💬 Chat";
    adminBtn.parentNode.insertBefore(chatBtn,adminBtn);
  }
  const nav=adminBtn?.parentNode;
  if(nav){
    nav.style.display="grid";
    nav.style.gridTemplateColumns="repeat(5,1fr)";
    nav.style.gap="0";
    nav.style.position="fixed";
    nav.style.left="0";
    nav.style.right="0";
    nav.style.bottom="0";
    nav.style.transform="none";
    nav.style.insetInline="0";
    nav.style.boxSizing="border-box";
    nav.style.width="100vw";
    nav.style.maxWidth="100vw";
    nav.style.margin="0";
    nav.style.marginLeft="0";
    nav.style.marginRight="0";
    nav.style.zIndex="500";
    nav.style.background="#0b1626";
    nav.style.borderTop="1px solid #1d2d43";
    nav.style.padding="4px 6px 4px";
    nav.style.boxSizing="border-box";
    nav.style.minHeight="56px";
    nav.style.overflow="hidden";

    nav.querySelectorAll(".navbtn").forEach(btn=>{
      btn.style.minWidth="0";
      btn.style.width="100%";
      btn.style.maxWidth="none";
      btn.style.margin="0";
      btn.style.padding="5px 1px";
      btn.style.fontSize="8px";
      btn.style.lineHeight="1.15";
      btn.style.whiteSpace="nowrap";
      btn.style.overflow="hidden";
      btn.style.textOverflow="ellipsis";
      btn.style.position="relative";
      btn.style.zIndex="501";
      btn.style.borderRadius="10px";
      btn.style.boxSizing="border-box";
    });
  }

  renderChatUnreadBadge();
  document.querySelector("#chatSend").onclick=sendChatMessage;
  document.querySelector("#chatInput").addEventListener("keydown",e=>{
    if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendChatMessage();}
  });
}

function chatEsc(s){
  return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}


function chatSeenKey(){
  const ownerId=String(state?.owner?.id||state?.owner?.ownerId||"guest");
  return "td_chat_last_seen_"+ownerId;
}

function chatLatestId(messages=chatMessages){
  return (messages||[]).reduce((max,m)=>Math.max(max,Number(m.id)||0),0);
}

function renderChatUnreadBadge(){
  const chatBtn=[...document.querySelectorAll(".navbtn")].find(b=>b.dataset.view==="chatView");
  if(!chatBtn)return;

  let badge=chatBtn.querySelector("#tdChatUnreadBadge");
  if(chatUnreadCount<=0){
    badge?.remove();
    return;
  }

  if(!badge){
    chatBtn.style.position="relative";
    badge=document.createElement("span");
    badge.id="tdChatUnreadBadge";
    badge.style.cssText=[
      "position:absolute",
      "right:4px",
      "top:2px",
      "min-width:16px",
      "height:16px",
      "padding:0 4px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "border-radius:999px",
      "background:#ef4444",
      "color:#fff",
      "font-size:8px",
      "font-weight:950",
      "line-height:1",
      "box-shadow:0 0 0 2px #0b1626",
      "pointer-events:none"
    ].join(";");
    chatBtn.appendChild(badge);
  }

  badge.textContent=chatUnreadCount>99 ? "99+" : String(chatUnreadCount);
}

function markChatSeen(){
  const latest=chatLatestId();
  if(latest>0){
    localStorage.setItem(chatSeenKey(),String(latest));
  }
  chatUnreadCount=0;
  renderChatUnreadBadge();
}

async function checkChatUnread({initialize=false}={}){
  try{
    const r=await fetch(`${CHAT_URL}/rest/v1/chat_messages?select=id&deleted_at=is.null&order=id.desc&limit=100`,{
      headers:{apikey:CHAT_KEY},
      cache:"no-store"
    });
    if(!r.ok)return;

    const rows=await r.json();
    const latest=rows.length ? Number(rows[0].id)||0 : 0;
    const key=chatSeenKey();
    const raw=localStorage.getItem(key);

    // On first-ever use of the unread feature, establish a baseline so old
    // historical chat does not suddenly show as dozens of unread messages.
    if(raw===null){
      if(latest>0)localStorage.setItem(key,String(latest));
      chatUnreadCount=0;
      renderChatUnreadBadge();
      return;
    }

    const lastSeen=Number(raw)||0;
    chatUnreadCount=rows.filter(m=>(Number(m.id)||0)>lastSeen).length;

    // If Chat is currently open, these messages are being viewed now.
    const chatOpen=!document.querySelector("#chatView")?.classList.contains("hidden");
    if(chatOpen){
      if(latest>0)localStorage.setItem(key,String(latest));
      chatUnreadCount=0;
    }

    renderChatUnreadBadge();
  }catch(err){
    console.warn("Unread chat check failed",err);
  }
}

function startChatUnreadChecks(){
  clearInterval(chatUnreadPoll);

  // Small delay allows live bootstrap to populate state.owner first.
  setTimeout(()=>checkChatUnread({initialize:true}),700);

  // Lightweight count check while the app is open. This does not load full
  // messages and does not run more frequently than needed.
  chatUnreadPoll=setInterval(()=>checkChatUnread(),15000);

  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible")checkChatUnread();
  });
}

async function fetchChat(){
  const r=await fetch(`${CHAT_URL}/rest/v1/chat_messages?select=id,owner_id,owner_name,body,message_type,created_at&deleted_at=is.null&order=created_at.asc&limit=100`,{headers:{apikey:CHAT_KEY}});
  if(!r.ok)throw new Error("Could not load chat.");
  chatMessages=await r.json();
  drawChatMessages();

  const chatOpen=!document.querySelector("#chatView")?.classList.contains("hidden");
  if(chatOpen)markChatSeen();
}

function drawChatMessages(){
  const box=document.querySelector("#chatMessages"); if(!box)return;
  if(!chatMessages.length){
    box.innerHTML='<div style="padding:30px 10px;text-align:center;color:#718096;font-size:10px;">No messages yet. Start the league chat.</div>';return;
  }
  box.innerHTML=chatMessages.map(m=>{
    const system=m.message_type!=="user";
    const mine=String(m.owner_name)===String(state.owner?.name||"");
    const t=new Date(m.created_at);
    const stamp=t.toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
    return `<div style="display:flex;justify-content:${mine&&!system?"flex-end":"flex-start"};margin:8px 0;">
      <div style="max-width:86%;padding:9px 10px;border-radius:13px;background:${system?"#172338":mine?"#153a2c":"#15243a"};border:1px solid ${system?"#314661":mine?"#27634b":"#273b56"};">
        <div style="font-size:8px;font-weight:900;color:${system?"#7fb5ff":"#92a2b7"};margin-bottom:4px;">${system?"TD SURVIVOR":chatEsc(m.owner_name)} • ${stamp}</div>
        <div style="font-size:11px;line-height:1.4;white-space:pre-wrap;word-break:break-word;">${chatEsc(m.body)}</div>
      </div>
    </div>`;
  }).join("");
  box.scrollTop=box.scrollHeight;
}

async function openChat(){
  try{
    await fetchChat();
    markChatSeen();
    const live=document.querySelector("#chatLive"); if(live){live.textContent="● LIVE";live.style.color="#5be69d";}
  }catch(err){
    const live=document.querySelector("#chatLive"); if(live){live.textContent="OFFLINE";live.style.color="#ff8993";}
  }
  clearInterval(chatPoll);
  chatPoll=setInterval(()=>{
    if(!document.querySelector("#chatView")?.classList.contains("hidden"))fetchChat().catch(()=>{});
  },3000);
}

async function sendChatMessage(){
  const input=document.querySelector("#chatInput"),btn=document.querySelector("#chatSend");
  const body=input.value.trim(); if(!body)return;
  btn.disabled=true;btn.textContent="…";
  try{
    const proof=await jsonp("chatProof",{token:OWNER_TOKEN});
    if(!proof?.ownerId || !proof?.ownerName || !proof?.authProof)throw new Error("Could not authorize this chat message.");
    const r=await fetch(`${CHAT_URL}/functions/v1/chat-api`,{
      method:"POST",
      headers:{"Content-Type":"application/json",apikey:CHAT_KEY},
      body:JSON.stringify({action:"post",ownerId:proof.ownerId,ownerName:proof.ownerName,body,authProof:proof.authProof})
    });
    const out=await r.json();
    if(!r.ok||!out.ok)throw new Error(out.error||"Message failed.");
    input.value="";
    await fetchChat();
  }catch(err){alert("Chat: "+err.message)}
  finally{btn.disabled=false;btn.textContent="Send";}
}

ensureChatUI();

document.querySelectorAll(".navbtn").forEach(b=>{
  b.onclick=async()=>{
    document.querySelectorAll(".navbtn").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    ["pickView","standingsView","historyView","chatView","adminView"].forEach(id=>{
      document.querySelector("#"+id).classList.toggle("hidden",id!==b.dataset.view);
    });
    if(b.dataset.view==="adminView" && ADMIN_TOKEN){
      try{await loadAdminState();renderAdmin()}catch(err){console.error(err)}
    }
    if(b.dataset.view==="chatView")await openChat();
  };
});

document.querySelector("#close").onclick=closeModal;
document.querySelector(".shade").onclick=closeModal;

document.querySelector("#confirm").onclick=async()=>{
  if(!selectedPlayer) return;
  const e=activeEntry();

  // Snapshot selection before closeModal() clears selectedPlayer.
  const chosenId=selectedPlayer.id;
  const chosenName=selectedPlayer.name;

  if(state.mode!=="live"){
    const existing=e.picks.find(p=>Number(p.week)===Number(state.league.week));
    if(existing){
      existing.player=chosenName;
      existing.playerId=chosenId;
    }else{
      e.picks.push({week:state.league.week,player:chosenName,playerId:chosenId,result:"Pending"});
    }
    closeModal();
    render();
    alert(`Demo pick: ${e.label} → ${chosenName}`);
    return;
  }

  try{
    document.querySelector("#confirm").disabled=true;
    await post("submitPick",{
      token:OWNER_TOKEN,
      entryId:e.id,
      playerId:chosenId,
      playerName:chosenName
    });

    closeModal();
    await new Promise(r=>setTimeout(r,1000));
    await refreshLive();
    alert(`${e.label} Week ${state.league.week} pick saved: ${chosenName}`);
  }catch(err){
    alert(err.message);
  }finally{
    document.querySelector("#confirm").disabled=false;
  }
};


document.querySelector("#profileBtn").onclick=()=>{
  if(state.mode==="live"){
    alert(`Signed in as ${state.owner.name}\n${state.entries.length} play(s) on this account.`);
  }else{
    alert("Demo mode. Once you open a private owner invite link, this becomes a live account connected to Google Sheets.");
  }
};

(async function startTDApp(){
  await retireOldServiceWorkers();
  startUpdateChecks();
  await loadPlayerPool();
  await loadState();
  startChatUnreadChecks();
})();

// Tiny build/version indicator tucked into the Admin tab.
(function renderVersionBadge(){
  const attach=()=>{
    const adminBtn=[...document.querySelectorAll(".navbtn")].find(b=>b.dataset.view==="adminView");
    if(!adminBtn){setTimeout(attach,150);return;}

    document.querySelector("#tdVersionBadge")?.remove();

    adminBtn.style.position="relative";
    const badge=document.createElement("span");
    badge.id="tdVersionBadge";
    badge.textContent="v"+TD_APP_VERSION;
    badge.style.cssText=[
      "position:absolute",
      "right:2px",
      "top:2px",
      "font-size:6.5px",
      "font-weight:700",
      "letter-spacing:.15px",
      "color:#64748a",
      "opacity:.72",
      "pointer-events:none",
      "user-select:none"
    ].join(";");
    adminBtn.appendChild(badge);
  };
  attach();
})();

