
const OWNERS = [
  "bb","Tay","Eddie","Brendan","Johnny","Jack","Timmy","Theresa","Ash","Rick",
  "Drew","Byrne","Mac","Ed","Vincie","Big Vince","Dane","Gilchrist","Joe","Logan","Gabe","Vinny"
];

const PLAYERS = [
["Derrick Henry","BAL","RB"],["Saquon Barkley","PHI","RB"],["Bijan Robinson","ATL","RB"],["Jonathan Taylor","IND","RB"],
["Josh Jacobs","GB","RB"],["Jahmyr Gibbs","DET","RB"],["Jaxon Smith-Njigba","SEA","WR"],["Ja'Marr Chase","CIN","WR"],
["Justin Jefferson","MIN","WR"],["CeeDee Lamb","DAL","WR"],["Amon-Ra St. Brown","DET","WR"],["Puka Nacua","LAR","WR"],
["Trey McBride","ARI","TE"],["George Kittle","SF","TE"],["Sam LaPorta","DET","TE"],["Lamar Jackson","BAL","QB"],["Josh Allen","BUF","QB"]
];

function freshState(){
  const owners = OWNERS.map((name,i)=>({id:"o"+(i+1), name}));
  const entries = owners.map((o,i)=>({
    id:"e"+(i+1), ownerId:o.id, label:o.name, status:"alive", buybackUsed:false,
    paid:false, picks:[]
  }));
  return {
    league:{name:"TD Survivor 2026",week:1,entryFee:20,buybackFee:10,deadline:"Thu • 8:15 PM ET",locked:false},
    owners, entries, activeOwnerId:owners[0].id, activeEntryId:entries[0].id
  };
}

let state = JSON.parse(localStorage.getItem("tdsurvivor_v4")||"null") || freshState();
let selectedPlayer = null;

function save(){ localStorage.setItem("tdsurvivor_v4",JSON.stringify(state)); }
function activeOwner(){ return state.owners.find(o=>o.id===state.activeOwnerId); }
function ownerEntries(ownerId=state.activeOwnerId){ return state.entries.filter(e=>e.ownerId===ownerId); }
function activeEntry(){ return state.entries.find(e=>e.id===state.activeEntryId) || ownerEntries()[0]; }
function usedPlayers(entry){ return new Set(entry.picks.map(p=>p.player.toLowerCase())); }
function pot(){
  const paidEntries = state.entries.filter(e=>e.paid).length;
  const buybacks = state.entries.filter(e=>e.buybackUsed).length;
  return paidEntries*state.league.entryFee + buybacks*state.league.buybackFee;
}
function aliveCount(){ return state.entries.filter(e=>e.status==="alive").length; }

function renderHeader(){
  const entry=activeEntry();
  document.querySelector("#weekNum").textContent=state.league.week;
  document.querySelector("#deadline").textContent=state.league.deadline;
  document.querySelector("#aliveCount").textContent=aliveCount();
  document.querySelector("#pot").textContent="$"+pot();
  document.querySelector("#myStatus").textContent=entry.status==="alive"?"Alive":"Out";
  document.querySelector("#pickStatus").textContent=state.league.locked?"LOCKED":"OPEN";
  document.querySelector("#pickStatus").style.color=state.league.locked?"#ff8993":"#5be69d";
  document.querySelector("#profileBtn").textContent=(activeOwner()?.name||"?").slice(0,2).toUpperCase();
  document.querySelector("#usedCount").textContent=usedPlayers(entry).size+" used";
  renderEntrySwitcher();
}

function renderEntrySwitcher(){
  const old=document.querySelector("#entrySwitcher");
  if(old) old.remove();
  const entries=ownerEntries();
  const panel=document.querySelector("#pickView");
  const div=document.createElement("div");
  div.id="entrySwitcher";
  div.style.cssText="display:flex;gap:7px;overflow:auto;margin:-3px 0 13px;";
  entries.forEach(e=>{
    const b=document.createElement("button");
    b.textContent=e.label;
    b.className="filter"+(e.id===activeEntry().id?" active":"");
    b.onclick=()=>{state.activeEntryId=e.id;save();render();};
    div.appendChild(b);
  });
  panel.insertBefore(div,panel.children[1]);
}

