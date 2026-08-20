
const API_URL = (window.TD_CONFIG?.API_URL || "").trim();
const params = new URLSearchParams(window.location.search);
const URL_TOKEN = params.get("token");
const JOIN_TOKEN = params.get("join") || "";
const WELCOME_MODE = params.get("welcome")==="1";
const WELCOME_PLAYS = Math.max(1,Math.min(5,Number(params.get("plays")||1)));
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
  safeCommissionerPost(action,{adminToken:ADMIN_TOKEN,...body})
    .then(()=>{
      scheduleLiveReconcile();
    })
    .catch(err=>{
      if(typeof rollback==="function") rollback();
      renderAllLiveViews();
      alert("The change could not be saved after multiple attempts: "+err.message);
    });
}


async function retireOldServiceWorkers(){
  if(!("serviceWorker" in navigator))return null;
  try{
    const names=await caches.keys();
    await Promise.all(names.filter(n=>n.startsWith("td-survivor-")).map(n=>caches.delete(n)));
    return await navigator.serviceWorker.register("./sw.js",{scope:"./",updateViaCache:"none"});
  }catch(err){console.warn("TD Survivor service worker registration failed",err);return null;}
}
const TD_APP_VERSION="10.18.1";
const CHAT_URL="https://tivcjqknukuetgaoryqd.supabase.co";
const PUSH_URL="https://tivcjqknukuetgaoryqd.supabase.co/functions/v1/td-push";
const PUSH_VAPID_PUBLIC="BNGbCawUmJofpZLwLDmtVHYVX7j0yUu74TFIDuylx8InBfDXHDu1kpGa8MLQ07Wc0S-lT5WmxKd1Gn27urC32Fc";
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
      --td-bg:#000000;
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
      background:#000000!important;
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
    .rstatus.alive{color:var(--td-green)!important;}
    .rstatus.out{color:var(--td-red)!important;}
    #tdChatUnreadBadge{background:var(--td-orange)!important;box-shadow:0 0 0 2px #0a0c0f!important;}
    #chatView{background:#000000!important;}
    #chatInput{background:#090b0e!important;border-color:#30353d!important;}
    #chatSend{background:var(--td-orange)!important;}
  `;
  (document.head||document.documentElement).appendChild(style);
})();

(function installPrimeTimeCleanup(){
  const style=document.createElement("style");
  style.id="tdPrimeTimeCleanup";
  style.textContent=`
    /* CHAT — remove remaining Sleeper-blue surfaces */
    #chatMessages > div,
    #chatMessages .message,
    #chatMessages [style*="#13243a"],
    #chatMessages [style*="#172b45"],
    #chatMessages [style*="#1a2c45"],
    #chatMessages [style*="#1b2d46"],
    #chatMessages [style*="#1d304c"]{
      background:linear-gradient(180deg,#111317 0%,#0d0f12 100%)!important;
      border-color:#2b3037!important;
      box-shadow:none!important;
    }

    #chatMessages *{
      --chat-accent:#ff5a00;
    }

    #chatMessages [style*="#6ea8ff"],
    #chatMessages [style*="#7db5ff"],
    #chatMessages [style*="#78adff"],
    #chatMessages [style*="#72a9ff"]{
      color:#ff7a1a!important;
    }

    #chatMessages [style*="#314b70"],
    #chatMessages [style*="#365173"],
    #chatMessages [style*="#2f496a"]{
      border-color:#343941!important;
    }

    #chatInput{
      background:#090b0e!important;
      border-color:#30353d!important;
      color:#f7f8fa!important;
    }

    #chatSend{
      background:#ff5a00!important;
      border-color:#ff5a00!important;
      color:#fff!important;
      box-shadow:0 6px 18px rgba(255,90,0,.18)!important;
    }

    /* Make chat screen end exactly at the nav, no lifted black shelf */
    #chatView{
      inset:0 0 56px 0!important;
      padding-bottom:0!important;
      background:#000000!important;
    }

    #chatView > div{
      height:100%!important;
    }

    #chatView [style*="env(safe-area-inset-bottom)"]{
      padding-bottom:4px!important;
    }

    /* ADMIN — replace remaining navy buttons/cards */
    #adminView button:not(.navbtn):not(.filter){
      background:linear-gradient(180deg,#14171b 0%,#0d0f12 100%)!important;
      border-color:#3a3f46!important;
      color:#f7f8fa!important;
      box-shadow:none!important;
    }

    #adminView button:not(.navbtn):not(.filter):active{
      border-color:#ff5a00!important;
      background:#17100c!important;
    }

    #adminView .admin-badge{
      background:#17100c!important;
      border:1px solid #7a2d00!important;
      color:#ff7a1a!important;
    }

    #adminView .admin-grid > div,
    #adminView [style*="#0f2238"],
    #adminView [style*="#12243a"],
    #adminView [style*="#14263d"],
    #adminView [style*="#172a42"]{
      background:linear-gradient(180deg,#111317 0%,#0d0f12 100%)!important;
      border-color:#2b3037!important;
    }

    #adminView [style*="#4f6f98"],
    #adminView [style*="#45688f"],
    #adminView [style*="#3f6289"]{
      border-color:#3a3f46!important;
    }

    #adminView .eyebrow{
      color:#ff6a12!important;
    }

    /* Keep active nav identity orange across Chat/Admin too */
    .navbtn.active{
      background:linear-gradient(180deg,rgba(255,90,0,.16),rgba(255,90,0,.07))!important;
      box-shadow:inset 0 2px 0 #ff5a00!important;
    }
  `;
  (document.head||document.documentElement).appendChild(style);
})();

(function installPrimeTimeExactOverrides(){
  const style=document.createElement("style");
  style.id="tdPrimeTimeExactOverrides";
  style.textContent=`
    #chatView,#chatView>div,#chatMessages,#chatMessages+div{background:#000000!important;}
    #chatInput{background:#090b0e!important;border-color:#343941!important;}
    #chatSend{background:#ff5a00!important;border-color:#ff5a00!important;color:#fff!important;}
    .nav{
      bottom:0!important;
      margin-bottom:0!important;
      padding-bottom:0!important;
      background:#090b0d!important;
    }
    #adminView .admin-toolbar button{
      border-color:#a83d00!important;
      background:linear-gradient(180deg,#131519,#0d0f12)!important;
    }
    #adminView .admin-grid>div,
    #adminView .admin-row{
      background:#0e1013!important;
      border-color:#343941!important;
    }
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

  document.querySelector("#tdUpdateNow").onclick=()=>{
    const btn=document.querySelector("#tdUpdateNow");
    btn.disabled=true;
    btn.textContent="Updating…";
    localStorage.setItem("td_last_seen_version",String(nextVersion));

    // Navigate immediately. Do not wait on a prefetch that can stall inside an
    // iPhone Home Screen PWA. The root loader will fetch version.json with
    // cache:no-store and then load the exact versioned script.
    const u=new URL(window.location.href);
    u.searchParams.set("_update",String(Date.now()));
    u.searchParams.set("_v",String(nextVersion));
    u.searchParams.set("_fresh",Math.random().toString(36).slice(2));
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

async function safeCommissionerPost(action, body={}, options={}){
  const maxAttempts=Number(options.attempts||3);
  const retryable=new Set([
    "lockWeek",
    "gradePlayer",
    "setPaid"
  ]);

  // Only retry actions that are safe to repeat without creating duplicate entities.
  if(!retryable.has(action)){
    return post(action,body);
  }

  let lastErr=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      await post(action,body);
      return true;
    }catch(err){
      lastErr=err;
      const msg=String(err?.message||err);

      // Retry transient browser/network failures only.
      const transient=/load failed|failed to fetch|network|timeout|timed out|internet|offline/i.test(msg);
      if(!transient || attempt>=maxAttempts){
        throw err;
      }

      console.warn(`Commissioner ${action} attempt ${attempt} failed; retrying…`,err);
      await new Promise(r=>setTimeout(r,450*attempt));
    }
  }

  throw lastErr||new Error("Commissioner request failed.");
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

function showSyncStatus(text,mode="loading"){
  let badge=document.querySelector("#tdSyncStatus");
  if(!badge){
    badge=document.createElement("div");
    badge.id="tdSyncStatus";
    badge.style.cssText=[
      "position:fixed",
      "right:10px",
      "top:calc(env(safe-area-inset-top) + 8px)",
      "z-index:9997",
      "padding:4px 7px",
      "border-radius:999px",
      "font-size:7px",
      "font-weight:900",
      "letter-spacing:.2px",
      "pointer-events:none",
      "transition:opacity .25s ease",
      "box-shadow:0 4px 16px #0007"
    ].join(";");
    document.body.appendChild(badge);
  }

  badge.textContent=text;
  badge.style.background=mode==="live" ? "#0f2d20" : "#171a1f";
  badge.style.color=mode==="live" ? "#31d07c" : "#9aa3ad";
  badge.style.border=mode==="live" ? "1px solid #245b41" : "1px solid #343941";
  badge.style.opacity="1";

  if(mode==="live"){
    clearTimeout(showSyncStatus._timer);
    showSyncStatus._timer=setTimeout(()=>{
      const b=document.querySelector("#tdSyncStatus");
      if(b)b.style.opacity="0";
    },1000);
  }
}

