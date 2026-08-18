
const API_URL = (window.TD_CONFIG?.API_URL || "").trim();
const params = new URLSearchParams(window.location.search);
const URL_TOKEN = params.get("token");
if (URL_TOKEN) localStorage.setItem("td_owner_token", URL_TOKEN);
const OWNER_TOKEN = URL_TOKEN || localStorage.getItem("td_owner_token") || "";

const PLAYERS = [
["derrick-henry","Derrick Henry","BAL","RB"],["saquon-barkley","Saquon Barkley","PHI","RB"],
["bijan-robinson","Bijan Robinson","ATL","RB"],["jonathan-taylor","Jonathan Taylor","IND","RB"],
["josh-jacobs","Josh Jacobs","GB","RB"],["jahmyr-gibbs","Jahmyr Gibbs","DET","RB"],
["jaxon-smith-njigba","Jaxon Smith-Njigba","SEA","WR"],["jamarr-chase","Ja'Marr Chase","CIN","WR"],
["justin-jefferson","Justin Jefferson","MIN","WR"],["ceedee-lamb","CeeDee Lamb","DAL","WR"],
["amon-ra-st-brown","Amon-Ra St. Brown","DET","WR"],["puka-nacua","Puka Nacua","LAR","WR"],
["trey-mcbride","Trey McBride","ARI","TE"],["george-kittle","George Kittle","SF","TE"],
["sam-laporta","Sam LaPorta","DET","TE"],["lamar-jackson","Lamar Jackson","BAL","QB"],
["josh-allen","Josh Allen","BUF","QB"]
];

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
  await loadAdminState();

  if(action==="lockWeek") state.league.locked=Boolean(body.locked);
  if(action==="setWeek"){
    state.league.week=Number(body.week);
    if(body.deadlineLabel) state.league.deadline=body.deadlineLabel;
    state.league.locked=false;
  }

  renderAdmin();
  renderHeader();
}

// V8.2: optimistic admin actions.
// The screen updates FIRST, then Google Sheets syncs in the background.
function syncAdminInBackground(action, body, rollback){
  post(action,{adminToken:ADMIN_TOKEN,...body})
    .then(()=>loadAdminState())
    .then(()=>{
      // Reconcile with the real backend once it catches up.
      renderAdmin();
      renderHeader();
    })
    .catch(err=>{
      if(typeof rollback==="function") rollback();
      renderAdmin();
      renderHeader();
      alert("The change could not be saved: "+err.message);
    });
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
  return new Set((entry.picks||[]).map(p=>p.playerId || slug(p.player)));
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
  document.querySelector("#myStatus").textContent=
    e.status==="alive"?"Alive":e.status==="buyback_needed"?"Buyback":"Out";
  document.querySelector("#pickStatus").textContent=state.league.locked?"LOCKED":"OPEN";
  document.querySelector("#pickStatus").style.color=state.league.locked?"#ff8993":"#5be69d";
  document.querySelector("#myStatus").style.color=
    e.status==="alive"?"#5be69d":e.status==="buyback_needed"?"#f7c66a":"#ff8993";
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
  const q=document.querySelector("#search").value.toLowerCase();
  const pos=document.querySelector(".filter.active[data-pos]")?.dataset.pos || "ALL";
  const wrap=document.querySelector("#players");
  wrap.innerHTML="";

  PLAYERS.filter(p=>(pos==="ALL"||p[3]===pos)&&p[1].toLowerCase().includes(q)).forEach(([id,name,team,position])=>{
    const currentPick=(e.picks||[]).find(x=>Number(x.week)===Number(state.league.week));
    const current=currentPick && (currentPick.playerId===id || slug(currentPick.player)===id);
    const prior=used.has(id);
    const disabled=(prior&&!current)||state.league.locked||e.status!=="alive";
    const initials=name.split(" ").map(x=>x[0]).slice(0,2).join("");

    wrap.insertAdjacentHTML("beforeend",`
      <div class="player ${prior&&!current?"disabled":""}">
        <div class="avatar">${initials}</div>
        <div class="pinfo">
          <div class="pname">${name}</div>
          <div class="meta">${team} • ${position} ${current?"• Current pick":prior?"• Already used":""}</div>
        </div>
        <button class="select" ${disabled?"disabled":""} data-id="${id}" data-name="${name}">
          ${current?"Selected":state.league.locked?"Locked":prior?"Used":"Select"}
        </button>
      </div>`);
  });

  document.querySelectorAll(".select:not([disabled])").forEach(b=>{
    b.onclick=()=>openModal(b.dataset.id,b.dataset.name);
  });
}

