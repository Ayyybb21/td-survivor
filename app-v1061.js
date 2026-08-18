
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
  adminState = await jsonp("adminState",{adminToken:ADMIN_TOKEN});
  return adminState;
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

const TD_APP_VERSION="10.6.1";
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
    localStorage.setItem("td_last_seen_version",String(nextVersion));
    const u=new URL(window.location.href);
    u.searchParams.set("_update",Date.now());
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
  checkForAppUpdate();
  clearInterval(updateCheckTimer);
  updateCheckTimer=setInterval(checkForAppUpdate,5*60*1000);
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
    Object.entries(extra).forEach(([k,v])=>u.searchParams.set(k,v));

    script.src = u.toString();
    script.onerror=()=>{cleanup();reject(new Error("Could not reach the backend."));};
    document.body.appendChild(script);

    const timer=setTimeout(()=>{cleanup();reject(new Error("Backend request timed out."));},12000);
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

async function refreshLive(){
  state = await jsonp("bootstrap",{token:OWNER_TOKEN});
  state.mode="live";
  render();
}

async function loadState(){
  if(API_URL && !API_URL.includes("PASTE_") && OWNER_TOKEN){
    try{
      await refreshLive();
      return;
    }catch(err){
      console.error(err);
      alert("The live league could not load: " + err.message + "\n\nThe app will open in demo mode for now.");
    }
  }
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
    const canBuyback=!e.buybackUsed;
    wrap.insertAdjacentHTML("beforeend",`
      <div style="padding:14px;border:1px solid #4a2d33;border-radius:14px;background:#1b1115;margin-bottom:12px;">
        <div style="font-size:12px;font-weight:900;color:#ff8993;">This play is eliminated</div>
        <div style="font-size:10px;color:#aeb8c6;line-height:1.45;margin-top:5px;">
          ${canBuyback
            ? `This play is OUT, but the one-time $${state.league.buybackFee} buyback is still available.`
            : `This play is OUT and its buyback has already been used.`}
        </div>
      </div>
    `);
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
        <div class="row">
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
    reveal ? `WEEK ${state.league.week} PICKS • LOCKED` : `${state.totalEntries} plays • picks hidden`;
}

function renderHistory(){
  const e=activeEntry();
  const el=document.querySelector("#history");
  el.innerHTML="";
  if(!(e.picks||[]).length){
    el.innerHTML='<div class="muted">No picks submitted yet for this play.</div>';
    return;
  }
  [...e.picks].sort((a,b)=>Number(a.week)-Number(b.week)).forEach(p=>{
    el.insertAdjacentHTML("beforeend",`
      <div class="row">
        <span class="week">WEEK ${p.week}</span>
        <span class="pick">${p.player}</span>
        <span class="rstatus">${p.result||"Pending"}</span>
      </div>`);
  });
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
        ADMIN_TOKEN="";localStorage.removeItem("td_admin_token");alert(err.message);renderAdmin();
      }
    };
    return;
  }
  if(!adminState){
    view.innerHTML=`<div class="panel-head"><div><div class="eyebrow">COMMISSIONER</div><h3>Control center</h3></div></div><div class="muted">Loading commissioner data…</div>`;
    loadAdminState().then(renderAdmin).catch(err=>{
      alert("Commissioner access failed: "+err.message);
      ADMIN_TOKEN="";localStorage.removeItem("td_admin_token");renderAdmin();
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

    adminState.league.week_locked=next?"TRUE":"FALSE";
    state.league.locked=next;

    // Immediate visual response.
    renderAdmin();
    renderHeader();

    syncAdminInBackground("lockWeek",{locked:next},()=>{
      adminState.league.week_locked=previous?"TRUE":"FALSE";
      state.league.locked=previous;
    });
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
    const buybackDecisions=entries.filter(e=>e.status==="out" && !e.buybackUsed);

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
      message+=`\n\n⚠️ ${buybackDecisions.length} OUT play${buybackDecisions.length===1?" has":"s have"} Buyback Available. They can still be bought back after the rollover.`;
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

      btn.textContent=`✅ Week ${nextWeek} ready — updating…`;
      setTimeout(()=>window.location.reload(),1800);
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
        await post("gradePlayer",{adminToken:ADMIN_TOKEN,playerName:player,scored});
        usage.textContent="✅ Saved. Updating results…";

        // Keep the reliable V9.5 auto-refresh behavior.
        setTimeout(()=>window.location.reload(),1800);
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

document.querySelectorAll(".navbtn").forEach(b=>{
  b.onclick=async()=>{
    document.querySelectorAll(".navbtn").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    ["pickView","standingsView","historyView","adminView"].forEach(id=>{
      document.querySelector("#"+id).classList.toggle("hidden",id!==b.dataset.view);
    });
    if(b.dataset.view==="adminView" && ADMIN_TOKEN){
      try{await loadAdminState();renderAdmin()}catch(err){console.error(err)}
    }
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
})();

// Tiny build/version indicator for troubleshooting and update verification.
(function renderVersionBadge(){
  const badge=document.createElement("div");
  badge.id="tdVersionBadge";
  badge.textContent="v"+TD_APP_VERSION;
  badge.style.cssText=[
    "position:fixed",
    "right:8px",
    "bottom:74px",
    "z-index:90",
    "font-size:8px",
    "font-weight:700",
    "letter-spacing:.35px",
    "color:#66758a",
    "background:rgba(7,17,31,.72)",
    "border:1px solid rgba(70,88,112,.35)",
    "border-radius:999px",
    "padding:3px 6px",
    "pointer-events:none",
    "user-select:none"
  ].join(";");
  document.body.appendChild(badge);
})();