function renderPlayers(){
  const entry=activeEntry();
  const used=usedPlayers(entry);
  const q=document.querySelector("#search").value.toLowerCase();
  const pos=document.querySelector(".filter.active[data-pos]")?.dataset.pos || "ALL";
  const wrap=document.querySelector("#players"); wrap.innerHTML="";
  PLAYERS.filter(p=>(pos==="ALL"||p[2]===pos)&&p[0].toLowerCase().includes(q)).forEach(p=>{
    const isUsed=used.has(p[0].toLowerCase());
    const current = entry.picks.find(x=>x.week===state.league.week)?.player===p[0];
    const initials=p[0].split(" ").map(x=>x[0]).slice(0,2).join("");
    wrap.insertAdjacentHTML("beforeend",`<div class="player ${isUsed&&!current?"disabled":""}">
      <div class="avatar">${initials}</div>
      <div class="pinfo"><div class="pname">${p[0]}</div><div class="meta">${p[1]} • ${p[2]} ${current?"• Current pick":isUsed?"• Already used":""}</div></div>
      <button class="select" ${(isUsed&&!current)||state.league.locked?"disabled":""} data-name="${p[0]}">${current?"Selected":state.league.locked?"Locked":isUsed?"Used":"Select"}</button>
    </div>`);
  });
  document.querySelectorAll(".select:not([disabled])").forEach(b=>b.onclick=()=>openModal(b.dataset.name));
}

function renderStandings(){
  const el=document.querySelector("#standings"); el.innerHTML="";
  [...state.entries].sort((a,b)=>a.status.localeCompare(b.status)||a.label.localeCompare(b.label)).forEach((e,i)=>{
    const owner=state.owners.find(o=>o.id===e.ownerId);
    el.insertAdjacentHTML("beforeend",`<div class="row">
      <div class="rank">${i+1}</div><div class="rname">${e.label}<div class="meta">Owner: ${owner.name}</div></div>
      <div class="rstatus ${e.status==="alive"?"alive":"out"}">${e.status==="alive"?"ALIVE":"OUT"}</div></div>`);
  });
  document.querySelector("#standingsMeta").textContent=state.entries.length+" plays • "+state.owners.length+" owners";
}

function renderHistory(){
  const e=activeEntry();
  const el=document.querySelector("#history"); el.innerHTML="";
  if(!e.picks.length){
    el.innerHTML='<div class="muted">No picks submitted yet for this play.</div>';
    return;
  }
  e.picks.forEach(p=>el.insertAdjacentHTML("beforeend",`<div class="row">
    <span class="week">WEEK ${p.week}</span><span class="pick">${p.player}</span><span class="rstatus">${p.result||"Pending"}</span></div>`));
}

function renderAdmin(){
  document.querySelector("#adminEntries").textContent=state.entries.length;
  document.querySelector("#adminAlive").textContent=aliveCount();
  document.querySelector("#adminBuybacks").textContent=state.entries.filter(e=>e.buybackUsed).length;
  document.querySelector("#adminPot").textContent="$"+pot();

  if(!document.querySelector("#addEntryBtn")){
    const add=document.createElement("button");
    add.id="addEntryBtn"; add.textContent="➕ Add Another Play";
    document.querySelector(".admin-actions").appendChild(add);
    add.onclick=addEntry;
  }
  if(!document.querySelector("#paidBtn")){
    const paid=document.createElement("button");
    paid.id="paidBtn"; paid.textContent="✅ Toggle Entry Paid";
    document.querySelector(".admin-actions").appendChild(paid);
    paid.onclick=()=>{
      const e=activeEntry(); e.paid=!e.paid; save(); render();
      alert(`${e.label} marked ${e.paid?"paid":"unpaid"}.`);
    };
  }
}

