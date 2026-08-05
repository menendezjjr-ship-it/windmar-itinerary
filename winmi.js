// WinMI portable widget — <script src="https://windmar-itinerary.vercel.app/winmi.js" defer></script>

(function(){
  if(window.__wmSunny) return; window.__wmSunny=true;
  var WINMI_API=(window.WINMI_API||"https://windmar-itinerary.vercel.app/api/assistant");
  function es(){ try{ if(window.WINMI_LANG) return String(window.WINMI_LANG).toLowerCase().indexOf("es")===0; if(typeof S!=="undefined"&&S&&S.lang) return S.lang==="es"; var hl=(document.documentElement.lang||navigator.language||"").toLowerCase(); return hl.indexOf("es")===0; }catch(e){ return false; } }
  function T(a,b){ return es()?b:a; }
  var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition||null;
  var muted=false; try{ muted=localStorage.getItem("wm_sunny_mute")==="1"; }catch(e){}

  // ---- WinMI the sun-bot (SVG): a SUN for a head (friendly face) + a small body with the WindMar "W" chest ----
  function rays(){ var s="",cx=60,cy=44,n=12,r0=26,r1=39; for(var i=0;i<n;i++){ var a=(i*(360/n))*Math.PI/180,ux=Math.cos(a),uy=Math.sin(a);
    s+='<line x1="'+(cx+ux*r0).toFixed(1)+'" y1="'+(cy+uy*r0).toFixed(1)+'" x2="'+(cx+ux*r1).toFixed(1)+'" y2="'+(cy+uy*r1).toFixed(1)+'" stroke="url(#wmSunG)" stroke-width="4" stroke-linecap="round"/>'; } return s; }
  function droid(px){ return '<svg viewBox="0 0 120 152" width="'+px+'" height="'+Math.round(px*1.27)+'" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;overflow:visible">'
    +'<defs>'
    +'<linearGradient id="wmMetal" x1="0.15" y1="0" x2="0.7" y2="1"><stop offset="0" stop-color="#4f77cf"/><stop offset="0.5" stop-color="#274a91"/><stop offset="1" stop-color="#15357c"/></linearGradient>'
    +'<radialGradient id="wmSunDisc" cx="40%" cy="34%" r="72%"><stop offset="0" stop-color="#FFF0B8"/><stop offset="45%" stop-color="#FDBE3C"/><stop offset="100%" stop-color="#F0850F"/></radialGradient>'
    +'<linearGradient id="wmSunG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD54A"/><stop offset="1" stop-color="#F89B24"/></linearGradient>'
    +'</defs>'
    +'<ellipse cx="60" cy="143" rx="27" ry="5" fill="#000" opacity="0.28"/>'  // ground shadow (3D depth)
    +'<g class="wmSunRays">'+rays()+'</g>'                                    // spinning sun rays
    +'<rect x="15" y="90" width="11" height="27" rx="5.5" fill="url(#wmMetal)"/><rect x="94" y="90" width="11" height="27" rx="5.5" fill="url(#wmMetal)"/>' // arms
    +'<rect x="54" y="63" width="12" height="24" fill="#20407e"/>'            // neck
    +'<rect x="39" y="79" width="42" height="46" rx="14" fill="url(#wmMetal)" stroke="#9cc0ff" stroke-width="1.5"/>' // body
    +'<rect x="44" y="82" width="32" height="10" rx="5" fill="#ffffff" opacity="0.14"/>'  // body sheen highlight
    +'<circle class="wmSunGlowC" cx="60" cy="104" r="14" fill="#F89B24" opacity="0"/>'
    +'<rect x="46" y="90" width="28" height="27" rx="7" fill="#0a1526"/>'     // chest panel
    +'<rect x="46" y="90" width="28" height="9" rx="7" fill="#ffffff" opacity="0.06"/>'  // chest glass glare
    +'<text class="wmSunW" x="60" y="111" text-anchor="middle" font-family="Montserrat,Arial,sans-serif" font-weight="900" font-size="20" fill="url(#wmSunG)">W</text>'
    +'<circle cx="60" cy="44" r="25.5" fill="url(#wmSunDisc)" stroke="#F0850F" stroke-width="1.5"/>' // SUN head
    +'<ellipse cx="51" cy="33" rx="11" ry="6.5" fill="#fff" opacity="0.42"/>'  // glossy specular highlight
    +'<circle class="wmSunEye" cx="51" cy="44" r="4.8" fill="#0a1526"/><circle class="wmSunEye" cx="69" cy="44" r="4.8" fill="#0a1526"/>' // eyes
    +'<circle cx="52.6" cy="42.3" r="1.5" fill="#fff"/><circle cx="70.6" cy="42.3" r="1.5" fill="#fff"/>' // eye sparkles
    +'<path class="wmSunMouth" d="M50 53 Q60 61 70 53" fill="none" stroke="#0a1526" stroke-width="3" stroke-linecap="round"/>' // mouth (animates when talking)
    +'</svg>'; }

  var st=document.createElement("style");
  st.textContent=[
    "@keyframes wmSunBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}",
    "@keyframes wmSunSpinR{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
    "@keyframes wmSunBlink{0%,90%,100%{transform:scaleY(1)}94%{transform:scaleY(.12)}}",
    "@keyframes wmSunChestP{0%,100%{opacity:0}50%{opacity:.4}}",
    "@keyframes wmSunTipP{0%,100%{opacity:.5}50%{opacity:1}}",
    "@keyframes wmSunRing{0%{transform:scale(.7);opacity:.6}100%{transform:scale(1.7);opacity:0}}",
    "@keyframes wmSunUp{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}","@keyframes wmBIn{from{opacity:0;transform:translateY(9px) scale(.985)}to{opacity:1;transform:none}}",
    reduce?"":".wmSunRays{transform-box:view-box;transform-origin:60px 44px;animation:wmSunSpinR 22s linear infinite}",
    reduce?"":".wmSunEye{transform-box:fill-box;transform-origin:center;animation:wmSunBlink 5.2s ease-in-out infinite}",
    reduce?"":".wmSunGlowC{animation:wmSunChestP 2.6s ease-in-out infinite}",
    reduce?"":".wmSunTip{animation:wmSunTipP 1.8s ease-in-out infinite}",
    ".wmSunMouth{transform-box:fill-box;transform-origin:center}",
    "@keyframes wmsTalk{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.7)}}",
    // Reactive "alive" states (body.wmi-*): thinking = faster rays + chest pulse; listening = cyan
    // eyes + chest pulse; talking = mouth moves + quicker bob. Skipped under reduced-motion.
    reduce?"":".wmi-thinking .wmSunRays{animation:wmSunSpinR 3.5s linear infinite}",
    reduce?"":".wmi-thinking .wmSunGlowC{opacity:.35;animation:wmSunChestP 1s ease-in-out infinite}",
    reduce?"":".wmi-listening .wmSunGlowC{opacity:.5;animation:wmSunChestP .8s ease-in-out infinite}",
    ".wmi-listening .wmSunEye{fill:#38e1ff}",
    reduce?"":".wmi-talking .wmSunMouth{animation:wmsTalk .28s ease-in-out infinite}",
    reduce?"":".wmi-talking .wmSunLaunch{animation:wmSunBob 1s ease-in-out infinite}",
    ".wmSunLaunch{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:78px;height:90px;z-index:1600;border:none;background:transparent;cursor:pointer;padding:0;-webkit-tap-highlight-color:transparent;filter:drop-shadow(0 8px 15px rgba(0,0,0,.45)) drop-shadow(0 0 12px rgba(248,155,36,.45))}",
    reduce?".wmSunLaunch{}":".wmSunLaunch{animation:wmSunBob 3.6s ease-in-out infinite}",
    ".wmSunLaunch:active{transform:scale(.92)}",
    ".wmSunRing{position:absolute;left:50%;top:52%;width:80px;height:80px;margin:-40px 0 0 -40px;border-radius:50%;background:radial-gradient(circle,rgba(248,155,36,.6),rgba(29,66,155,.25) 55%,transparent 72%);z-index:-1;pointer-events:none}",
    reduce?"":".wmSunRing{animation:wmSunRing 2.4s ease-out infinite}",
    ".wmSunHi{position:fixed;right:92px;bottom:calc(34px + env(safe-area-inset-bottom,0px));z-index:1600;background:#122042;color:#fff;border:1px solid #1D429B;border-radius:14px;padding:9px 13px;font:600 12.5px Montserrat,system-ui,sans-serif;max-width:210px;box-shadow:0 10px 24px -8px rgba(0,0,0,.6)}",
    ".wmSunHi:after{content:'';position:absolute;right:-7px;bottom:16px;border:7px solid transparent;border-left-color:#122042}",
    ".wmSunPanel{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:440px;max-width:calc(100vw - 24px);height:600px;max-height:82vh;z-index:1650;background:linear-gradient(180deg,#0e1c3b,#0a1326);border:1px solid #2c4f93;border-radius:22px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 72px -14px rgba(0,0,0,.78),0 0 0 1px rgba(56,225,255,.07),inset 0 1px 0 rgba(255,255,255,.06);animation:wmSunUp .34s cubic-bezier(.22,1.1,.4,1) both}",
    "@media (max-width:560px){.wmSunPanel{right:0;left:0;bottom:0;width:100%;max-width:100%;height:86dvh;max-height:86dvh;border-radius:20px 20px 0 0}}",
    ".wmSunHdr{display:flex;align-items:center;gap:10px;padding:12px 13px;background:linear-gradient(120deg,#1e3d80,#13264f 58%,#0c1730);border-bottom:1px solid #2c4f93;flex-shrink:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 3px 14px -6px rgba(0,0,0,.55)}",
    ".wmSunBody{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px;display:flex;flex-direction:column;gap:11px;background:radial-gradient(135% 68% at 50% -4%,rgba(22,41,81,.6),#0a1428),linear-gradient(180deg,#0c1832,#0a1224)}",
    ".wmSunFoot{flex-shrink:0;padding:10px;border-top:1px solid #22407e;background:#0c1730;display:flex;gap:8px;align-items:flex-end}",
    ".wmB{max-width:90%;padding:11px 14px;border-radius:16px;font:500 13.5px/1.55 Montserrat,system-ui,sans-serif;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;animation:wmBIn .34s cubic-bezier(.22,1.05,.4,1) both}",
    ".wmB.u{align-self:flex-end;background:linear-gradient(140deg,#2a5bd0,#173aa6);color:#fff;border-bottom-right-radius:6px;box-shadow:inset 0 1px 0 rgba(255,255,255,.24),0 7px 18px -9px rgba(29,66,155,.75)}",
    ".wmB.b{align-self:flex-start;background:linear-gradient(163deg,#213a72 0%,#152a4d 100%);color:#eef4ff;border:1px solid #37578f;border-bottom-left-radius:6px;white-space:normal;box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 10px 26px -14px rgba(0,0,0,.7),0 0 22px -12px rgba(56,225,255,.25)}",
    ".wmB.b strong{color:#fff;font-weight:800;text-shadow:0 0 14px rgba(120,180,255,.28)}",
    ".wmB.b ul{margin:7px 0 3px;padding-left:20px}",
    ".wmB.b li{margin:4px 0;line-height:1.5}",
    ".wmB.b code{background:#0f1d3c;padding:1px 5px;border-radius:5px;font-size:12.5px}",
    ".wmB.b p{margin:0 0 8px}",".wmB.b p:last-child{margin:0}",
    ".wmB.b .wmViz{margin:9px 0 4px;background:linear-gradient(160deg,#0d1e3d,#081120);border:1px solid #31569a;border-radius:14px;padding:12px;overflow-x:auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 8px 22px -13px rgba(0,0,0,.6)}",
    ".wmB.b .wmViz svg{max-width:100%;height:auto;display:block;margin:0 auto}",
    ".wmChips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;align-self:flex-start;max-width:92%;animation:wmBIn .3s ease both}",".wmChip{background:linear-gradient(160deg,#26498c,#183056);border:1px solid #3c62a6;color:#dbe9ff;border-radius:20px;padding:8px 13px;font:600 12px Montserrat,system-ui,sans-serif;cursor:pointer;white-space:nowrap;box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 4px 12px -6px rgba(0,0,0,.5);transition:transform .12s ease,box-shadow .12s ease,filter .12s ease}",".wmChip:hover{transform:translateY(-1px);filter:brightness(1.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 7px 16px -6px rgba(29,66,155,.6)}",".wmGal{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:9px;align-self:stretch;width:100%;animation:wmBIn .34s ease both}",".wmGal a{display:block;border-radius:11px;overflow:hidden;border:1px solid #2f5596;background:#0a1526;aspect-ratio:1/1;box-shadow:0 6px 16px -10px rgba(0,0,0,.6)}",".wmGal img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .25s ease}",".wmGal a:hover img{transform:scale(1.07)}",
    ".wmChip:active{transform:translateY(0) scale(.96);filter:brightness(.95)}",
    ".wmSunIn{flex:1;min-height:42px;max-height:110px;resize:none;border-radius:14px;border:1px solid #2a4a86;background:#0f1d3c;color:#fff;padding:11px 13px;font:500 16px Montserrat,system-ui,sans-serif;outline:none}",
    ".wmSunBtn{flex-shrink:0;width:44px;height:44px;border-radius:14px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:19px}",
    ".wmTypDot{width:7px;height:7px;border-radius:50%;background:#7fa8e6;display:inline-block;margin-right:3px;animation:wmSunTipP 1s ease-in-out infinite}",
    ".wmTour{position:fixed;inset:0;z-index:2147483000}",
    ".wmTourHi{position:absolute;border-radius:14px;box-shadow:0 0 0 4px #F89B24,0 0 0 9999px rgba(6,12,26,.78);transition:all .3s ease;pointer-events:none}",
    ".wmTourCard{position:absolute;max-width:290px;background:#12234b;border:1px solid #2a55bd;border-radius:16px;padding:14px;box-shadow:0 18px 40px -10px rgba(0,0,0,.7);font-family:Montserrat,system-ui,sans-serif}"
  ].join("");
  document.head.appendChild(st);

  var launch=document.createElement("button");
  launch.className="wmSunLaunch"; launch.setAttribute("aria-label","WindMar Assistant");
  launch.innerHTML=(reduce?"":'<span class="wmSunRing"></span>')+droid(52);
  var panel=null, history=[], hi=null;

  // Reactive "alive" state — a body class the droid CSS reacts to (idle/listening/thinking/talking).
  function winmiState(s){ try{ var c=document.body.classList; ["idle","listening","thinking","talking"].forEach(function(x){c.remove("wmi-"+x);}); c.add("wmi-"+(s||"idle")); }catch(e){} }
  // Pick the most natural voice the device offers (voices load async → cache + refresh).
  var WM_VOICES=[]; function wmLoadVoices(){ try{ WM_VOICES=window.speechSynthesis.getVoices()||[]; }catch(e){} }
  if(window.speechSynthesis){ wmLoadVoices(); try{ window.speechSynthesis.addEventListener("voiceschanged",wmLoadVoices); }catch(e){ try{window.speechSynthesis.onvoiceschanged=wmLoadVoices;}catch(_){} } }
  var WM_FEM=/(samantha|victoria|karen|moira|tessa|fiona|allison|susan|zira|hazel|catherine|linda|heather|serena|kate|female|aria|jenny|emma|libby|michelle|nova|ava|elvira|dalia|paloma|lucia|m[oó]nica|monica|paulina|helena|sabina|marisol)/i;
  function wmPickVoice(sp){ if(!WM_VOICES.length) wmLoadVoices(); var vs=WM_VOICES; if(!vs.length) return null;
    var pref=sp?"es":"en";
    var pri=sp?[/(jorge|alvaro|carlos|juan|diego|enrique|pablo|miguel)\b.*(natural|online|neural)/i,/google espa.*male/i,/\b(jorge|alvaro|carlos|juan|diego|enrique|pablo|miguel|paco)\b/i,/\bmale\b/i,/natural|neural|online/i]
              :[/(guy|andrew|brian|christopher|eric|davis|tony|jason|steffan|roger|liam)\b.*(natural|online|neural)/i,/google uk english male/i,/\b(daniel|alex|aaron|arthur|oliver|reed|fred|gordon|rocko|ralph|junior)\b/i,/\bmale\b/i,/\b(david|mark|george|james)\b/i,/natural|neural|online/i];
    for(var p=0;p<pri.length;p++){ for(var i=0;i<vs.length;i++){ if((vs[i].lang||"").toLowerCase().indexOf(pref)===0 && pri[p].test(vs[i].name||"")) return vs[i]; } }
    for(var j=0;j<vs.length;j++){ if((vs[j].lang||"").toLowerCase().indexOf(pref)===0 && !WM_FEM.test(vs[j].name||"")) return vs[j]; }
    for(var k=0;k<vs.length;k++){ if((vs[k].lang||"").toLowerCase().indexOf(pref)===0) return vs[k]; }
    return null; }
  // Strip diagrams/markdown/urls/emoji so it reads smoothly (not "asterisk", "less-than svg", etc).
  function wmSpokenText(t){ try{ return String(t||"")
    .replace(/```[\s\S]*?```/g," ").replace(/<svg[\s\S]*?<\/svg>/gi," ").replace(/https?:\/\/\S+/g," ")
    .replace(/\*\*([^*]+)\*\*/g,"$1").replace(/`([^`]+)`/g,"$1").replace(/[*_#>`|]/g," ")
    .replace(/^\s*[-•]\s*/gm,"").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu," ")
    .replace(/\s{2,}/g," ").trim(); }catch(e){ return String(t||"").replace(/[*_#`]/g,""); } }
  function speak(txt){ if(muted||!window.speechSynthesis||!txt){ winmiState("idle"); return; }
    try{ window.speechSynthesis.cancel(); var spoken=wmSpokenText(txt); if(!spoken){ winmiState("idle"); return; }
      var u=new SpeechSynthesisUtterance(spoken); var sp=es(); u.lang=sp?"es-ES":"en-US";
      var v=wmPickVoice(sp); if(v){ u.voice=v; if(v.lang) u.lang=v.lang; }
      u.rate=1.0; u.pitch=0.95; // smooth male tone
      winmiState("talking"); u.onend=function(){ winmiState("idle"); }; u.onerror=function(){ winmiState("idle"); };
      window.speechSynthesis.speak(u);
    }catch(e){ winmiState("idle"); } }
  function stopSpeak(){ try{ window.speechSynthesis&&window.speechSynthesis.cancel(); }catch(e){} winmiState("idle"); }

  // Light, SAFE markdown → HTML for WinMI's answers so descriptions read clean (bold, bullets, spacing).
  function wmEsc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  // Strip anything executable/external from a model-produced SVG so it renders safely (no scripts).
  function wmSanSvg(svg){ return String(svg)
    .replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi,"")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi,"")
    .replace(/(?:xlink:)?href\s*=\s*("(?!#|data:)[^"]*"|'(?!#|data:)[^']*')/gi,"")
    .replace(/\bsrc\s*=\s*("(?!data:)[^"]*"|'(?!data:)[^']*')/gi,""); }
  function fmtBotHtml(t){
    t=String(t==null?"":t); var svgs=[];
    var stash=function(g){ svgs.push(g); return " SVG"+(svgs.length-1)+" "; };
    t=t.replace(/```svg\s*([\s\S]*?)```/gi,function(_,g){return stash(g);});
    t=t.replace(/```(?:xml|html)?\s*(<svg[\s\S]*?<\/svg>)\s*```/gi,function(_,g){return stash(g);});
    t=t.replace(/<svg[\s\S]*?<\/svg>/gi,function(g){return stash(g);});
    var s=wmEsc(t).replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+)`/g,"<code>$1</code>").replace(/^\s*#{1,6}\s+(.*)$/gm,"<strong>$1</strong>");
    var lines=s.split(/\r?\n/), out=[], inUl=false, flush=function(){ if(inUl){out.push("</ul>");inUl=false;} };
    for(var i=0;i<lines.length;i++){ var ln=lines[i], m=ln.match(/^\s*(?:[•\-\*]|\d+[\.\)])\s+(.*)$/);
      if(m){ if(!inUl){out.push("<ul>");inUl=true;} out.push("<li>"+m[1]+"</li>"); }
      else if(ln.trim()===""){ flush(); out.push("<br>"); }
      else { flush(); out.push(ln+"<br>"); } }
    flush();
    var html=out.join("").replace(/(<br>\s*)+$/,"").replace(/<\/ul>\s*<br>/g,"</ul>").replace(/<br>\s*<ul>/g,"<ul>");
    html=html.replace(/ SVG(\d+) (<br>)?/g,function(_,i){ return '<div class="wmViz">'+wmSanSvg(svgs[+i])+'</div>'; });
    return html;
  }
  function wmScrollTop(b,d){ if(!b||!d) return; var go=function(){ try{ var top=d.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop; b.scrollTop=Math.max(0,top-6); }catch(e){ b.scrollTop=b.scrollHeight; } }; go(); setTimeout(go,60); setTimeout(go,260); }
  function addBubble(who,txt){ var b=document.getElementById("wmSunMsgs"); if(!b) return null; var d=document.createElement("div"); d.className="wmB "+(who==="u"?"u":"b"); if(who==="u"){ d.textContent=txt; } else { d.innerHTML=fmtBotHtml(txt); } b.appendChild(d); if(who==="b"){ wmScrollTop(b,d); } else { b.scrollTop=b.scrollHeight; } return d; }
  function addChips(list){ if(!list||!list.length) return; var b=document.getElementById("wmSunMsgs"); if(!b) return; var w=document.createElement("div"); w.className="wmChips"; list.slice(0,6).forEach(function(it){ if(!it||!it.label) return; var c=document.createElement("button"); c.type="button"; c.className="wmChip"; c.textContent=it.label; c.onclick=function(){ if(it&&it.url){ try{ window.open(it.url,"_blank","noopener"); }catch(e){} } else if(it&&it.q){ send(it.q); } }; w.appendChild(c); }); b.appendChild(w); }
  function addPhotos(list){ if(!list||!list.length) return; var b=document.getElementById("wmSunMsgs"); if(!b) return; var g=document.createElement("div"); g.className="wmGal";
    list.slice(0,18).forEach(function(u){ if(typeof u!=="string"||!/^https:\/\/(windmar-service-app|windmar-itinerary)\.vercel\.app\/api\/sitecapture\?/.test(u)) return; var a=document.createElement("a"); a.href=u; a.target="_blank"; a.rel="noopener"; var im=document.createElement("img"); im.src=u; im.loading="lazy"; im.alt="job photo"; a.appendChild(im); g.appendChild(a); });
    if(g.children.length){ b.appendChild(g); } }
  function typing(on){ var b=document.getElementById("wmSunMsgs"); if(!b) return; var ex=document.getElementById("wmSunTyp"); if(ex)ex.remove(); if(on){ var d=document.createElement("div"); d.id="wmSunTyp"; d.className="wmB b"; d.innerHTML='<span class="wmTypDot"></span><span class="wmTypDot" style="animation-delay:.2s"></span><span class="wmTypDot" style="animation-delay:.4s"></span>'; b.appendChild(d); b.scrollTop=b.scrollHeight; } }

  function send(text){ text=(text||"").trim(); if(!text) return; stopSpeak();
    addBubble("u",text); history.push({role:"user",content:text}); if(history.length>16) history=history.slice(-16);
    var inp=document.getElementById("wmSunInput"); if(inp){ inp.value=""; inp.style.height="42px"; }
    typing(true); winmiState("thinking");
    fetch(WINMI_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({messages:history,lang:es()?"es":"en"})})
      .then(function(r){return r.json();}).then(function(j){ typing(false);
        if(j&&j.ok&&j.answer){ addBubble("b",j.answer); addChips(j.suggestions); addPhotos(j.photos); history.push({role:"assistant",content:j.answer}); winmiState("idle"); speak(j.answer); }
        else if(j&&j.configured===false){ winmiState("idle"); addBubble("b",T("I'm almost ready! An admin just needs to add my AI key (ANTHROPIC_API_KEY) in the app settings, then I can answer anything about your projects.","¡Casi listo! Un administrador debe agregar mi clave de IA (ANTHROPIC_API_KEY) en la configuración y podré responder sobre tus proyectos.")); }
        else{ winmiState("idle"); addBubble("b",T("Hmm, I couldn't reach my brain just now. Please try again in a moment.","Mmm, no pude conectar ahora mismo. Inténtalo de nuevo en un momento.")); }
      }).catch(function(){ typing(false); winmiState("idle"); addBubble("b",T("Network hiccup — please try again.","Fallo de red — inténtalo de nuevo.")); });
  }
  // Send an attachment (photo OR pdf) to WinMI and render the reply.
  function postFile(att){
    var isPdf=/pdf/i.test(att.mediaType||""); var capEl=document.getElementById("wmSunInput");
    var cap=(capEl&&capEl.value.trim())||(isPdf?T("Read this document and give me a detailed description.","Lee este documento y dame una descripción detallada."):T("Analyze this photo — identify the equipment and any code issues.","Analiza esta foto — identifica el equipo y problemas de código."));
    if(capEl){ capEl.value=""; capEl.style.height="42px"; }
    history.push({role:"user",content:cap}); if(history.length>16) history=history.slice(-16);
    typing(true); winmiState("thinking");
    var payload={messages:history,lang:es()?"es":"en"}; if(isPdf) payload.file=att; else payload.image=att;
    fetch(WINMI_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)})
      .then(function(r){return r.json();}).then(function(j){ typing(false);
        if(j&&j.ok&&j.answer){ addBubble("b",j.answer); history.push({role:"assistant",content:j.answer}); winmiState("idle"); speak(j.answer); }
        else{ winmiState("idle"); addBubble("b",T("I couldn't read that file just now — please try again.","No pude leer el archivo ahora mismo — inténtalo de nuevo.")); }
      }).catch(function(){ typing(false); winmiState("idle"); addBubble("b",T("Network hiccup — please try again.","Fallo de red — inténtalo de nuevo.")); });
  }
  // Take/upload a PHOTO (downscaled on-device) or a PDF document → WinMI reads it in detail.
  function sendFile(f){ if(!f) return; stopSpeak();
    var isImg=/^image\//.test(f.type||""), isPdf=/pdf/i.test(f.type||"")||/\.pdf$/i.test(f.name||"");
    if(!isImg&&!isPdf){ addBubble("b",T("I can read photos and PDF files — attach one of those.","Puedo leer fotos y archivos PDF — adjunta uno de esos.")); return; }
    if(isPdf&&f.size>3000000){ addBubble("b",T("That PDF is too big to read here (max ~3MB). Try a smaller file or a single page/section.","Ese PDF es muy grande (máx ~3MB). Prueba un archivo más pequeño o una sola página/sección.")); return; }
    var reader=new FileReader();
    reader.onload=function(){
      if(isImg){ var img=new Image(); img.onload=function(){
          var max=1280,w=img.width,h=img.height; if(w>max||h>max){ if(w>=h){h=Math.round(h*max/w);w=max;}else{w=Math.round(w*max/h);h=max;} }
          var cv=document.createElement("canvas"); cv.width=w; cv.height=h; try{cv.getContext("2d").drawImage(img,0,0,w,h);}catch(e){}
          var durl; try{durl=cv.toDataURL("image/jpeg",0.82);}catch(e){durl=reader.result;}
          var b=document.getElementById("wmSunMsgs"); if(b){var d=document.createElement("div");d.className="wmB u";d.style.padding="5px";d.innerHTML='<img src="'+durl+'" alt="" style="max-width:190px;max-height:190px;border-radius:10px;display:block"/>';b.appendChild(d);b.scrollTop=b.scrollHeight;}
          postFile({data:String(durl).split(",")[1]||"",mediaType:"image/jpeg"});
        }; img.src=reader.result;
      } else {
        var b2=document.getElementById("wmSunMsgs"); if(b2){var d2=document.createElement("div");d2.className="wmB u";d2.textContent="📄 "+String(f.name||"document.pdf").slice(0,44);b2.appendChild(d2);b2.scrollTop=b2.scrollHeight;}
        postFile({data:String(reader.result).split(",")[1]||"",mediaType:"application/pdf"});
      }
    };
    reader.readAsDataURL(f);
  }

  function quickChips(){ var wrap=document.createElement("div"); wrap.style.cssText="display:flex;gap:7px;flex-wrap:wrap;margin-top:2px";
    var chips=[[T("🔎 Look up a DL#","🔎 Buscar un DL#"),T("Look up project ","Buscar el proyecto ")],
      [T("🗓 What's ready to schedule?","🗓 ¿Qué está listo para programar?"),T("What jobs are ready to schedule right now?","¿Qué trabajos están listos para programar ahora?")],
      [T("📷 Find in SiteCapture","📷 Buscar en SiteCapture"),T("Search SiteCapture for ","Buscar en SiteCapture ")],
      [T("✨ Show me around","✨ Muéstrame la app"),"__tour__"]];
    chips.forEach(function(c){ var b=document.createElement("button"); b.className="wmChip"; b.textContent=c[0];
      b.onclick=function(){ if(c[1]==="__tour__"){ startTour(); return; } var inp=document.getElementById("wmSunInput"); if(inp){ inp.value=c[1]; inp.focus(); if(/\?$/.test(c[1])) send(c[1]); } }; wrap.appendChild(b); });
    return wrap; }

  function openPanel(){ if(panel){ return; } if(hi){ hi.remove(); hi=null; }
    panel=document.createElement("div"); panel.className="wmSunPanel";
    panel.innerHTML='<div class="wmSunHdr"><span style="flex-shrink:0;display:inline-flex;filter:drop-shadow(0 0 8px rgba(248,155,36,.6))">'+droid(44)+'</span>'
      +'<div style="flex:1;min-width:0"><div style="font:800 14px Montserrat,system-ui,sans-serif;color:#fff">WinMI</div><div style="font-size:11px;color:#8fb0e6">'+T("WindMar Assistant · Zoho + SiteCapture","Asistente WindMar · Zoho + SiteCapture")+'</div></div>'
      +'<button id="wmSunMute" title="'+T("Voice replies","Respuestas por voz")+'" style="background:transparent;border:none;color:#8fb0e6;font-size:18px;cursor:pointer;width:34px;height:34px">'+(muted?"🔇":"🔊")+'</button>'
      +'<button id="wmSunClose" style="background:transparent;border:none;color:#8fb0e6;font-size:20px;cursor:pointer;width:34px;height:34px">✕</button></div>'
      +'<div class="wmSunBody" id="wmSunMsgs"></div>'
      +'<div class="wmSunFoot"><input id="wmSunFile" type="file" accept="image/*,application/pdf" style="display:none"/>'
      +'<textarea id="wmSunInput" class="wmSunIn" rows="1" placeholder="'+T("Ask about any project…","Pregunta sobre cualquier proyecto…")+'"></textarea>'
      +'<button id="wmSunCam" class="wmSunBtn" title="'+T("Add a photo or PDF","Agregar foto o PDF")+'" style="background:#16294f;color:#8fb0e6">📎</button>'
      +(SR?'<button id="wmSunMic" class="wmSunBtn" title="'+T("Talk to me","Háblame")+'" style="background:#16294f;color:#8fb0e6">🎤</button>':"")
      +'<button id="wmSunSend" class="wmSunBtn" style="background:linear-gradient(135deg,#1D429B,#F89B24);color:#fff">➤</button></div>';
    document.body.appendChild(panel);
    (function(){ var cam=document.getElementById("wmSunCam"), file=document.getElementById("wmSunFile"); if(cam&&file){ cam.onclick=function(){ file.click(); }; file.onchange=function(){ var f=file.files&&file.files[0]; if(f) sendFile(f); file.value=""; }; } })();
    var greet=addBubble("b",T("Hi, I'm WinMI 🤖 your WindMar assistant! Ask me about any project by DL#, name, or address (Zoho + SiteCapture), or anything about solar, roofing & service. Type, tap 🎤 to talk, or 📎 attach a photo or PDF and I'll read it.","¡Hola! Soy WinMI 🤖 tu asistente WindMar. Pregúntame por cualquier proyecto por DL#, nombre o dirección (Zoho + SiteCapture), o lo que sea de solar, techos y servicio. Escribe, toca 🎤 para hablar, o 📎 adjunta una foto o PDF y lo leo."));
    document.getElementById("wmSunMsgs").appendChild(quickChips());
    document.getElementById("wmSunClose").onclick=closePanel;
    document.getElementById("wmSunSend").onclick=function(){ var i=document.getElementById("wmSunInput"); send(i&&i.value); };
    document.getElementById("wmSunMute").onclick=function(){ muted=!muted; try{localStorage.setItem("wm_sunny_mute",muted?"1":"0");}catch(e){} if(muted)stopSpeak(); this.textContent=muted?"🔇":"🔊"; };
    var inp=document.getElementById("wmSunInput");
    inp.addEventListener("input",function(){ this.style.height="42px"; this.style.height=Math.min(110,this.scrollHeight)+"px"; });
    inp.addEventListener("keydown",function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(this.value); } });
    if(SR) setupMic();
    launch.style.display="none";
  }
  function closePanel(){ stopSpeak(); if(rec){ try{rec.stop();}catch(e){} } if(panel){ panel.remove(); panel=null; } launch.style.display=""; }

  var rec=null, listening=false;
  function setupMic(){ var mic=document.getElementById("wmSunMic"); if(!mic) return;
    mic.onclick=function(){ if(listening){ try{rec.stop();}catch(e){} return; }
      try{ rec=new SR(); }catch(e){ return; } rec.lang=es()?"es-ES":"en-US"; rec.interimResults=true; rec.continuous=false;
      var inp=document.getElementById("wmSunInput");
      rec.onstart=function(){ listening=true; mic.textContent="⏹"; mic.style.background="#B91C1C"; winmiState("listening"); };
      rec.onerror=function(){ winmiState("idle"); };
      rec.onend=function(){ listening=false; mic.textContent="🎤"; mic.style.background="#16294f"; winmiState("idle"); };
      rec.onresult=function(ev){ var t=""; for(var i=0;i<ev.results.length;i++) t+=ev.results[i][0].transcript; if(inp) inp.value=t;
        if(ev.results[ev.results.length-1].isFinal){ var f=t.trim(); if(f){ setTimeout(function(){ send(f); },250); } } };
      stopSpeak(); try{ rec.start(); }catch(e){} };
  }

  // ---- First-visit "how to use" tour (spotlight coach-marks, narrated by Sunny) ----
  function tourSteps(){
    var tabs=document.querySelectorAll("#root .tabbtn, nav .tabbtn");
    function findTab(rx){ for(var i=0;i<tabs.length;i++){ if(rx.test(tabs[i].textContent||"")) return tabs[i]; } return null; }
    var steps=[{ sel:null, title:T("Hey, I'm WinMI! 👋","¡Hola, soy WinMI! 👋"), body:T("Give me ~30 seconds and I'll show you what this app can do. You can skip anytime — let's go!","Dame ~30 segundos y te muestro lo que hace esta app. Puedes saltar cuando quieras. ¡Vamos!") }];
    var add=function(rx,title,body){ var el=findTab(rx); if(el) steps.push({ el:el, title:title, body:body }); };
    add(/itinerary|itinerario/i, T("🏠 Itinerary — your home base","🏠 Itinerario — tu base"),
      T("The 'Needs Attention' board up top shows live crew updates, jobs stuck over 3 days, tomorrow's visits and inspections. Tap a crew update to open it in Zoho and change the stage.","El tablero 'Requiere Atención' muestra actualizaciones de cuadrillas en vivo, trabajos atascados +3 días, visitas de mañana e inspecciones. Toca una actualización para abrirla en Zoho y cambiar la etapa."));
    add(/coordinator|coordinador/i, T("📋 Coordinator — schedule with ease","📋 Coordinador — programa fácil"),
      T("Every job ready to schedule, in one list. Flip to '📍 By Area' and I'll group nearby jobs and give you a one-tap 🧭 Route in Google Maps. Click a job to edit its stage or add a note with photos.","Todos los trabajos listos para programar. Cambia a '📍 Por zona' y agrupo los cercanos con un botón 🧭 Ruta en Google Maps. Toca un trabajo para editar su etapa o agregar una nota con fotos."));
    add(/calendar|calendario/i, T("🗓 Calendar — the whole week","🗓 Calendario — toda la semana"),
      T("See every crew's week — installs ⚡ and services 🔧 by crew and day. Switch to 🗺 Map, Month or List. Tap any job to edit it or read the full work order.","Ve la semana de cada cuadrilla — instalaciones ⚡ y servicios 🔧 por cuadrilla y día. Cambia a 🗺 Mapa, Mes o Lista. Toca un trabajo para editarlo o leer la orden completa."));
    add(/projects|proyectos/i, T("📊 Projects — the pipeline","📊 Proyectos — el flujo"),
      T("Your whole Zoho pipeline by stage. Filter to 🔍 Inspections to see what needs scheduling, then use 'Schedule Nearest Crew' to send the closest crew.","Todo tu flujo de Zoho por etapa. Filtra a 🔍 Inspecciones para ver qué falta programar y usa 'Cuadrilla más cercana' para enviar la más cerca."));
    add(/crews|cuadrillas/i, T("🚚 Crews — live GPS","🚚 Cuadrillas — GPS en vivo"),
      T("Live truck locations for the whole install team. Emergency? Type an address in 'Emergency Dispatch Routing' and I'll find the closest crew + ETA.","Ubicación en vivo de todos los camiones del equipo. ¿Emergencia? Escribe una dirección en 'Ruta de Despacho' y encuentro la cuadrilla más cercana + tiempo estimado."));
    add(/weather|clima/i, T("🌤 Weather — work safe","🌤 Clima — trabaja seguro"),
      T("7-day forecast and safety alerts before rooftop work — plus LOTO steps and bilingual site phrases.","Pronóstico de 7 días y alertas de seguridad antes de trabajar en techo — además pasos LOTO y frases bilingües."));
    add(/sitecapture|site capture/i, T("📷 SiteCapture — photos","📷 SiteCapture — fotos"),
      T("Search a project's photos and details, or create a new SiteCapture project right here.","Busca fotos y detalles de un proyecto, o crea uno nuevo de SiteCapture aquí mismo."));
    add(/install map|mapa de inst/i, T("🗺 Install Map","🗺 Mapa de Instalaciones"),
      T("Every completed install on one map — great for spotting customers near a new job.","Cada instalación completada en un mapa — ideal para ver clientes cerca de un trabajo nuevo."));
    steps.push({ sel:null, title:T("That's the tour! 🎉","¡Ese es el tour! 🎉"),
      body:T("Anytime you need a project status, an NEC code answer, or directions — just tap me and ask, by text or 🎤 voice. Let's power Florida! ⚡","Cuando necesites el estado de un proyecto, una respuesta de código NEC o direcciones — tócame y pregúntame, por texto o 🎤 voz. ¡A energizar Florida! ⚡") });
    return steps;
  }
  function startTour(){ if(panel) closePanel(); stopSpeak(); var steps=tourSteps(), i=0;
    var ov=document.createElement("div"); ov.className="wmTour";
    var hiEl=document.createElement("div"); hiEl.className="wmTourHi"; var card=document.createElement("div"); card.className="wmTourCard";
    ov.appendChild(hiEl); ov.appendChild(card); document.body.appendChild(ov);
    function done(){ try{localStorage.setItem("wm_tour_done","1");}catch(e){} ov.remove(); }
    function show(){ var s=steps[i]; var el=s.el||(s.sel?document.querySelector(s.sel):null);
      if(el){ var r=el.getBoundingClientRect(); hiEl.style.display="block"; hiEl.style.left=(r.left-6)+"px"; hiEl.style.top=(r.top-6)+"px"; hiEl.style.width=(r.width+12)+"px"; hiEl.style.height=(r.height+12)+"px"; }
      else { hiEl.style.display="none"; }
      var cx=window.innerWidth, cy=window.innerHeight; var top, left=Math.max(12,Math.min(cx-302, (el?el.getBoundingClientRect().left:cx/2-145)));
      if(el){ var r2=el.getBoundingClientRect(); top=(r2.bottom+14); if(top>cy-160) top=Math.max(12,r2.top-150); } else { top=cy/2-90; left=cx/2-145; }
      card.style.left=left+"px"; card.style.top=top+"px";
      card.innerHTML='<div style="display:flex;gap:10px;align-items:flex-start"><span style="flex-shrink:0">'+droid(34)+'</span><div><div style="font:800 14px Montserrat,system-ui,sans-serif;color:#fff;margin-bottom:3px">'+s.title+'</div><div style="font:500 12.5px/1.5 Montserrat,system-ui,sans-serif;color:#c7d8f5">'+s.body+'</div></div></div>'
        +'<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px"><button id="wmTourSkip" style="background:transparent;border:none;color:#7fa8e6;font:600 12px Montserrat;cursor:pointer">'+T("Skip","Saltar")+'</button><div style="display:flex;gap:6px;align-items:center"><span style="color:#5f79a8;font-size:11px">'+(i+1)+"/"+steps.length+'</span><button id="wmTourNext" style="background:linear-gradient(135deg,#1D429B,#F89B24);border:none;color:#fff;font:800 12.5px Montserrat;padding:8px 16px;border-radius:10px;cursor:pointer">'+(i===steps.length-1?T("Done","Listo"):T("Next","Siguiente"))+'</button></div></div>';
      if(!reduce) speak(s.title+". "+s.body);
      document.getElementById("wmTourSkip").onclick=function(){ stopSpeak(); done(); };
      document.getElementById("wmTourNext").onclick=function(){ stopSpeak(); i++; if(i>=steps.length){ done(); } else show(); };
    }
    show();
  }

  launch.onclick=openPanel;
  (function mount(){ if(!document.body){ setTimeout(mount,40); return; } document.body.appendChild(launch);
    // First visit: a friendly nudge + offer the tour.
    var seen=true; try{ seen=localStorage.getItem("wm_tour_done")==="1"; }catch(e){}
    if(!seen){ setTimeout(function(){ if(panel) return; hi=document.createElement("div"); hi.className="wmSunHi";
      hi.innerHTML='<b>'+T("Hi, I'm WinMI! 🤖","¡Hola, soy WinMI! 🤖")+'</b><br>'+T("Want a 20-sec tour?","¿Un tour de 20 seg?")
        +'<div style="display:flex;gap:6px;margin-top:8px"><button id="wmHiYes" style="flex:1;background:linear-gradient(135deg,#1D429B,#F89B24);border:none;color:#fff;font:800 11.5px Montserrat;padding:6px;border-radius:8px;cursor:pointer">'+T("Yes!","¡Sí!")+'</button><button id="wmHiNo" style="background:#16294f;border:1px solid #2a4a86;color:#bcd2f5;font:600 11.5px Montserrat;padding:6px 10px;border-radius:8px;cursor:pointer">'+T("Later","Después")+'</button></div>';
      document.body.appendChild(hi);
      document.getElementById("wmHiYes").onclick=function(){ hi.remove(); hi=null; startTour(); };
      document.getElementById("wmHiNo").onclick=function(){ try{localStorage.setItem("wm_tour_done","1");}catch(e){} hi.remove(); hi=null; };
    },1600); }
  })();
})();