function statusLabel(status){
  if(status==="alive") return "ALIVE";
  if(status==="buyback_needed") return "BUYBACK";
  return "OUT";
}
function statusClass(status){
  if(status==="alive") return "alive";
  if(status==="buyback_needed") return "";
  return "out";
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
      const order={alive:0,buyback_needed:1,out:2};
      return (order[a.status]??9)-(order[b.status]??9)||a.label.localeCompare(b.label);
    })
    .forEach((e,i)=>{
      const pickLine=reveal
        ? `<div class="meta">${e.currentPick||"No pick submitted"}${e.currentPick ? " • "+resultLabel(e.currentResult) : ""}</div>`
        : `<div class="meta">Pick hidden until lock</div>`;
      const color=e.status==="buyback_needed" ? 'style="color:#f7c66a"' : "";
      el.insertAdjacentHTML("beforeend",`
        <div class="row">
          <div class="rank">${i+1}</div>
          <div class="rname">${e.label}${pickLine}</div>
          <div class="rstatus ${statusClass(e.status)}" ${color}>${statusLabel(e.status)}</div>
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
      <button id="weekAdmin">📅 Set Week</button>
      <button id="gradeAdmin">🏈 Grade Player</button>
      <button id="announceAdmin">📣 Announcement</button>
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
      <button class="mini-btn" data-buy="${e.id}" ${e.buybackUsed?"disabled":""}>Buyback</button>
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
  document.querySelectorAll("[data-buy]").forEach(b=>b.onclick=()=>{
    const e=adminState.entries.find(x=>x.id===b.dataset.buy);
    if(!e)return;
    if(!confirm(`Use the one-time $${state.league.buybackFee} buyback for ${e.label}?`))return;
    const paid=confirm("Has the $10 buyback been paid?");

    const prevStatus=e.status, prevUsed=e.buybackUsed, prevPaid=e.buybackPaid;
    e.status="alive"; e.buybackUsed=true; e.buybackPaid=paid;

    renderAdmin();

    syncAdminInBackground("buyback",{entryId:e.id,buybackPaid:paid},()=>{
      e.status=prevStatus; e.buybackUsed=prevUsed; e.buybackPaid=prevPaid;
    });
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
  document.querySelector("#weekAdmin").onclick=async()=>{
    const w=Number(prompt("Set current week:",state.league.week));if(!w)return;
    const deadline=prompt("Deadline label:",state.league.deadline)||state.league.deadline;
    try{await adminPost("setWeek",{week:w,deadlineLabel:deadline})}catch(err){alert(err.message)}
  };
  document.querySelector("#gradeAdmin").onclick=async()=>{
    const player=prompt("Player name to grade exactly as shown in picks (example: Derrick Henry):");if(!player)return;
    const scored=confirm(`Did ${player} score a rushing or receiving TD?

OK = TD
Cancel = No TD`);
    try{await adminPost("gradePlayer",{playerName:player,scored})}catch(err){alert(err.message)}
  };
  document.querySelector("#announceAdmin").onclick=()=>{
    const sorted=entries.filter(e=>e.currentPick).sort((a,b)=>a.label.localeCompare(b.label));
    const text=`🏈 TD SURVIVOR — WEEK ${state.league.week}\n\n🔒 PICKS ${locked?"LOCKED":"OPEN"}\n\n`+
      sorted.map(e=>`${e.label} — ${e.currentPick}`).join("\n")+
      `\n\n${alive} plays alive • $${projected} pot\n\nGood luck! 🫡`;
    navigator.clipboard?.writeText(text);
    document.querySelector("#adminMessage").innerHTML=`<div class="copybox">${text.replaceAll("\n","<br>")}</div><div class="admin-note">Copied to clipboard.</div>`;
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

document.querySelector("#search").oninput=renderPlayers;

document.querySelectorAll(".filter[data-pos]").forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll(".filter[data-pos]").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
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

  if(state.mode!=="live"){
    const existing=e.picks.find(p=>Number(p.week)===Number(state.league.week));
    if(existing){
      existing.player=selectedPlayer.name;
      existing.playerId=selectedPlayer.id;
    }else{
      e.picks.push({week:state.league.week,player:selectedPlayer.name,playerId:selectedPlayer.id,result:"Pending"});
    }
    closeModal();
    render();
    alert(`Demo pick: ${e.label} → ${selectedPlayer.name}`);
    return;
  }

  try{
    document.querySelector("#confirm").disabled=true;
    await post("submitPick",{
      token:OWNER_TOKEN,
      entryId:e.id,
      playerId:selectedPlayer.id,
      playerName:selectedPlayer.name
    });

    closeModal();
    await new Promise(r=>setTimeout(r,1000));
    await refreshLive();
    alert(`${e.label} Week ${state.league.week} pick saved: ${selectedPlayer.name}`);
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

loadState();
