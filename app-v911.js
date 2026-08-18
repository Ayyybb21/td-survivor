
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
  return status==="alive" ? "ALIVE" : "OUT";
}
function statusClass(status){
  return status==="alive" ? "alive" : "out";
}
function buybackLabel(entry){
  return entry.buybackUsed ? "Buyback Used" : "Buyback Available";
}
function buybackBadge(entry){
  const used=entry.buybackUsed;
  const bg=used?"#202838":"#4a3914";
  const fg=used?"#aab5c5":"#f7c66a";
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
      <button id="weekAdmin">📅 Set Week</button>
      <button id="gradeAdmin">🏈 Grade Player</button>
      <button id="overrideAdmin">🛠 Override Entry</button>
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
      <button class="mini-btn ${e.buybackUsed?"bad":""}" data-buy="${e.id}">${e.buybackUsed?"Undo Buyback":"Buyback"}</button>
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
  document.querySelector("#weekAdmin").onclick=async()=>{
    const w=Number(prompt("Set current week:",state.league.week));if(!w)return;
    const deadline=prompt("Deadline label:",state.league.deadline)||state.league.deadline;
    try{await adminPost("setWeek",{week:w,deadlineLabel:deadline})}catch(err){alert(err.message)}
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
