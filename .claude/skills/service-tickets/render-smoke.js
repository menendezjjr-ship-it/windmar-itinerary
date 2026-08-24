// Minimal DOM shim so the real app script can EXECUTE, not just parse.
function El(){ this.style={}; this.classList={add(){},remove(){},toggle(){},contains(){return false}};
  this.dataset={}; this.children=[]; this.value=""; this.innerHTML=""; this.textContent="";
  this.scrollTop=0; this.scrollLeft=0; }
El.prototype.appendChild=function(c){this.children.push(c);return c;};
El.prototype.setAttribute=function(){}; El.prototype.getAttribute=function(){return null;};
El.prototype.removeAttribute=function(){}; El.prototype.addEventListener=function(){};
El.prototype.removeEventListener=function(){}; El.prototype.querySelector=function(){return null;};
El.prototype.querySelectorAll=function(){return [];}; El.prototype.closest=function(){return null;};
El.prototype.focus=function(){}; El.prototype.blur=function(){}; El.prototype.remove=function(){};
El.prototype.insertAdjacentHTML=function(){}; El.prototype.getBoundingClientRect=function(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};};
var _store={};
globalThis.localStorage={getItem:k=>(k in _store?_store[k]:null),setItem:(k,v)=>{_store[k]=String(v)},removeItem:k=>{delete _store[k]},clear:()=>{_store={}}};
globalThis.document={ readyState:"complete", hidden:false, body:new El(), documentElement:new El(),
  getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[],
  createElement:()=>new El(), addEventListener(){}, removeEventListener(){},
  createTextNode:()=>new El(), head:new El(), cookie:"" };
globalThis.addEventListener=function(){}; globalThis.removeEventListener=function(){};
globalThis.dispatchEvent=function(){return true;};
globalThis.window=globalThis;
globalThis.navigator={userAgent:"jsc",language:"en-US",onLine:true,geolocation:{getCurrentPosition(){}}};
globalThis.location={href:"https://windmar-itinerary.vercel.app/",search:"",hash:"",protocol:"https:",hostname:"windmar-itinerary.vercel.app",reload(){}};
globalThis.fetch=function(){ return new Promise(function(){}); };
globalThis.setTimeout=function(){return 0;}; globalThis.setInterval=function(){return 0;};
globalThis.clearTimeout=function(){}; globalThis.clearInterval=function(){};
globalThis.requestAnimationFrame=function(){return 0;};
globalThis.matchMedia=function(){return {matches:false,addEventListener(){},addListener(){}};};
globalThis.scrollTo=function(){}; globalThis.alert=function(){}; globalThis.confirm=function(){return true;};
globalThis.L={map:()=>({setView:()=>({}),remove(){},on(){}}),tileLayer:()=>({addTo(){}}),marker:()=>({addTo(){return{bindPopup(){}}}})};

// APP is a path to the extracted main <script> body. Extracting it with hardcoded line numbers
// silently tests the wrong lines once the file grows — derive the boundaries instead:
//   S=$(grep -n '^<script>$' index.html | head -1 | cut -d: -f1)
//   E=$(awk -v st=$S 'NR>st && /^<\/script>$/{print NR; exit}' index.html)
//   sed -n "$((S+1)),$((E-1))p" index.html > app.js
var APP_FROM_HTML = true;
var err=null;
try { (0,eval)(readFile(APP)); } catch(e){ err=e; }
if(err){ print("APP EXECUTE FAIL: "+err); print(err.stack||""); quit(1); }
print("APP EXECUTED OK (all top-level code ran)");

// Now exercise the real calChip with the real module scope — nothing stubbed.
var svc={type:"service",id:"s1",dlNumber:"DL7051",address:"1 Calle A, Bayamon, PR 00956",
  startDate:"2026-08-14",startTime:"10:00 AM",hours:8,blocks:4,priority:"High",msp:false,
  customerName:"Annery Carrillo",code:"S"};
var p=0,f=0; function t(n,c){c?p++:(f++,print("FAIL: "+n));}
function tryCall(label,fn){ try{ return fn(); }catch(e){ f++; print("THREW in "+label+": "+e); return ""; } }

var grid=tryCall("calChip compact", ()=>calChip(svc,false,1));
var full=tryCall("calChip full",    ()=>calChip(svc,false));
var cont=tryCall("calChip cont",    ()=>calChip(svc,true,1));
var row =tryCall("calRow",          ()=>calRow(svc,0));

t("grid chip renders",  grid.length>0);
t("grid shows 8h",      grid.indexOf(">8h<")>=0);
t("grid shows city",    grid.indexOf("Bayamon")>=0);
t("grid drops street",  grid.indexOf("1 Calle A")<0);
t("grid drops zip",     grid.indexOf("00956")<0);
t("full shows address", full.indexOf("1 Calle A")>=0);
t("cont shows arrow",   cont.indexOf("↪")>=0);
t("row renders",        row.length>0);
t("row shows 8h",       row.indexOf("8h")>=0);
t("click target",       grid.indexOf('data-action="calSelectJob"')>=0);
t("install no badge",   tryCall("i",()=>calChip({type:"install",id:"i",dlNumber:"DL1",hours:0,address:"a, Tampa, FL 33601"},false,1)).indexOf("h<")<0);

// ✓ via the real completedByDL()/calDone() path off window.CREW_FEED
window.CREW_FEED=[{dl_number:"DL7051",status:"Complete",team:"Crew #2S",created_at:new Date().toISOString()}];
var done=tryCall("calChip done",()=>calChip(svc,false,1));
t("crew ✓ renders",     done.indexOf("✓")>=0);
t("✓ names crew",       done.indexOf("Crew #2S")>=0);

// the month/grid cells call it exactly this way
t("map form works",     tryCall("map",()=>[svc,svc,svc].map(j=>calChip(j,j.startDate!=="2026-08-14",1)).join("")).length>0);
print(f?("SCOPE+RENDER: "+p+" pass, "+f+" FAIL"):("SCOPE+RENDER: all "+p+" pass, zero throws"));