function addEntry(){
  const ownerName=prompt("Owner name for the additional play:");
  if(!ownerName)return;
  const owner=state.owners.find(o=>o.name.toLowerCase()===ownerName.toLowerCase());
  if(!owner){alert("Owner not found.");return;}
  const existing=state.entries.filter(e=>e.ownerId===owner.id);
  const n=existing.length+1;
  if(existing.length===1 && !/\s\d+$/.test(existing[0].label)) existing[0].label=owner.name+" 1";
  const entry={id:"e"+Date.now(),ownerId:owner.id,label:owner.name+" "+n,status:"alive",buybackUsed:false,paid:false,picks:[]};
  state.entries.push(entry);
  state.activeOwnerId=owner.id; state.activeEntryId=entry.id;
  save(); render();
  alert(`${entry.label} created. It acts as a separate play under ${owner.name}'s account.`);
}

function render(){renderHeader();renderPlayers();renderStandings();renderHistory();renderAdmin();}
function openModal(name){selectedPlayer=name;document.querySelector("#chosen").textContent=name;document.querySelector("#modal").classList.remove("hidden")}
function closeModal(){document.querySelector("#modal").classList.add("hidden");selectedPlayer=null}

document.querySelector("#search").oninput=renderPlayers;
document.querySelectorAll(".filter[data-pos]").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".filter[data-pos]").forEach(x=>x.classList.remove("active"));b.classList.add("active");renderPlayers();
});
document.querySelectorAll(".navbtn").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".navbtn").forEach(x=>x.classList.remove("active"));b.classList.add("active");
  ["pickView","standingsView","historyView","adminView"].forEach(id=>document.querySelector("#"+id).classList.toggle("hidden",id!==b.dataset.view));
});
document.querySelector("#close").onclick=closeModal;document.querySelector(".shade").onclick=closeModal;
document.querySelector("#confirm").onclick=()=>{
  if(!selectedPlayer)return;
  const e=activeEntry();
  const existing=e.picks.find(p=>p.week===state.league.week);
  if(existing) existing.player=selectedPlayer; else e.picks.push({week:state.league.week,player:selectedPlayer,result:"Pending"});
  save();closeModal();render();alert(`${e.label} Week ${state.league.week} pick: ${selectedPlayer}`);
};
document.querySelector("#lockBtn").onclick=()=>{state.league.locked=true;save();render();alert("Week locked.");};
document.querySelector("#announcementBtn").onclick=()=>{
  const picks=state.entries.map(e=>({e,p:e.picks.find(x=>x.week===state.league.week)})).filter(x=>x.p);
  const counts={};picks.forEach(x=>counts[x.p.player]=(counts[x.p.player]||0)+1);
  const lines=Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([n,c])=>`${n} — ${c}`).join("\n");
  const text=`🏈 TD SURVIVOR — WEEK ${state.league.week}\n\n🔒 PICKS ARE ${state.league.locked?"LOCKED":"OPEN"}\n\n${lines||"No picks yet."}\n\n${aliveCount()} plays remain alive.\n${state.entries.length} total plays across ${state.owners.length} owners.\n\nGood luck! 🫡`;
  const box=document.querySelector("#announcement");box.textContent=text;box.classList.remove("hidden");navigator.clipboard?.writeText(text);
};
document.querySelector("#buybackBtn").onclick=()=>{
  const label=prompt("Enter play name (example: Tay 2):");
  const e=state.entries.find(x=>x.label.toLowerCase()===String(label||"").toLowerCase());
  if(!e){alert("Play not found.");return}
  if(e.buybackUsed){alert("That play already used its buyback.");return}
  e.buybackUsed=true;e.status="alive";save();render();alert(`${e.label} bought back in for $${state.league.buybackFee}.`);
};
document.querySelector("#profileBtn").onclick=()=>{
  const name=prompt("Demo: switch account by owner name:",activeOwner().name);
  if(!name)return;
  const o=state.owners.find(x=>x.name.toLowerCase()===name.toLowerCase());
  if(!o){alert("Owner not found.");return}
  state.activeOwnerId=o.id; state.activeEntryId=state.entries.find(e=>e.ownerId===o.id)?.id; save(); render();
};

window.resetTDSurvivorDemo=()=>{localStorage.removeItem("tdsurvivor_v4");location.reload();};
render();