async function loadState(){
  if(API_URL && !API_URL.includes("PASTE_") && OWNER_TOKEN){
    const cached=loadCachedLiveState();

    // INSTANT STARTUP:
    // render the last known live league immediately before waiting on Google.
    if(cached){
      state=cached;
      state.mode="live";
      render();
      showSyncStatus("Updating…","loading");

      // Refresh silently in the background. Cached UI remains fully usable.
      try{
        await refreshLiveWithRetry();
        showSyncStatus("Live ✓","live");
      }catch(err){
        console.warn("Background live refresh failed",err);
        showSyncStatus("Offline • cached","loading");
      }
      return;
    }

    // First-ever launch / no cache yet: perform the normal live load.
    try{
      showSyncStatus("Loading…","loading");
      await refreshLiveWithRetry();
      showSyncStatus("Live ✓","live");
      return;
    }catch(err){
      console.error(err);
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
    topbar.style.paddingTop="calc(env(safe-area-inset-top) + 8px)";
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


async function loadNFLShadowHero(){
  const box=document.querySelector("#nflShadowHeroBody");
  const badge=document.querySelector("#nflShadowBadge");
  if(!box||!badge)return;

  const entry=activeEntry();
  const pick=currentWeekPick(entry);
  const player=playerByPick(pick);
  const team=String(player?.team||"").toUpperCase();

  if(!pick?.player||!team){
    badge.textContent="NO MATCH";
    box.textContent="Game data is not available for this pick yet.";
    return;
  }

  try{
    const r=await jsonp("nflShadowSchedule",{week:String(state.league.week)});
    const games=Array.isArray(r.games)?r.games:[];
    const g=games.find(x=>
      String(x.home||"").toUpperCase()===team ||
      String(x.away||"").toUpperCase()===team
    );

    if(!g){
      badge.textContent="NO GAME";
      box.innerHTML=`No Week ${state.league.week} NFL game matched ${team} yet.`;
      return;
    }

    const s=String(g.state||"scheduled").toLowerCase();
    badge.textContent=s==="live"?"● LIVE":s==="final"?"FINAL":"SCHEDULED";
    badge.style.color=s==="live"?"#38d77a":s==="final"?"#aab2bb":"#f1b45d";

    const hasScore=g.awayScore!=null&&g.homeScore!=null;
    const score=hasScore
      ? `<b style="color:#fff;">${g.away} ${g.awayScore}</b> &nbsp;—&nbsp; <b style="color:#fff;">${g.homeScore} ${g.home}</b>`
      : `<b style="color:#fff;">${g.away}</b> @ <b style="color:#fff;">${g.home}</b>`;

    const detail=s==="live"
      ? [g.periodLabel,g.clock].filter(Boolean).join(" • ")
      : s==="scheduled"
        ? (g.kickoffLabel||"Kickoff time pending")
        : "Game complete";

    box.innerHTML=`
      <div>${score}</div>
      <div style="margin-top:3px;color:${s==="live"?"#e7ebef":"#8f99a4"};">${detail}</div>
      <div style="margin-top:6px;color:#89939d;">
        ${pick.player}: <b style="color:#cdd3d9;">TD tracking not enabled yet</b>
      </div>`;

    // Commissioner-only diagnostic panel.
    const toggle=document.querySelector("#nflShadowDiagToggle");
    const diag=document.querySelector("#nflShadowDiagnostics");

    if(toggle&&diag){
      const checks=g.diagnostics?.checks||{};
      const yes=v=>v?'<span style="color:#37d57a;font-weight:900;">YES</span>':'<span style="color:#ff8a72;font-weight:900;">NO</span>';

      diag.innerHTML=`
        <div style="color:#ff6a00;font-weight:950;letter-spacing:.6px;">BBS FIELD CHECK</div>
        <div style="margin-top:5px;">
          Precise kickoff field: ${yes(checks.preciseKickoff)}<br>
          Explicit status field: ${yes(checks.status)}<br>
          Quarter/period field: ${yes(checks.period)}<br>
          Clock field: ${yes(checks.clock)}<br>
          Score fields: ${yes(checks.scores)}
        </div>
        <div style="margin-top:6px;color:#6f7983;">
          Raw keys: ${(g.diagnostics?.rawKeys||[]).join(", ")||"none"}
        </div>
        <div style="margin-top:6px;color:#6f7983;">
          Candidate values:<br>
          status = ${g.diagnostics?.candidates?.status ?? "—"}<br>
          period = ${g.diagnostics?.candidates?.period ?? "—"}<br>
          clock = ${g.diagnostics?.candidates?.clock ?? "—"}<br>
          kickoff = ${g.diagnostics?.candidates?.kickoff ?? "—"}
        </div>`;

      toggle.onclick=()=>{
        const open=diag.style.display!=="none";
        diag.style.display=open?"none":"block";
        toggle.textContent=open?"🧪 Data diagnostics":"🧪 Hide diagnostics";
      };
    }

  }catch(err){
    badge.textContent="UNAVAILABLE";
    box.textContent="NFL schedule data is temporarily unavailable.";
    console.warn("NFL shadow mode",err);
  }
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

    ${hasPick ? `
    <div id="nflShadowHero" style="margin-top:13px;padding:10px;border:1px solid #2d3339;border-radius:11px;background:#080a0d;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-size:7px;font-weight:950;letter-spacing:.75px;color:${brandOrange};">NFL LIVE • SHADOW MODE</span>
        <span id="nflShadowBadge" style="font-size:7px;font-weight:900;color:#7f8994;">LOADING</span>
      </div>
      <div id="nflShadowHeroBody" style="margin-top:6px;font-size:9px;color:#c8ced5;line-height:1.45;">Matching game…</div>
      ${ADMIN_TOKEN ? `
        <button id="nflShadowDiagToggle"
          style="margin-top:7px;padding:5px 7px;border-radius:8px;border:1px solid #343941;background:#0d1014;color:#8f99a4;font-size:6.8px;font-weight:900;">
          🧪 Data diagnostics
        </button>
        <div id="nflShadowDiagnostics" style="display:none;margin-top:7px;padding:8px;border:1px dashed #343941;border-radius:8px;background:#060708;font-size:6.8px;color:#88929d;line-height:1.45;"></div>
      ` : ""}
      <div style="margin-top:5px;font-size:6.5px;color:#66717c;">Informational only • does not grade your pick</div>
    </div>` : ""}
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
  if(hasPick)setTimeout(loadNFLShadowHero,0);
}


function renderBuybackBucket(){
  const statusEl=document.querySelector("#myStatus");
  const statusBox=statusEl?.parentElement;
  const row=statusBox?.parentElement;
  if(!statusEl || !statusBox || !row)return;

  let box=document.querySelector("#tdBuybackBucket");

  // Build Buy Back from an exact clone of the Your Status card structure.
  // This guarantees identical top/bottom alignment, padding and typography.
  if(!box){
    box=statusBox.cloneNode(false);
    box.id="tdBuybackBucket";

    const statusChildren=[...statusBox.children];
    const titleTemplate=statusChildren[0];
    const valueTemplate=statusEl;

    const title=titleTemplate
      ? titleTemplate.cloneNode(false)
      : document.createElement("div");
    title.textContent="Buy Back";
    title.removeAttribute("id");

    const value=valueTemplate.cloneNode(false);
    value.id="tdBuybackValue";
    value.textContent="";
    value.style.color="";
    value.removeAttribute("data-status");

    box.appendChild(title);
    box.appendChild(value);
    row.appendChild(box);
  }

  row.style.display="grid";
  row.style.gridTemplateColumns="repeat(4,minmax(0,1fr))";
  row.style.gap="7px";

  const e=activeEntry();
  const value=document.querySelector("#tdBuybackValue");
  if(!value)return;

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

  // Treat all four dashboard cards as one component.
  // Same vertical alignment + same exact font size/weight on every value.
  const cards=[...row.children].slice(0,4);
  cards.forEach(card=>{
    card.style.minWidth="0";
    card.style.boxSizing="border-box";

    const children=[...card.children];
    const title=children[0];
    const statValue=children[children.length-1];

    if(title){
      title.style.marginTop="0";
      title.style.marginBottom="0";
    }

    if(statValue){
      statValue.style.fontSize="12px";
      statValue.style.fontWeight="950";
      statValue.style.lineHeight="1.05";
      statValue.style.marginTop="7px";
      statValue.style.whiteSpace="nowrap";
      statValue.style.letterSpacing="-.55px";
      statValue.style.maxWidth="100%";
      statValue.style.boxSizing="border-box";
    }
  });

  // AVAILABLE / UNAVAILABLE keep the SAME 12px font size as the other cards.
  // A condensed typeface + tighter tracking makes the long words fit rather
  // than shrinking only this card and breaking the visual hierarchy.
  value.style.fontFamily='"Arial Narrow","Roboto Condensed","Helvetica Neue Condensed",Inter,system-ui,sans-serif';
  value.style.letterSpacing="-1px";
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
      const result=String(p.result||"Pending").trim().toLowerCase();
      const hit=result==="td" || /hit|scored|survived|correct|win/.test(result);
      const miss=result==="no td" || /miss|out|failed|lost|loss/.test(result);
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

function applyPrimeTimeAdminTheme(){
  const view=document.querySelector("#adminView");
  if(!view)return;

  view.style.background="linear-gradient(180deg,#101317 0%,#0c0e11 100%)";
  view.style.borderColor="#2f343a";

  const badge=view.querySelector(".admin-badge");
  if(badge){
    badge.style.background="#1a0f09";
    badge.style.color="#ff7a1a";
    badge.style.border="1px solid #a83d00";
  }

  const statTiles=[...view.querySelectorAll(".admin-grid > div")];
  statTiles.forEach(tile=>{
    tile.style.background="#0d0f12";
    tile.style.border="1px solid #343941";
    tile.style.boxShadow="none";
  });

  statTiles.forEach(tile=>{
    const label=String(tile.querySelector("span")?.textContent||"").trim().toLowerCase();
    const b=tile.querySelector("b");
    if(!b)return;
    if(label==="alive") b.style.color="#31d07c";
    else if(label==="missing") b.style.color="#ff6673";
    else b.style.color="#f7f8fa";
  });

  view.querySelectorAll(".admin-toolbar button").forEach(btn=>{
    btn.style.background="linear-gradient(180deg,#131519 0%,#0d0f12 100%)";
    btn.style.border="1px solid #a83d00";
    btn.style.color="#f7f8fa";
    btn.style.boxShadow="0 0 0 1px rgba(255,90,0,.06)";
  });

  view.querySelectorAll(".admin-row").forEach(row=>{
    row.style.background="#0e1013";
    row.style.borderColor="#2f343a";

    const meta=row.querySelector(".admin-row-meta");
    const txt=String(meta?.textContent||"").toUpperCase();

    if(meta){
      if(txt.includes("• ALIVE")) meta.style.color="#31d07c";
      else if(txt.includes("• OUT")) meta.style.color="#ff6673";
      else if(txt.includes("NO PICK")) meta.style.color="#f5c542";
      else meta.style.color="#9aa3ad";
    }

    row.querySelectorAll(".mini-btn").forEach(btn=>{
      const text=String(btn.textContent||"").trim().toLowerCase();
      btn.style.background="#111317";
      btn.style.boxShadow="none";

      if(text==="paid"){
        btn.style.border="1px solid #256648";
        btn.style.color="#31d07c";
      }else if(text.includes("undo buyback")){
        btn.style.border="1px solid #a83d00";
        btn.style.color="#ff7a1a";
      }else if(text.includes("available") || text.includes("use buyback")){
        btn.style.border="1px solid #8a6a11";
        btn.style.color="#f5c542";
      }else{
        btn.style.border="1px solid #3a3f46";
        btn.style.color="#f7f8fa";
      }
    });
  });

  const playsTitle=view.querySelector(".admin-section h4");
  if(playsTitle) playsTitle.style.color="#ff7a1a";
}


function baseInviteUrl(){
  const u=new URL(window.location.href);
  u.search="";
  u.hash="";
  return u.toString();
}

async function copyTextFallback(text){
  if(navigator.clipboard?.writeText){
    await navigator.clipboard.writeText(text);
    return true;
  }
  const ta=document.createElement("textarea");
  ta.value=text;
  ta.style.position="fixed";
  ta.style.opacity="0";
  document.body.appendChild(ta);
  ta.select();
  const ok=document.execCommand("copy");
  ta.remove();
  if(!ok)throw new Error("Copy failed.");
  return true;
}


function urlBase64ToUint8Array(x){const p="=".repeat((4-x.length%4)%4),b=(x+p).replace(/-/g,"+").replace(/_/g,"/"),r=atob(b);return Uint8Array.from([...r].map(c=>c.charCodeAt(0)));}
function pushSupported(){return "serviceWorker" in navigator&&"PushManager" in window&&"Notification" in window;}
async function currentPushSubscription(){if(!pushSupported())return null;const reg=await navigator.serviceWorker.ready;return reg.pushManager.getSubscription();}
async function enableTDPush(){
  if(!pushSupported())throw new Error("Push notifications are not supported on this device/browser.");
  const ownerId=String(state?.owner?.id||state?.owner?.ownerId||"").trim();
  if(!ownerId)throw new Error("Your owner account is not loaded yet.");
  const standalone=window.matchMedia?.("(display-mode: standalone)")?.matches||window.navigator.standalone===true;
  if(/iPhone|iPad|iPod/i.test(navigator.userAgent||"")&&!standalone)throw new Error("On iPhone, save TD Survivor to your Home Screen first, then open the Home Screen app and enable notifications.");
  if(await Notification.requestPermission()!=="granted")throw new Error("Notifications were not allowed.");
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(PUSH_VAPID_PUBLIC)});
  const r=await fetch(PUSH_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"subscribe",ownerId,subscription:sub.toJSON(),userAgent:navigator.userAgent})});
  const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||"Could not register notifications.");
}
async function disableTDPush(){const sub=await currentPushSubscription();if(sub){try{await fetch(PUSH_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"unsubscribe",endpoint:sub.endpoint})});}catch(_){}await sub.unsubscribe().catch(()=>{});}}
async function renderNotificationCard(){
  document.querySelector("#tdNotificationCard")?.remove();
  const pickView=document.querySelector("#pickView");if(!pickView||!state?.owner)return;
  const supported=pushSupported(),standalone=window.matchMedia?.("(display-mode: standalone)")?.matches||window.navigator.standalone===true,isiOS=/iPhone|iPad|iPod/i.test(navigator.userAgent||"");
  const sub=supported?await currentPushSubscription().catch(()=>null):null,enabled=Boolean(sub&&Notification.permission==="granted");
  const card=document.createElement("section");card.id="tdNotificationCard";card.className="card";card.style.cssText="margin-bottom:12px;padding:13px;border:1px solid #2b2f34;background:#08090a;";
  card.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><div><div style="font-size:8px;color:#ff7a1a;font-weight:950;letter-spacing:.8px;">NOTIFICATIONS</div><div style="font-size:12px;font-weight:950;margin-top:2px;">${enabled?"Reminders are ON":"Never miss a pick"}</div><div style="font-size:8px;color:#929ca7;line-height:1.45;margin-top:4px;">${enabled?"Missing picks, locks, new weeks, graded picks, buybacks and commissioner updates can reach this phone.":isiOS&&!standalone?"Open TD Survivor from your Home Screen to enable push reminders.":"Enable phone alerts for picks, results, buybacks and important league updates."}</div></div><button id="tdPushToggle" style="flex:0 0 auto;padding:9px 10px;border-radius:9px;border:1px solid ${enabled?"#315d47":"#a83d00"};background:${enabled?"#0d2118":"#211109"};color:${enabled?"#31d07c":"#ff7a1a"};font-weight:950;">${enabled?"ON":"Enable"}</button></div>`;
  pickView.insertAdjacentElement("beforebegin",card);
  card.querySelector("#tdPushToggle").onclick=async()=>{const b=card.querySelector("#tdPushToggle");if(enabled){if(!confirm("Turn off TD Survivor notifications on this device?"))return;b.disabled=true;await disableTDPush();renderNotificationCard();return;}b.disabled=true;b.textContent="Enabling…";try{await enableTDPush();await renderNotificationCard();alert("TD Survivor notifications are on.");}catch(err){b.disabled=false;b.textContent="Enable";alert(err.message);}};
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
      <button id="inviteOwnerAdmin">🔗 Invite / Share</button>
      <button id="addEntryAdmin">➕ Add Play</button>
      <button id="removeEntryAdmin">➖ Remove Play</button>
      <button id="removeOwnerAdmin">🗑 Remove Person</button>
      <button id="lockAdmin">${locked?"🔓 Unlock Picks":"🔒 Lock Picks"}</button>
      <button id="advanceWeekAdmin">➡️ Advance Week</button>
      <button id="deadlineAdmin">⏰ Change Deadline</button>
      <button id="weekAdmin">📅 Manual Week</button>
      <button id="gradeAdmin">🏈 Grade Player</button>
      <button id="massGradeAdmin">📋 Mass Grade</button>
      <button id="setPickAdmin">✏️ Set/Edit Pick</button>
      <button id="overrideAdmin">🛠 Override Entry</button>
      <button id="announceAdmin">📣 Announcement</button>
      <button id="missingPickAdmin">⏰ Missing Picks</button>
      <button id="pushMissingAdmin">🔔 Push Missing Picks</button>
      <button id="pushAnnouncementAdmin">📣 Push Announcement</button>
      <button id="smartReminderAdmin">⏱ Auto Reminders: ${String(adminState.league.smart_reminders_enabled||"FALSE").toUpperCase()==="TRUE"?"ON":"OFF"}</button>
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

  applyPrimeTimeAdminTheme();

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
    try{
      await adminPost("addOwner",{name});
      alert(`${name} added.\n\nUse Invite / Share to send their private league link.`);
    }catch(err){alert(err.message)}
  };

  document.querySelector("#inviteOwnerAdmin").onclick=async()=>{
    const existing=document.querySelector("#inviteOwnerPanel");
    if(existing){existing.remove();return;}

    const panel=document.createElement("div");
    panel.id="inviteOwnerPanel";
    panel.style.cssText="margin-top:10px;padding:12px;border:1px solid #a83d00;border-radius:12px;background:#0c0e11;";
    panel.innerHTML=`
      <div style="font-size:9px;color:#ff7a1a;font-weight:950;letter-spacing:.9px;margin-bottom:4px;">LEAGUE INVITE LINK</div>
      <div style="font-size:8px;color:#929ca7;line-height:1.45;margin-bottom:10px;">
        Send this one link to anyone interested in joining. They will enter their own name and choose 1–5 plays.
      </div>

      <button id="generateLeagueInvite" class="primary" style="width:100%;">Get League Invite Link</button>

      <div id="leagueInviteResult" style="display:none;margin-top:11px;padding-top:11px;border-top:1px solid #292e35;">
        <div id="leagueInviteUrl"
          style="font-size:8px;line-height:1.4;color:#aab3bd;background:#090b0e;border:1px solid #343941;border-radius:9px;padding:8px;word-break:break-all;"></div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px;">
          <button id="copyLeagueInvite"
            style="padding:10px;border-radius:9px;border:1px solid #a83d00;background:#15100d;color:#ff7a1a;font-weight:900;">📋 Copy Link</button>
          <button id="shareLeagueInvite"
            style="padding:10px;border-radius:9px;border:1px solid #a83d00;background:#ff5a00;color:#fff;font-weight:900;">📤 Share</button>
        </div>

        <button id="rotateLeagueInvite"
          style="width:100%;margin-top:8px;padding:9px;border-radius:9px;border:1px solid #3a3f46;background:#111317;color:#aab3bd;font-weight:850;">
          🔄 Regenerate / Revoke Old Invite Link
        </button>

        <div style="font-size:7.5px;color:#7f8994;line-height:1.45;margin-top:8px;">
          Anyone with the current league invite link can join until you regenerate it. After joining, each person receives their own private owner login automatically.
        </div>
      </div>
    `;

    document.querySelector("#inviteOwnerAdmin").insertAdjacentElement("afterend",panel);

    let currentInviteUrl="";

    async function loadInvite(rotate=false){
      const btn=document.querySelector("#generateLeagueInvite");
      btn.disabled=true;
      btn.textContent=rotate?"Regenerating…":"Generating…";

      try{
        const data=await jsonp(rotate?"rotateLeagueInvite":"leagueInvite",{
          adminToken:ADMIN_TOKEN
        });
        if(!data?.inviteToken)throw new Error("Invite token was not returned.");

        const u=new URL(baseInviteUrl());
        u.searchParams.set("join",data.inviteToken);
        currentInviteUrl=u.toString();

        document.querySelector("#leagueInviteUrl").textContent=currentInviteUrl;
        document.querySelector("#leagueInviteResult").style.display="block";
      }catch(err){
        alert("Could not generate league invite link: "+err.message);
      }finally{
        btn.disabled=false;
        btn.textContent="Get League Invite Link";
      }
    }

    document.querySelector("#generateLeagueInvite").onclick=()=>loadInvite(false);

    document.querySelector("#copyLeagueInvite").onclick=async()=>{
      if(!currentInviteUrl)return;
      try{
        await copyTextFallback(currentInviteUrl);
        const b=document.querySelector("#copyLeagueInvite");
        const old=b.textContent;
        b.textContent="✅ Copied";
        setTimeout(()=>b.textContent=old,1200);
      }catch(_){
        alert("Could not copy the invite link.");
      }
    };

    document.querySelector("#shareLeagueInvite").onclick=async()=>{
      if(!currentInviteUrl)return;
      const text=`Want to join TD Survivor?\n\nOpen this link, enter your name, and choose how many plays you want (max 5):\n${currentInviteUrl}`;

      if(navigator.share){
        try{
          await navigator.share({title:"Join TD Survivor",text});
          return;
        }catch(err){
          if(err?.name==="AbortError")return;
        }
      }

      try{
        await copyTextFallback(text);
        alert("Invite message copied. Paste it into your text message.");
      }catch(_){
        alert("Sharing is unavailable on this device. Use Copy Link instead.");
      }
    };

    document.querySelector("#rotateLeagueInvite").onclick=async()=>{
      if(!confirm("Regenerate the league invite link?\n\nThe old link will stop working immediately."))return;
      await loadInvite(true);
    };
  };

  document.querySelector("#addEntryAdmin").onclick=async()=>{
    const name=prompt("Owner name to add another play for:");if(!name)return;
    const o=owners.find(x=>x.name.toLowerCase()===name.toLowerCase());
    if(!o){alert("Owner not found.");return}
    try{await adminPost("addEntry",{ownerId:o.id})}catch(err){alert(err.message)}
  };

  document.querySelector("#removeEntryAdmin").onclick=()=>{
    const existing=document.querySelector("#removeEntryPanel");
    if(existing){existing.remove();return;}

    const entriesSorted=[...(adminState.entries||[])].sort((a,b)=>String(a.label).localeCompare(String(b.label)));
    if(!entriesSorted.length){alert("There are no plays to remove.");return;}

    const panel=document.createElement("div");
    panel.id="removeEntryPanel";
    panel.style.cssText="margin-top:10px;padding:12px;border:1px solid #6e3038;border-radius:12px;background:#140c0e;";
    panel.innerHTML=`
      <div style="font-size:9px;color:#ff6673;font-weight:950;letter-spacing:.9px;margin-bottom:7px;">REMOVE PLAY</div>

      <select id="removeEntrySelect"
        style="width:100%;background:#090b0e;color:#fff;border:1px solid #493238;border-radius:10px;padding:11px;margin-bottom:9px;">
        <option value="">Select play to remove…</option>
        ${entriesSorted.map(e=>`<option value="${e.id}">${e.label} — ${e.ownerName}</option>`).join("")}
      </select>

      <div id="removeEntryWarning"
        style="display:none;font-size:8px;color:#c6a1a7;line-height:1.45;margin-bottom:9px;"></div>

      <button id="confirmRemoveEntry"
        style="width:100%;padding:11px;border-radius:10px;border:1px solid #8d3039;background:#351519;color:#ff8791;font-weight:950;">
        Remove Selected Play
      </button>
    `;

    document.querySelector("#removeEntryAdmin").insertAdjacentElement("afterend",panel);

    const select=document.querySelector("#removeEntrySelect");
    const warning=document.querySelector("#removeEntryWarning");

    select.onchange=()=>{
      const entry=entriesSorted.find(e=>String(e.id)===String(select.value));
      if(!entry){
        warning.style.display="none";
        warning.textContent="";
        return;
      }
      warning.style.display="block";
      warning.textContent=`${entry.label} will be permanently deleted along with all pick history for that play. The owner account will remain.`;
    };

    document.querySelector("#confirmRemoveEntry").onclick=async()=>{
      const entry=entriesSorted.find(e=>String(e.id)===String(select.value));
      if(!entry){alert("Select a play first.");return;}

      if(!confirm(
        `Remove ${entry.label}?\\n\\nThis permanently deletes this play and all of its pick history.\\n\\nThe owner account will remain.`
      ))return;

      const btn=document.querySelector("#confirmRemoveEntry");
      btn.disabled=true;
      btn.textContent="Removing…";

      try{
        await adminPost("removeEntry",{entryId:entry.id});
        alert(`${entry.label} was removed.`);
      }catch(err){
        btn.disabled=false;
        btn.textContent="Remove Selected Play";
        alert("Could not remove play: "+err.message);
      }
    };
  };

  document.querySelector("#removeOwnerAdmin").onclick=()=>{
    const existing=document.querySelector("#removeOwnerPanel");
    if(existing){existing.remove();return;}

    const ownersSorted=[...(adminState.owners||[])]
      .filter(o=>o.active!==false)
      .sort((a,b)=>String(a.name).localeCompare(String(b.name)));

    if(!ownersSorted.length){alert("There are no people to remove.");return;}

    const panel=document.createElement("div");
    panel.id="removeOwnerPanel";
    panel.style.cssText="margin-top:10px;padding:12px;border:1px solid #6e3038;border-radius:12px;background:#140c0e;";
    panel.innerHTML=`
      <div style="font-size:9px;color:#ff6673;font-weight:950;letter-spacing:.9px;margin-bottom:7px;">REMOVE PERSON</div>

      <select id="removeOwnerSelect"
        style="width:100%;background:#090b0e;color:#fff;border:1px solid #493238;border-radius:10px;padding:11px;margin-bottom:9px;">
        <option value="">Select person to remove…</option>
        ${ownersSorted.map(o=>{
          const count=(adminState.entries||[]).filter(e=>String(e.ownerId)===String(o.id)).length;
          return `<option value="${o.id}">${o.name} — ${count} play${count===1?"":"s"}</option>`;
        }).join("")}
      </select>

      <div id="removeOwnerWarning"
        style="display:none;font-size:8px;color:#c6a1a7;line-height:1.45;margin-bottom:9px;"></div>

      <button id="confirmRemoveOwner"
        style="width:100%;padding:11px;border-radius:10px;border:1px solid #8d3039;background:#351519;color:#ff8791;font-weight:950;">
        Remove Selected Person
      </button>
    `;

    document.querySelector("#removeOwnerAdmin").insertAdjacentElement("afterend",panel);

    const select=document.querySelector("#removeOwnerSelect");
    const warning=document.querySelector("#removeOwnerWarning");

    select.onchange=()=>{
      const owner=ownersSorted.find(o=>String(o.id)===String(select.value));
      if(!owner){
        warning.style.display="none";
        warning.textContent="";
        return;
      }

      const ownedEntries=(adminState.entries||[]).filter(e=>String(e.ownerId)===String(owner.id));
      warning.style.display="block";
      warning.textContent=`${owner.name} will be permanently deleted along with ${ownedEntries.length} play${ownedEntries.length===1?"":"s"} and all attached pick history.`;
    };

    document.querySelector("#confirmRemoveOwner").onclick=async()=>{
      const owner=ownersSorted.find(o=>String(o.id)===String(select.value));
      if(!owner){alert("Select a person first.");return;}

      const ownedEntries=(adminState.entries||[]).filter(e=>String(e.ownerId)===String(owner.id));

      if(!confirm(
        `Remove ${owner.name}?\\n\\nThis permanently deletes their account, ${ownedEntries.length} play${ownedEntries.length===1?"":"s"}, and all attached pick history.\\n\\nThis cannot be undone.`
      ))return;

      const btn=document.querySelector("#confirmRemoveOwner");
      btn.disabled=true;
      btn.textContent="Removing…";

      try{
        await adminPost("removeOwner",{ownerId:owner.id});
        alert(`${owner.name} and all of their plays were removed.`);
      }catch(err){
        btn.disabled=false;
        btn.textContent="Remove Selected Person";
        alert("Could not remove person: "+err.message);
      }
    };
  };

  document.querySelector("#lockAdmin").onclick=async()=>{
    const button=document.querySelector("#lockAdmin");
    const previous=String(adminState.league.week_locked).toUpperCase()==="TRUE";
    const next=!previous;
    const week=Number(state.league.week);
    const entries=adminState.entries||[];
    const alive=entries.filter(e=>e.status==="alive");
    const submitted=alive.filter(e=>String(e.currentPick||"").trim()).length;

    const originalText=button.textContent;
    button.disabled=true;
    button.textContent=next ? "🔒 Locking…" : "🔓 Unlocking…";
    button.style.opacity=".72";

    try{
      await safeCommissionerPost("lockWeek",{
        adminToken:ADMIN_TOKEN,
        locked:next
      });

      // Only update the visible state AFTER the backend write completes.
      adminState.league.week_locked=next?"TRUE":"FALSE";
      state.league.locked=next;
      renderAdmin();
      renderHeader();
      renderStandings();

      // Reconcile quietly in the background.
      scheduleLiveReconcile();

      // Post Chat only after the lock/unlock save has succeeded.
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
      }catch(chatErr){
        console.warn("Lock chat announcement failed",chatErr);
      }
    }catch(err){
      // State never flipped locally, so there is nothing to roll back.
      button.disabled=false;
      button.textContent=originalText;
      button.style.opacity="1";
      alert(
        `${next?"Locking":"Unlocking"} picks failed after multiple attempts.\n\n`+
        `${err.message}\n\nThe week remains ${previous?"LOCKED":"OPEN"}.`
      );
    }
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

  document.querySelector("#deadlineAdmin").onclick=()=>{
    const existing=document.querySelector("#deadlineChangePanel");
    if(existing){existing.remove();return;}

    const current=String(state.league.deadline||adminState.league.deadline_label||"Thu • 8:15 PM ET");

    // Parse existing deadline so the dropdowns open on the current values.
    const m=current.match(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b.*?(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET/i);
    const currentDay=m?m[1]:"Thu";
    const currentHour=m?Number(m[2]):8;
    const currentMinute=m?Number(m[3]):15;
    const currentAmPm=m?String(m[4]).toUpperCase():"PM";

    const days=[
      ["Sun","Sunday"],["Mon","Monday"],["Tue","Tuesday"],["Wed","Wednesday"],
      ["Thu","Thursday"],["Fri","Friday"],["Sat","Saturday"]
    ];

    // Five-minute increments cover normal NFL kickoff times while preventing
    // typing mistakes. If an existing deadline has an unusual minute value,
    // include it so changing only the day/hour does not alter the minute.
    const minuteValues=[...new Set([
      0,5,10,15,20,25,30,35,40,45,50,55,currentMinute
    ])].sort((a,b)=>a-b);

    const panel=document.createElement("div");
    panel.id="deadlineChangePanel";
    panel.style.cssText="margin-top:10px;padding:12px;border:1px solid #a83d00;border-radius:12px;background:#0c0e11;";
    panel.innerHTML=`
      <div style="font-size:9px;color:#ff7a1a;font-weight:950;letter-spacing:.9px;">CHANGE PICK DEADLINE</div>
      <div style="font-size:8px;color:#929ca7;line-height:1.45;margin-top:4px;">
        Week ${state.league.week} • Current: <b style="color:#f7f8fa;">${current}</b>
      </div>

      <label style="display:block;font-size:7.5px;color:#8f99a4;font-weight:900;margin-top:12px;">DAY</label>
      <select id="deadlineDay"
        style="width:100%;box-sizing:border-box;margin-top:5px;background:#090b0e;color:#fff;border:1px solid #343941;border-radius:10px;padding:11px;">
        ${days.map(([v,label])=>`<option value="${v}" ${v===currentDay?"selected":""}>${label}</option>`).join("")}
      </select>

      <label style="display:block;font-size:7.5px;color:#8f99a4;font-weight:900;margin-top:11px;">TIME • EASTERN</label>
      <div style="display:grid;grid-template-columns:1fr .9fr 1fr;gap:7px;margin-top:5px;">
        <select id="deadlineHour"
          style="width:100%;background:#090b0e;color:#fff;border:1px solid #343941;border-radius:10px;padding:11px;">
          ${Array.from({length:12},(_,i)=>i+1).map(h=>`<option value="${h}" ${h===currentHour?"selected":""}>${h}</option>`).join("")}
        </select>

        <select id="deadlineMinute"
          style="width:100%;background:#090b0e;color:#fff;border:1px solid #343941;border-radius:10px;padding:11px;">
          ${minuteValues.map(min=>`<option value="${min}" ${min===currentMinute?"selected":""}>:${String(min).padStart(2,"0")}</option>`).join("")}
        </select>

        <select id="deadlineAmPm"
          style="width:100%;background:#090b0e;color:#fff;border:1px solid #343941;border-radius:10px;padding:11px;">
          <option value="AM" ${currentAmPm==="AM"?"selected":""}>AM</option>
          <option value="PM" ${currentAmPm==="PM"?"selected":""}>PM</option>
        </select>
      </div>

      <div id="deadlinePreview"
        style="margin-top:10px;padding:9px;border:1px solid #2f343a;border-radius:9px;background:#090b0e;font-size:8px;color:#9aa3ad;">
      </div>

      <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:7px;margin-top:10px;">
        <button id="cancelDeadlineChange"
          style="padding:10px;border-radius:9px;border:1px solid #3a3f46;background:#111317;color:#aab3bd;font-weight:900;">
          Cancel
        </button>
        <button id="saveDeadlineChange"
          style="padding:10px;border-radius:9px;border:1px solid #ff5a00;background:#ff5a00;color:#fff;font-weight:950;">
          Save Deadline
        </button>
      </div>

      <div style="font-size:7.5px;color:#7f8994;line-height:1.45;margin-top:8px;">
        Smart Reminders automatically follow the selected day and Eastern Time.
      </div>
    `;

    document.querySelector("#deadlineAdmin").insertAdjacentElement("afterend",panel);

    const day=document.querySelector("#deadlineDay");
    const hour=document.querySelector("#deadlineHour");
    const minute=document.querySelector("#deadlineMinute");
    const ampm=document.querySelector("#deadlineAmPm");
    const preview=document.querySelector("#deadlinePreview");

    function selectedDeadline(){
      return `${day.value} • ${Number(hour.value)}:${String(Number(minute.value)).padStart(2,"0")} ${ampm.value} ET`;
    }

    function updatePreview(){
      preview.innerHTML=`New deadline: <b style="color:#f7f8fa;">${selectedDeadline()}</b>`;
    }

    [day,hour,minute,ampm].forEach(el=>el.onchange=updatePreview);
    updatePreview();

    document.querySelector("#cancelDeadlineChange").onclick=()=>panel.remove();

    document.querySelector("#saveDeadlineChange").onclick=async()=>{
      const clean=selectedDeadline();

      if(clean===current){
        alert("The deadline is already set to "+current+".");
        return;
      }

      if(!confirm(
        `Change Week ${state.league.week} pick deadline?\n\n`+
        `OLD: ${current}\n`+
        `NEW: ${clean}\n\n`+
        `Smart Reminders will automatically follow the new deadline.`
      ))return;

      const btn=document.querySelector("#saveDeadlineChange");
      btn.disabled=true;
      btn.textContent="Saving…";

      try{
        await post("setDeadline",{
          adminToken:ADMIN_TOKEN,
          deadlineLabel:clean
        });

        try{
          await postSystemMessage(
            `⏰ WEEK ${state.league.week} DEADLINE UPDATED\n\n`+
            `Picks are now due: ${clean}\n\n`+
            `Smart reminders will follow the updated deadline.`
          );
        }catch(chatErr){
          console.warn("Deadline-change chat announcement failed",chatErr);
        }

        btn.textContent="✅ Updated";
        setTimeout(()=>window.location.reload(),700);
      }catch(err){
        btn.disabled=false;
        btn.textContent="Save Deadline";
        alert("Could not change deadline: "+err.message);
      }
    };
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

        await safeCommissionerPost("gradePlayer",{adminToken:ADMIN_TOKEN,playerName:player,scored});
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

  document.querySelector("#massGradeAdmin").onclick=()=>{
    const existing=document.querySelector("#massGradePanel");
    if(existing){existing.remove();return;}

    document.querySelector("#gradePanel")?.remove();

    const entries=adminState.entries||[];
    const usedPlayers=[...new Set(
      entries
        .map(e=>String(e.currentPick||"").trim())
        .filter(Boolean)
    )].sort((a,b)=>a.localeCompare(b));

    if(!usedPlayers.length){
      alert("No Week "+state.league.week+" picks have been submitted yet.");
      return;
    }

    const playerRows=usedPlayers.map((player,i)=>{
      const affected=entries.filter(e=>e.currentPick===player);
      const currentResults=[...new Set(
        affected
          .map(e=>String(e.currentResult||"Pending").trim()||"Pending")
      )];
      const current=currentResults.length===1 ? currentResults[0] : "Mixed";
      const currentColor=current==="TD" ? "#31d07c" : current==="No TD" ? "#ff6673" : "#9aa3ad";

      return `
        <div class="mass-grade-row" data-mass-player="${player.replaceAll('"','&quot;')}"
          style="padding:10px 0;border-bottom:1px solid #292e35;">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:8px;">
            <div style="min-width:0;">
              <div style="font-size:11px;font-weight:950;color:#f7f8fa;">${player}</div>
              <div style="font-size:8px;color:#9aa3ad;margin-top:2px;">
                ${affected.length} play${affected.length===1?"":"s"} •
                current: <span style="color:${currentColor};font-weight:900;">${current}</span>
              </div>
            </div>
            <div style="font-size:8px;color:#7f8994;white-space:nowrap;">${affected.map(e=>e.label).join(", ")}</div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
            <button type="button" class="mass-choice active" data-mass-choice="keep"
              style="padding:8px 4px;border-radius:9px;border:1px solid #3a3f46;background:#16191d;color:#aab2bc;font-weight:900;font-size:8px;">
              — NO CHANGE
            </button>
            <button type="button" class="mass-choice" data-mass-choice="td"
              style="padding:8px 4px;border-radius:9px;border:1px solid #256648;background:#10281e;color:#31d07c;font-weight:900;font-size:8px;">
              ✅ TD
            </button>
            <button type="button" class="mass-choice" data-mass-choice="no"
              style="padding:8px 4px;border-radius:9px;border:1px solid #6e3038;background:#261216;color:#ff6673;font-weight:900;font-size:8px;">
              ❌ NO TD
            </button>
          </div>
        </div>`;
    }).join("");

    const panel=document.createElement("div");
    panel.id="massGradePanel";
    panel.style.cssText="margin-top:10px;padding:12px;border:1px solid #a83d00;border-radius:12px;background:#0c0e11;";
    panel.innerHTML=`
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:6px;">
        <div>
          <div style="font-size:9px;color:#ff7a1a;font-weight:950;letter-spacing:.9px;">MASS GRADE • WEEK ${state.league.week}</div>
          <div style="font-size:8px;color:#8f99a4;margin-top:3px;">Grade multiple utilized players, then save everything once.</div>
        </div>
        <button id="closeMassGrade" type="button"
          style="width:28px;height:28px;border-radius:50%;border:1px solid #3a3f46;background:#121417;color:#aeb6bf;">×</button>
      </div>

      <div style="display:flex;gap:6px;margin:10px 0;">
        <button id="massAllTd" type="button"
          style="flex:1;padding:8px;border-radius:9px;border:1px solid #256648;background:#10281e;color:#31d07c;font-size:8px;font-weight:900;">
          ALL → TD
        </button>
        <button id="massClear" type="button"
          style="flex:1;padding:8px;border-radius:9px;border:1px solid #3a3f46;background:#121417;color:#aeb6bf;font-size:8px;font-weight:900;">
          CLEAR
        </button>
      </div>

      <div id="massGradeRows">${playerRows}</div>

      <button id="saveMassGrades" class="primary"
        style="width:100%;margin-top:12px;background:#ff5a00!important;border-color:#ff5a00!important;">
        Save Selected Grades
      </button>
      <div id="massGradeStatus" style="font-size:8px;color:#8f99a4;margin-top:7px;line-height:1.4;">
        Rows left on “No Change” will not be touched.
      </div>
    `;

    document.querySelector("#massGradeAdmin").insertAdjacentElement("afterend",panel);

    const rows=[...panel.querySelectorAll(".mass-grade-row")];

    function setChoice(row,choice){
      row.dataset.choice=choice;
      row.querySelectorAll(".mass-choice").forEach(btn=>{
        const active=btn.dataset.massChoice===choice;
        btn.style.boxShadow=active ? "0 0 0 2px rgba(255,90,0,.38)" : "none";
        btn.style.transform=active ? "translateY(-1px)" : "none";
        btn.style.opacity=active ? "1" : ".72";
      });
    }

    rows.forEach(row=>{
      setChoice(row,"keep");
      row.querySelectorAll(".mass-choice").forEach(btn=>{
        btn.onclick=()=>setChoice(row,btn.dataset.massChoice);
      });
    });

    document.querySelector("#closeMassGrade").onclick=()=>panel.remove();
    document.querySelector("#massClear").onclick=()=>rows.forEach(r=>setChoice(r,"keep"));
    document.querySelector("#massAllTd").onclick=()=>rows.forEach(r=>setChoice(r,"td"));

    document.querySelector("#saveMassGrades").onclick=async()=>{
      const changes=rows
        .map(row=>({
          player:row.dataset.massPlayer,
          choice:row.dataset.choice||"keep"
        }))
        .filter(x=>x.choice!=="keep");

      if(!changes.length){
        alert("Choose at least one TD or NO TD result first.");
        return;
      }

      const summary=changes.map(x=>`${x.player}: ${x.choice==="td"?"TD":"NO TD"}`).join("\n");
      if(!confirm(`Save ${changes.length} grading result${changes.length===1?"":"s"}?\n\n${summary}`))return;

      const saveBtn=document.querySelector("#saveMassGrades");
      const status=document.querySelector("#massGradeStatus");
      saveBtn.disabled=true;
      saveBtn.textContent="Saving grades…";

      const chatMessages=[];

      try{
        for(let i=0;i<changes.length;i++){
          const item=changes[i];
          const scored=item.choice==="td";
          const affected=entries.filter(e=>e.currentPick===item.player);
          const labels=affected.map(e=>e.label);
          const alreadyGraded=affected.some(e=>{
            const r=String(e.currentResult||"").trim();
            return r && r!=="Pending";
          });
          const eligibleBuybacks=!scored
            ? affected.filter(e=>!e.buybackUsed).length
            : 0;

          status.textContent=`Saving ${i+1}/${changes.length}: ${item.player}…`;

          await safeCommissionerPost("gradePlayer",{
            adminToken:ADMIN_TOKEN,
            playerName:item.player,
            scored
          });

          // Keep our local commissioner state coherent while we process the batch.
          affected.forEach(e=>e.currentResult=scored?"TD":"No TD");

          let message;
          if(alreadyGraded){
            message=[
              `🔄 WEEK ${state.league.week} RESULT UPDATED`,
              "",
              scored ? `✅ ${item.player} is now graded TD.` : `❌ ${item.player} is now graded NO TD.`,
              `${affected.length} play${affected.length===1?" was":"s were"} affected: ${labels.join(", ")}`
            ].join("\n");
          }else if(scored){
            message=[
              `✅ TOUCHDOWN — ${item.player}`,
              "",
              `${affected.length} play${affected.length===1?" survives":"s survive"}:`,
              labels.map(x=>"• "+x).join("\n")
            ].join("\n");
          }else{
            message=[
              `❌ NO TD — ${item.player}`,
              "",
              `${affected.length} play${affected.length===1?" is":"s are"} eliminated:`,
              labels.map(x=>"• "+x).join("\n"),
              eligibleBuybacks
                ? `\n♻️ ${eligibleBuybacks} of ${affected.length} ${eligibleBuybacks===1?"has":"have"} a buyback available for Week ${Number(state.league.week)+1}.`
                : ""
            ].filter(Boolean).join("\n");
          }
          chatMessages.push(message);

          // Tiny spacing between Apps Script writes avoids hammering the sheet.
          if(i<changes.length-1){
            await new Promise(r=>setTimeout(r,180));
          }
        }

        status.textContent="✅ Grades saved. Posting League Chat updates…";

        // Chat failures never undo grading.
        for(const message of chatMessages){
          try{
            await postSystemMessage(message);
          }catch(chatErr){
            console.warn("Mass-grade chat announcement failed",chatErr);
          }
        }

        saveBtn.textContent="✅ Saved";
        status.textContent=`✅ ${changes.length} player${changes.length===1?"":"s"} graded. Refreshing…`;
        setTimeout(()=>window.location.reload(),700);
      }catch(err){
        saveBtn.disabled=false;
        saveBtn.textContent="Save Selected Grades";
        status.textContent="";
        alert("Mass grading stopped after repeated connection attempts: "+err.message+"\n\nAny grades saved before this error may already be recorded. Refresh before retrying.");
      }
    };
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

  document.querySelector("#pushMissingAdmin").onclick=async()=>{
    const missing=(adminState.entries||[]).filter(e=>e.status==="alive"&&!e.currentPick);
    if(!missing.length){alert("Everyone who is alive has submitted a pick.");return;}
    const owners=new Set(missing.map(e=>String(e.ownerId))).size;
    if(!confirm(`Send a push reminder to ${owners} owner${owners===1?"":"s"} with missing picks?`))return;
    try{const r=await jsonp("pushMissingPicks",{adminToken:ADMIN_TOKEN});alert(`Reminder sent to ${r.sent||0} subscribed device${Number(r.sent||0)===1?"":"s"}.`);}catch(err){alert("Push reminder failed: "+err.message)}
  };
  document.querySelector("#pushAnnouncementAdmin").onclick=async()=>{
    const message=prompt("Push notification message:");if(!message)return;if(message.length>160){alert("Keep it to 160 characters or fewer.");return;}
    if(!confirm(`Send this to every subscribed owner?\\n\\n${message}`))return;
    try{const r=await jsonp("pushAnnouncement",{adminToken:ADMIN_TOKEN,message});alert(`Announcement sent to ${r.sent||0} subscribed device${Number(r.sent||0)===1?"":"s"}.`);}catch(err){alert("Push announcement failed: "+err.message)}
  };

  document.querySelector("#smartReminderAdmin").onclick=()=>{
    const enabled=String(adminState.league.smart_reminders_enabled||"FALSE").toUpperCase()==="TRUE";
    if(enabled){
      alert(
        "AUTO PICK REMINDERS ARE ON ✅\n\n"+
        "TD Survivor automatically checks for missing ALIVE picks every Thursday and sends only to owners who still owe a pick.\n\n"+
        "Reminder schedule:\n"+
        "• 12:00 PM ET on deadline day, when the deadline is later than noon\n"+
        "• About 1 hour before the deadline\n"+
        "• About 15 minutes before the deadline\n\n"+
        "For early kickoffs, the noon reminder is skipped automatically.\n\n"+
        "Owners who have submitted all active picks receive nothing.\n\n"+
        "Also automatic:\n"+
        "• Pick graded results\n"+
        "• Buyback available alerts\n"+
        "• New week opened alerts"
      );
    }else{
      alert(
        "AUTO PICK REMINDERS ARE OFF.\n\n"+
        "To turn them on, open Apps Script and run the installSmartReminders function once. Google may ask you to authorize scheduled triggers."
      );
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
  chat.style.cssText="position:fixed;top:0;left:0;right:0;bottom:64px;z-index:20;background:#060708;overflow:hidden;padding:calc(env(safe-area-inset-top) + 10px) 12px 0;box-sizing:border-box;";
  chat.innerHTML=`
    <div style="height:100%;max-width:680px;margin:0 auto;display:flex;flex-direction:column;min-height:0;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex:0 0 auto;padding:2px 2px 9px;">
        <div><div style="font-size:16px;font-weight:950;">💬 League Chat</div><div style="font-size:9px;color:#78879a;margin-top:2px;">TD Survivor • league room</div></div>
        <div id="chatLive" style="font-size:8px;color:#5be69d;font-weight:900;">● LIVE</div>
      </div>
      <div id="chatMessages" style="flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:2px 0 8px;"></div>
      <div style="flex:0 0 auto;background:#060708;padding:7px 0 6px;">
        <div style="display:flex;gap:7px;align-items:stretch;">
          <textarea id="chatInput" maxlength="500" rows="1" placeholder="Message the league…" style="flex:1;min-width:0;resize:none;background:#090b0e;color:#fff;border:1px solid #343941;border-radius:12px;padding:10px;font:inherit;max-height:72px;"></textarea>
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
    nav.style.setProperty("bottom","0","important");
    nav.style.transform="none";
    nav.style.insetInline="0";
    nav.style.boxSizing="border-box";
    nav.style.width="100vw";
    nav.style.maxWidth="100vw";
    nav.style.margin="0";
    nav.style.marginLeft="0";
    nav.style.marginRight="0";
    nav.style.zIndex="500";
    nav.style.background="#090b0d";
    nav.style.borderTop="1px solid #2b3036";
    nav.style.padding="4px 6px 0";
    nav.style.boxSizing="border-box";
    nav.style.height="64px";
    nav.style.minHeight="64px";
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
    box.innerHTML='<div style="padding:30px 10px;text-align:center;color:#8d96a0;font-size:10px;">No messages yet. Start the league chat.</div>';
    return;
  }

  box.innerHTML=chatMessages.map(m=>{
    const system=m.message_type!=="user";
    const mine=String(m.owner_name)===String(state.owner?.name||"");
    const t=new Date(m.created_at);
    const stamp=t.toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});

    const bg=system ? "#111317" : mine ? "#103225" : "#121417";
    const border=system ? "#3a3f46" : mine ? "#256648" : "#32363c";
    const meta=system ? "#ff7a1a" : mine ? "#65d69a" : "#9aa3ad";

    return `<div style="display:flex;justify-content:${mine&&!system?"flex-end":"flex-start"};margin:8px 0;">
      <div style="max-width:86%;padding:9px 10px;border-radius:13px;background:${bg};border:1px solid ${border};box-shadow:none;">
        <div style="font-size:8px;font-weight:900;color:${meta};margin-bottom:4px;">${system?"TD SURVIVOR":chatEsc(m.owner_name)} • ${stamp}</div>
        <div style="font-size:11px;line-height:1.4;white-space:pre-wrap;word-break:break-word;color:#f7f8fa;">${chatEsc(m.body)}</div>
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

  const confirmBtn=document.querySelector("#confirm");
  const weekAtSubmit=Number(state.league.week);

  try{
    // Give immediate feedback, but do NOT claim the pick is saved yet.
    confirmBtn.disabled=true;
    const originalConfirmText=confirmBtn.textContent;
    confirmBtn.textContent="Saving…";

    // The success message only appears after submitPick resolves successfully.
    // At that point the backend has acknowledged the save, so the owner can
    // safely leave/close the app without waiting for a full league refresh.
    await post("submitPick",{
      token:OWNER_TOKEN,
      entryId:e.id,
      playerId:chosenId,
      playerName:chosenName
    });

    // Once submitPick resolves, the backend save has been acknowledged.
    // From here on, client-side rendering/cache issues must NEVER be reported
    // as "Pick was not saved."
    try{
      const existing=e.picks.find(p=>Number(p.week)===weekAtSubmit);
      if(existing){
        existing.player=chosenName;
        existing.playerId=chosenId;
        existing.result=existing.result||"Pending";
      }else{
        e.picks.push({
          week:weekAtSubmit,
          player:chosenName,
          playerId:chosenId,
          result:"Pending"
        });
      }

      closeModal();
      cacheLiveState(state);
      render();
    }catch(uiErr){
      console.warn("Pick saved, but local UI update had an issue",uiErr);
      closeModal();
    }

    alert(`${e.label} Week ${weekAtSubmit} pick saved: ${chosenName}`);

    refreshLive().catch(err=>{
      console.warn("Background refresh after pick save failed",err);
    });

    confirmBtn.textContent=originalConfirmText;
  }catch(err){
    // This catch now only represents an actual submitPick/backend failure.
    confirmBtn.disabled=false;
    confirmBtn.textContent="Confirm Pick";
    alert(`Pick was not saved. ${err.message}`);
  }
};


document.querySelector("#profileBtn").onclick=()=>{
  if(state.mode==="live"){
    alert(`Signed in as ${state.owner.name}\n${state.entries.length} play(s) on this account.`);
  }else{
    alert("Demo mode. Once you open a private owner invite link, this becomes a live account connected to Google Sheets.");
  }
};


function renderLeagueJoin(){
  document.querySelector(".app")?.classList.add("hidden");

  const wrap=document.createElement("div");
  wrap.id="tdJoinScreen";
  wrap.style.cssText=[
    "position:fixed","inset:0","z-index:10000","overflow:auto",
    "background:radial-gradient(circle at 50% -10%,rgba(255,90,0,.14),transparent 28%),linear-gradient(180deg,#050607,#090b0e)",
    "color:#f7f8fa","padding:calc(env(safe-area-inset-top) + 28px) 18px calc(env(safe-area-inset-bottom) + 28px)",
    "box-sizing:border-box"
  ].join(";");

  wrap.innerHTML=`
    <div style="max-width:460px;margin:0 auto;">
      <div style="font-size:8px;font-weight:950;letter-spacing:1.4px;color:#ff7a1a;">2026 NFL • PRIVATE LEAGUE</div>
      <div style="font-size:28px;font-weight:950;letter-spacing:-1px;margin-top:4px;">TD SURVIVOR</div>

      <div style="margin-top:24px;padding:18px;border:1px solid #a83d00;border-radius:16px;background:linear-gradient(180deg,#101317,#0c0e11);">
        <div style="font-size:9px;color:#ff7a1a;font-weight:950;letter-spacing:1px;">JOIN THE LEAGUE</div>
        <div style="font-size:20px;font-weight:950;margin-top:5px;">Create your entry</div>
        <div style="font-size:9px;color:#9aa3ad;line-height:1.5;margin-top:6px;">
          Enter your name and choose how many plays you want. Each play is a separate chance to survive.
        </div>

        <label style="display:block;margin-top:16px;font-size:8px;color:#9aa3ad;font-weight:900;">NAME OR USERNAME</label>
        <input id="joinName" autocomplete="name" maxlength="40" placeholder="Name or username"
          style="width:100%;box-sizing:border-box;margin-top:6px;background:#090b0e;color:#fff;border:1px solid #343941;border-radius:11px;padding:12px;">

        <label style="display:block;margin-top:14px;font-size:8px;color:#9aa3ad;font-weight:900;">NUMBER OF PLAYS</label>
        <div id="joinPlayChoices" style="display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-top:7px;">
          ${[1,2,3,4,5].map(n=>`<button type="button" data-join-plays="${n}" class="filter ${n===1?"active":""}"
            style="padding:11px 0;">${n}</button>`).join("")}
        </div>
        <div style="font-size:7.5px;color:#7f8994;margin-top:6px;">Maximum 5 plays per person.</div>

        <div id="joinCostSummary"
          style="margin-top:12px;padding:10px;border:1px solid #343941;border-radius:10px;background:#090b0e;">
          <div style="font-size:9px;font-weight:950;color:#f7f8fa;">1 play × $20 = $20 due</div>
          <div style="font-size:7.5px;color:#9aa3ad;line-height:1.45;margin-top:4px;">
            Each play is $20. If a play is eliminated, you may later use a one-time $10 buyback for that play.
          </div>
        </div>

        <button id="joinLeagueSubmit" class="primary" style="width:100%;margin-top:18px;padding:12px;">Join TD Survivor</button>
        <div id="joinLeagueStatus" style="font-size:8px;color:#8f99a4;line-height:1.4;margin-top:8px;"></div>
      </div>
    </div>`;

  document.body.appendChild(wrap);

  let plays=1;

  function updateJoinCost(){
    const total=plays*20;
    const summary=document.querySelector("#joinCostSummary");
    if(!summary)return;
    summary.innerHTML=`
      <div style="font-size:9px;font-weight:950;color:#f7f8fa;">${plays} play${plays===1?"":"s"} × $20 = $${total} due</div>
      <div style="font-size:7.5px;color:#9aa3ad;line-height:1.45;margin-top:4px;">
        Each play is $20. If a play is eliminated, you may later use a one-time $10 buyback for that play.
      </div>`;
  }

  wrap.querySelectorAll("[data-join-plays]").forEach(btn=>{
    btn.onclick=()=>{
      plays=Number(btn.dataset.joinPlays);
      wrap.querySelectorAll("[data-join-plays]").forEach(b=>b.classList.toggle("active",b===btn));
      updateJoinCost();
    };
  });

  document.querySelector("#joinLeagueSubmit").onclick=async()=>{
    const name=document.querySelector("#joinName").value.trim();
    const btn=document.querySelector("#joinLeagueSubmit");
    const status=document.querySelector("#joinLeagueStatus");

    if(name.length<2){
      alert("Enter your name first.");
      return;
    }

    btn.disabled=true;
    btn.textContent="Joining…";
    status.textContent="Creating your TD Survivor account…";

    try{
      const data=await jsonp("joinLeague",{
        inviteToken:JOIN_TOKEN,
        name,
        plays
      });

      if(!data?.ownerToken)throw new Error("Your owner login was not returned.");

      localStorage.setItem("td_owner_token",data.ownerToken);
      status.textContent=`✅ You're in with ${data.plays} play${data.plays===1?"":"s"}. Opening your account…`;

      const u=new URL(baseInviteUrl());
      u.searchParams.set("token",data.ownerToken);
      u.searchParams.set("welcome","1");
      u.searchParams.set("plays",String(data.plays||plays));
      setTimeout(()=>window.location.replace(u.toString()),500);
    }catch(err){
      btn.disabled=false;
      btn.textContent="Join TD Survivor";
      status.textContent="";
      alert("Could not join the league: "+err.message);
    }
  };
}


function tdDeviceFamily(){
  const ua=navigator.userAgent||"";
  const isiOS=/iPhone|iPad|iPod/i.test(ua);
  const isAndroid=/Android/i.test(ua);
  const isSafari=isiOS && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  return {isiOS,isAndroid,isSafari};
}

function tdIsStandalone(){
  return Boolean(
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.navigator.standalone===true
  );
}

function renderPostJoinOnboarding(){
  document.querySelector(".app")?.classList.add("hidden");

  const {isiOS,isAndroid,isSafari}=tdDeviceFamily();
  const installed=tdIsStandalone();
  const total=WELCOME_PLAYS*20;

  const steps=installed
    ? `
      <div style="padding:12px;border:1px solid #256648;border-radius:12px;background:#0d2118;">
        <div style="font-size:11px;font-weight:950;color:#31d07c;">✅ TD Survivor is already on your Home Screen</div>
        <div style="font-size:8px;color:#a4b2aa;line-height:1.45;margin-top:4px;">You're all set. Tap Continue to open your account.</div>
      </div>`
    : isiOS
      ? `
        ${!isSafari?`
        <div style="padding:10px;border:1px solid #8a6a11;border-radius:10px;background:#211a09;margin-bottom:10px;">
          <div style="font-size:8px;font-weight:950;color:#f5c542;">📱 iPhone tip</div>
          <div style="font-size:8px;color:#d6c995;line-height:1.45;margin-top:3px;">For the full app-style Home Screen install, open this page in Safari first.</div>
        </div>`:""}
        <div style="display:grid;gap:8px;">
          <div style="padding:10px;border:1px solid #343941;border-radius:10px;background:#0b0d10;">
            <div style="font-size:8px;color:#ff7a1a;font-weight:950;">1 • TAP SHARE</div>
            <div style="font-size:8px;color:#aab3bd;line-height:1.4;margin-top:3px;">In Safari, tap the Share button <b style="color:#fff;">□↑</b>.</div>
          </div>
          <div style="padding:10px;border:1px solid #343941;border-radius:10px;background:#0b0d10;">
            <div style="font-size:8px;color:#ff7a1a;font-weight:950;">2 • ADD TO HOME SCREEN</div>
            <div style="font-size:8px;color:#aab3bd;line-height:1.4;margin-top:3px;">Scroll down and tap <b style="color:#fff;">Add to Home Screen</b>.</div>
          </div>
          <div style="padding:10px;border:1px solid #343941;border-radius:10px;background:#0b0d10;">
            <div style="font-size:8px;color:#ff7a1a;font-weight:950;">3 • OPEN AS WEB APP + ADD</div>
            <div style="font-size:8px;color:#aab3bd;line-height:1.4;margin-top:3px;">Turn on <b style="color:#fff;">Open as Web App</b> if shown, then tap <b style="color:#fff;">Add</b>.</div>
          </div>
        </div>`
      : isAndroid
        ? `
        <div style="display:grid;gap:8px;">
          <div style="padding:10px;border:1px solid #343941;border-radius:10px;background:#0b0d10;">
            <div style="font-size:8px;color:#ff7a1a;font-weight:950;">1 • OPEN CHROME MENU</div>
            <div style="font-size:8px;color:#aab3bd;line-height:1.4;margin-top:3px;">Tap the <b style="color:#fff;">⋮</b> menu in Chrome.</div>
          </div>
          <div style="padding:10px;border:1px solid #343941;border-radius:10px;background:#0b0d10;">
            <div style="font-size:8px;color:#ff7a1a;font-weight:950;">2 • INSTALL / ADD TO HOME SCREEN</div>
            <div style="font-size:8px;color:#aab3bd;line-height:1.4;margin-top:3px;">Tap <b style="color:#fff;">Install app</b> or <b style="color:#fff;">Add to Home screen</b>.</div>
          </div>
          <div style="padding:10px;border:1px solid #343941;border-radius:10px;background:#0b0d10;">
            <div style="font-size:8px;color:#ff7a1a;font-weight:950;">3 • CONFIRM</div>
            <div style="font-size:8px;color:#aab3bd;line-height:1.4;margin-top:3px;">Follow the install prompt. TD Survivor will appear on your Home Screen like an app.</div>
          </div>
        </div>`
        : `
        <div style="padding:12px;border:1px solid #343941;border-radius:12px;background:#0b0d10;">
          <div style="font-size:9px;font-weight:950;color:#ff7a1a;">SAVE TD SURVIVOR</div>
          <div style="font-size:8px;color:#aab3bd;line-height:1.5;margin-top:4px;">Use your browser's Install App or Add to Home Screen option to save TD Survivor as an app-style shortcut.</div>
        </div>`;

  const wrap=document.createElement("div");
  wrap.id="tdPostJoinOnboarding";
  wrap.style.cssText=[
    "position:fixed","inset:0","z-index:10000","overflow:auto",
    "background:radial-gradient(circle at 50% -10%,rgba(255,90,0,.14),transparent 28%),linear-gradient(180deg,#050607,#090b0e)",
    "color:#f7f8fa","padding:calc(env(safe-area-inset-top) + 24px) 18px calc(env(safe-area-inset-bottom) + 28px)",
    "box-sizing:border-box"
  ].join(";");

  wrap.innerHTML=`
    <div style="max-width:460px;margin:0 auto;">
      <div style="font-size:8px;font-weight:950;letter-spacing:1.4px;color:#ff7a1a;">2026 NFL • PRIVATE LEAGUE</div>
      <div style="font-size:28px;font-weight:950;letter-spacing:-1px;margin-top:4px;">TD SURVIVOR</div>

      <div style="margin-top:22px;padding:18px;border:1px solid #256648;border-radius:16px;background:linear-gradient(180deg,#0f1713,#0c0f0d);">
        <div style="font-size:9px;color:#31d07c;font-weight:950;letter-spacing:1px;">YOU'RE IN 🎉</div>
        <div style="font-size:21px;font-weight:950;margin-top:5px;">${WELCOME_PLAYS} play${WELCOME_PLAYS===1?"":"s"} created</div>
        <div style="font-size:9px;color:#a5b0aa;line-height:1.5;margin-top:6px;">
          Your TD Survivor account is ready.
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">
          <div style="padding:10px;border:1px solid #2f3833;border-radius:10px;background:#0a0d0b;">
            <div style="font-size:7.5px;color:#8f9993;">ENTRY TOTAL</div>
            <div style="font-size:15px;font-weight:950;margin-top:2px;">$${total}</div>
          </div>
          <div style="padding:10px;border:1px solid #2f3833;border-radius:10px;background:#0a0d0b;">
            <div style="font-size:7.5px;color:#8f9993;">BUYBACK</div>
            <div style="font-size:10px;font-weight:950;color:#f5c542;margin-top:4px;">$10 OPTIONAL</div>
          </div>
        </div>

        <div style="font-size:7.5px;color:#8f9993;line-height:1.45;margin-top:8px;">
          Each play is $20. If a play is eliminated, that play may use one one-time $10 buyback when eligible.
        </div>
      </div>

      <div style="margin-top:14px;padding:18px;border:1px solid #a83d00;border-radius:16px;background:linear-gradient(180deg,#101317,#0c0e11);">
        <div style="font-size:9px;color:#ff7a1a;font-weight:950;letter-spacing:1px;">SAVE THE APP</div>
        <div style="font-size:18px;font-weight:950;line-height:1.15;margin-top:5px;">Here is how to save TD Survivor to your Home Screen as a functional app</div>
        <div style="font-size:8px;color:#9aa3ad;line-height:1.5;margin:7px 0 12px;">
          Do this once and you can open TD Survivor directly from your phone without hunting for the link each week.
        </div>

        ${steps}
      </div>

      <div style="margin-top:14px;padding:14px;border:1px solid #343941;border-radius:14px;background:#0c0e11;">
        <div style="font-size:9px;font-weight:950;color:#fff;">Your weekly job is simple</div>
        <div style="font-size:8px;color:#aab3bd;line-height:1.65;margin-top:6px;">
          🏈 Make one TD scorer pick for each active play.<br>
          ⏰ Submit before the weekly deadline.<br>
          🚫 Once you use a player for a play, that play cannot use them again.<br>
          💬 Check League Chat for locks, results, buybacks and weekly updates.
        </div>
      </div>

      <button id="finishTDOnboarding" class="primary"
        style="width:100%;margin-top:14px;padding:13px;background:#ff5a00!important;border-color:#ff5a00!important;">
        Continue to TD Survivor
      </button>
    </div>`;

  document.body.appendChild(wrap);

  document.querySelector("#finishTDOnboarding").onclick=()=>{
    const u=new URL(window.location.href);
    u.searchParams.delete("welcome");
    u.searchParams.delete("plays");
    window.location.replace(u.toString());
  };
}


(function installV10156StatStyles(){
  const s=document.createElement("style");
  s.id="v10156-dashboard-stats";
  s.textContent=`
    #aliveCount,#pot,#myStatus,#tdBuybackValue{
      font-size:12px!important;
      font-weight:950!important;
      line-height:1.05!important;
      letter-spacing:-.55px!important;
      white-space:nowrap!important;
    }
    #tdBuybackValue{
      font-size:12px!important;
      letter-spacing:-1px!important;
      font-family:"Arial Narrow","Roboto Condensed","Helvetica Neue Condensed",Inter,system-ui,sans-serif!important;
    }
  `;
  document.head.appendChild(s);
})();

(async function startTDApp(){
  if(JOIN_TOKEN){
    renderLeagueJoin();
    return;
  }

  if(WELCOME_MODE && OWNER_TOKEN){
    renderPostJoinOnboarding();
    return;
  }

  await retireOldServiceWorkers();
  startUpdateChecks();

  // If a live state is cached, paint it immediately.
  const cached=(API_URL && !API_URL.includes("PASTE_") && OWNER_TOKEN)
    ? loadCachedLiveState()
    : null;

  if(cached){
    state=cached;
    state.mode="live";
    render();
    showSyncStatus("Updating…","loading");
  }

  // Player data and Google Apps Script refresh now happen in parallel.
  const playerPoolPromise=loadPlayerPool()
    .then(()=>{
      if(state)render();
    })
    .catch(err=>console.warn("Player pool startup failed",err));

  const statePromise=loadState();

  await Promise.allSettled([playerPoolPromise,statePromise]);
  await renderNotificationCard();
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


setInterval(()=>{if(document.querySelector("#nflShadowHero"))loadNFLShadowHero();},60000);
