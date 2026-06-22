// /api/calendar.js — Brigada Installation Calendar feed for fl.windmar.us.
// Auth: WordPress Application Password (Basic auth works on any WP request).
// Env vars: WP_USER, WP_APP_PASSWORD  (optional WP_BASE_URL, default https://fl.windmar.us).
const SITE = process.env.WP_BASE_URL || "https://fl.windmar.us";
function defMonth(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-01"; }
function stripTags(s){ return (s||"").replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&#?\w+;/g," ").replace(/\s+/g," ").trim(); }
const STMAP = { "✓":"done", "!":"pastdue", "▶":"inprogress", "●":"scheduled" };
function tokens(text){
  const out=[]; const re=/([✓!▶●])?\s*((?:RDL|DL|RL|S)\d{2,})(\s*\+\d+)?/g; let m;
  while((m=re.exec(text))){ out.push({ code:m[2], status: STMAP[m[1]]||"scheduled", more:m[3]?m[3].trim():"" }); }
  return out;
}
function parseTotals(text){
  const grab=(label)=>{ const m=new RegExp(label.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&")+"\s+(\d+)","i").exec(text); return m?Number(m[1]):null; };
  return {
    install:{ total:grab("INSTALLATION TOTAL"), scheduled:grab("INSTALLATION SCHEDULED"), inProgress:grab("INSTALLATION IN PROGRESS"), complete:grab("INSTALLATION COMPLETE"), pastDue:grab("INSTALLATION PAST DUE") },
    service:{ total:grab("SERVICE TOTAL"), scheduled:grab("SERVICE SCHEDULED"), inProgress:grab("SERVICE IN PROGRESS"), complete:grab("SERVICE COMPLETE"), pastDue:grab("SERVICE PAST DUE") },
  };
}
function parseCalendar(html){
  const tables=html.match(/<table[\s\S]*?<\/table>/gi)||[];
  const tbl=tables.slice().sort((a,b)=>b.length-a.length)[0]||"";
  const trs=(tbl.match(/<tr[\s\S]*?<\/tr>/gi)||[]);
  const rows=trs.map(tr=>(tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi)||[]).map(c=>stripTags(c))).filter(r=>r.length);
  let headerIdx=0, best=0;
  rows.forEach((r,i)=>{ const days=r.filter(c=>/^\d{1,2}\b/.test(c)).length; if(days>best){best=days;headerIdx=i;} });
  const header=rows[headerIdx]||[];
  const dayCols=header.map(c=>{ const m=/^(\d{1,2})/.exec(c); return m?m[1].padStart(2,"0"):null; });
  const brigadas=[];
  for(let i=headerIdx+1;i<rows.length;i++){
    const r=rows[i]; if(!r.length) continue;
    const label=r[0]||"";
    if(!label || /^teams available$/i.test(label)) continue;
    const dayCells=r.slice(1);
    const days={}; let jobCount=0;
    dayCells.forEach((cell,ci)=>{ const day=dayCols[ci+1]; if(!day) return; const t=tokens(cell); if(t.length){ days[day]=t; jobCount+=t.length; } });
    if(label && (jobCount>0 || /house|roofing|solar|construction|T\d|service|brigada|eagle|doga|holis|windmar/i.test(label)))
      brigadas.push({ name:label, days, jobCount });
  }
  return { dayCols:dayCols.filter(Boolean), brigadas, totals:parseTotals(stripTags(html)) };
}
export default async function handler(req,res){
  res.setHeader("Cache-Control","s-maxage=30, stale-while-revalidate=120");
  const user=process.env.WP_USER, pass=process.env.WP_APP_PASSWORD;
  if(!user||!pass) return res.status(200).json({ configured:false, ok:false });
  const month=/^\d{4}-\d{2}-\d{2}$/.test(req.query.month||"")?req.query.month:defMonth();
  const view=(req.query.view||"all").toString().replace(/[^a-z]/gi,"")||"all";
  const auth="Basic "+Buffer.from(user+":"+pass.replace(/\s+/g,"")).toString("base64");
  try{
    const url=SITE+"/base-calendar/?month="+encodeURIComponent(month)+"&view="+encodeURIComponent(view);
    const r=await fetch(url,{headers:{Authorization:auth,"User-Agent":"WindMarItinerary/1.0",Accept:"text/html"}});
    const html=await r.text();
    const looksLogin=/wp-login|loginform|user_login/i.test(html) && !/Brigada/i.test(html);
    if(r.status>=400 || looksLogin) return res.status(200).json({ configured:true, ok:false, status:r.status, error:"auth failed / login wall" });
    if(req.query.debug) return res.status(200).json({ ok:true, len:html.length, head:html.slice(0,6000) });
    const data=parseCalendar(html);
    return res.status(200).json({ configured:true, ok:true, month, view, updated:new Date().toISOString(), ...data });
  }catch(e){ return res.status(200).json({ configured:true, ok:false, error:String(e) }); }
}
