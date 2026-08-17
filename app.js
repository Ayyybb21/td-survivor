

// TD Survivor V6 — iOS Home Screen authentication fix
// Replace the beginning of app.js with this auth bootstrap section,
// then keep the rest of the V5 application code unchanged.
//
// This version stores the owner token in BOTH localStorage and a first-party
// cookie. iOS copies cookies into a newly-created Home Screen web app, while
// it does not copy localStorage.

const API_URL = (window.TD_CONFIG?.API_URL || "").trim();

const params = new URLSearchParams(window.location.search);
const URL_TOKEN = params.get("token") || "";

function readCookie(name) {
  const prefix = name + "=";
  const parts = document.cookie.split(";").map(v => v.trim());
  const found = parts.find(v => v.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : "";
}

function writeOwnerToken(token) {
  if (!token) return;

  // Browser storage is useful for normal Safari/browser use.
  localStorage.setItem("td_owner_token", token);

  // Cookie is the important piece for iPhone/iPad "Add to Home Screen".
  // Safari/WebKit copies first-party cookies into the newly-created web app.
  document.cookie =
    "td_owner_token=" + encodeURIComponent(token) +
    "; Max-Age=31536000; Path=/; Secure; SameSite=Lax";
}

if (URL_TOKEN) {
  writeOwnerToken(URL_TOKEN);
}

const OWNER_TOKEN =
  URL_TOKEN ||
  readCookie("td_owner_token") ||
  localStorage.getItem("td_owner_token") ||
  "";

// Once the token is safely stored, remove it from the visible URL.
// This avoids leaving the private account token sitting in screenshots/history.
if (URL_TOKEN && window.history && history.replaceState) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("token");
  history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
}


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

function renderStandings(){
  const el=document.querySelector("#standings");
  el.innerHTML="";
  [...state.standings]
    .sort((a,b)=>a.status.localeCompare(b.status)||a.label.localeCompare(b.label))
    .forEach((e,i)=>{
      el.insertAdjacentHTML("beforeend",`
        <div class="row">
          <div class="rank">${i+1}</div>
          <div class="rname">${e.label}</div>
          <div class="rstatus ${e.status==="alive"?"alive":"out"}">${e.status==="alive"?"ALIVE":"OUT"}</div>
        </div>`);
    });
  document.querySelector("#standingsMeta").textContent=state.totalEntries+" plays • "+state.totalOwners+" owners";
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
  document.querySelector("#adminEntries").textContent=state.totalEntries;
  document.querySelector("#adminAlive").textContent=state.aliveEntries;
  document.querySelector("#adminBuybacks").textContent=state.standings.filter(e=>e.buybackUsed).length;
  document.querySelector("#adminPot").textContent="$"+state.league.projectedPot;
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
  b.onclick=()=>{
    document.querySelectorAll(".navbtn").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    ["pickView","standingsView","historyView","adminView"].forEach(id=>{
      document.querySelector("#"+id).classList.toggle("hidden",id!==b.dataset.view);
    });
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

document.querySelector("#lockBtn").onclick=()=>alert("Commissioner controls will be connected with the private admin link next.");
document.querySelector("#announcementBtn").onclick=()=>alert("The announcement generator will be connected to the commissioner dashboard next.");
document.querySelector("#buybackBtn").onclick=()=>alert("Buybacks will be controlled from the commissioner dashboard.");

document.querySelector("#profileBtn").onclick=()=>{
  if(state.mode==="live"){
    alert(`Signed in as ${state.owner.name}\n${state.entries.length} play(s) on this account.`);
  }else{
    alert("Demo mode. Once you open a private owner invite link, this becomes a live account connected to Google Sheets.");
  }
};

loadState();
