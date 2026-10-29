/* Folio port of the ThreeUI "Ashen Press" art-book shelf.
   Canonical source: src/shaders/ashen-press/sources/ashen-press.html
   SHA-256 5fe2554e578acac5d55cb466a9564440e7767e38797981f8e829dfd2de0bc90f
   The authored module body below is unchanged apart from the edits marked
   "Folio": a local three.js import, bootShelf()/pauseShelf()/resumeShelf()
   lifecycle wrapping, frame-relative pointer maths, inert-when-closed
   listeners, an added keyboard layer (arrows + Enter) and the ten painted
   tool covers (the game plates were removed; the canvas painters now draw
   Folio's own volumes). Every shader, timing constant and interaction is
   the authored code.

   Licensing: Three.js r181 - MIT. The Ashen Press scene - ThreeUI, MIT.
   Inter and EB Garamond - SIL Open Font License (bundled in ../fonts). */
import * as THREE from '../vendor/three.module.js';

/* Folio module plumbing ------------------------------------------- */

let LIVE = false;
let PAUSED = false;
let BOOT_API = null;
let FOLIO_OPEN_TOOL = null;   /* installed by the app; opens a tool view */

export function setToolOpener(fn) { FOLIO_OPEN_TOOL = fn; }
function openTool(id) { if (typeof FOLIO_OPEN_TOOL === 'function') FOLIO_OPEN_TOOL(id); }

const SHELF_FONT_SPECS = [
  "400 16px Inter", "500 16px Inter", "600 16px Inter",
  '400 16px "EB Garamond"', '500 16px "EB Garamond"', '600 16px "EB Garamond"',
  'italic 400 16px "EB Garamond"',
];

/* The canvas covers draw type in these two families; make sure they are
   really loaded before the first cover is painted. */
async function preloadShelfFonts() {
  try {
    await Promise.all(SHELF_FONT_SPECS.map((s) => document.fonts.load(s, "ASHEN PRESS nightreign")));
  } catch { /* best effort: the authored stacks have fallbacks */ }
}

/* Boots the shelf: builds the whole scene once. Safe to call again after
   a dispose; calling it while already live does nothing. */
export async function mountShelf() {
  if (LIVE) return;
  LIVE = true; PAUSED = false;
  await preloadShelfFonts();
  if (!LIVE) return;   /* the view was closed while the fonts loaded */
  try {
    bootShelf();
  } catch (err) {
    LIVE = false;
    if (BOOT_API) { try { BOOT_API.dispose(); } catch { /* nothing built */ } BOOT_API = null; }
    throw err;
  }
}

/* Folio: while a tool view is open (or the tab is hidden) the render loop
   is cancelled but the scene stays in memory, so coming back to the shelf
   is instant. No frame, no raycast and no listener reacts while paused. */
export function pauseShelf() {
  if (!LIVE || PAUSED) return;
  PAUSED = true;
  if (BOOT_API) BOOT_API.pause();
}

export function resumeShelf() {
  if (!LIVE || !PAUSED) return;
  PAUSED = false;
  if (BOOT_API) BOOT_API.resume();
}

export function shelfState() { return { live: LIVE, paused: PAUSED }; }   /* Folio: debug hook for drive */

function bootShelf() {
/* Folio: plumbing for the Shelf view lifecycle (added for the port).
   LIVE is true only while the shelf view is open; every global listener
   below checks it, so a closed shelf never reacts to the page around it. */
const FOLIO_TIMERS = new Set();
function tSet(fn, ms, ...rest){ const id = setTimeout(fn, ms, ...rest); FOLIO_TIMERS.add(id); return id; }
let FOLIO_RAF = 0;
const SHELF = document.getElementById('shelf-root');
const STAGE = document.getElementById('shelf-stage');
const stageRect = () => STAGE.getBoundingClientRect();
const KB = { i: -1 };


/* ════════════════════════════════════════════════════════════════════════
   1 · THE CATALOGUE
   ════════════════════════════════════════════════════════════════════════ */
const K = {
  bookW: 0.887, bookH: 1.33, bookD: 0.17,    // 2:3, the format the plates are shot at
  lean: -0.20, yaw: 0.155,
  bow: 0.0080, chamf: 0.0135, chamfR: 0.022,
  shelfTop: [0.251, -1.241],
  plankHalf: 3.34, plankThick: 0.105, plankDepth: 0.80,
  wallZ: -1.43, bookZ: -1.18,
  slot: 1.235,
  activeDuration: 700, hoverDrop: 400, hoverLift: 1000,
  introStagger: 78, introWallFade: 1000, introFade: 460,
  fov: 20,
  boxX: 5.86, boxY: 3.36, boxCY: 0.06, offset: 1.25, maxWidthPx: 1550,
  orbitAz: 0.085, orbitEl: 0.052,
  activeX: 0.72, activeRot: [0.075, 0.285, 0.0],
  mTilt: -Math.PI/7, mFlat: -0.06,
  mStepZ: 0.15, mStepY: 0.17, mY: 0.30, mZ0: 0.75,
  mFill: 0.62, mDrop: 0.22,
};
const MOBILE_Q = window.matchMedia('(max-width: 767px)');
let MOBILE = MOBILE_Q.matches;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if(REDUCED){ K.introStagger=0; K.introWallFade=260; K.introFade=200;
             K.hoverLift=260; K.hoverDrop=200; K.activeDuration=300;
             K.orbitAz=0; K.orbitEl=0; }

/* Folio: the ten tools, one volume each, in shelf order.
   Row 1 (shelf 0): Merge, Split, Pages, Rotate, Compress
   Row 2 (shelf 1): Text, Watermark, Protect, To PDF, Info
   Cloth colours are per group, five harmonious muted tones; the copy is
   the README table's one-line description. No years, no volume numbers. */
const GROUPS = {
  organize: { name: 'Organize', spine: '#46608a', cloth: '#131722' },
  edit:     { name: 'Edit',     spine: '#66744a', cloth: '#14170e' },
  protect:  { name: 'Protect',  spine: '#7d3538', cloth: '#170f10' },
  convert:  { name: 'Convert',  spine: '#3c6255', cloth: '#0f1613' },
  inspect:  { name: 'Inspect',  spine: '#5a5651', cloth: '#161412' },
};
const BOOKS = [
  { id:'merge', title:'Merge', group:'Organize', g:'organize',
    sub:'COMBINE PDFS IN THE ORDER YOU ARRANGE THEM',
    shelf:0, slot:0, edge:'#e6ddc4',
    blurb:'Combine PDFs in the order you arrange them.' },
  { id:'split', title:'Split', group:'Organize', g:'organize',
    sub:'CUT A PDF INTO PARTS AT LINES YOU CLICK',
    shelf:0, slot:1, edge:'#e9e0c6',
    blurb:'Cut a PDF into parts at lines you click, or one file per page.' },
  { id:'pages', title:'Pages', group:'Organize', g:'organize',
    sub:'TAKE CHOSEN PAGES OUT, OR TAKE THEM AWAY',
    shelf:0, slot:2, edge:'#e4dcc2',
    blurb:'Take chosen pages out, or take them away. Both work on a copy.' },
  { id:'rotate', title:'Rotate', group:'Edit', g:'edit',
    sub:'TURN PAGES BY 90, 180 OR 270 DEGREES',
    shelf:0, slot:3, edge:'#e5decb',
    blurb:'Turn chosen pages by 90°, 180° or 270°.' },
  { id:'compress', title:'Compress', group:'Edit', g:'edit',
    sub:'SHRINK A PDF, LOSSLESS OR STRONG',
    shelf:0, slot:4, edge:'#e2d8c0',
    blurb:'Shrink a PDF (lossless, or Strong with an image-quality trade-off).' },

  { id:'text', title:'Text', group:'Edit', g:'edit',
    sub:'READ THE WORDS, OR REWRITE THEM IN PLACE',
    shelf:1, slot:0, edge:'#e7ddc3',
    blurb:'Read the words in a PDF, or rewrite them in place.' },
  { id:'watermark', title:'Watermark', group:'Edit', g:'edit',
    sub:'STAMP TEXT OR A PICTURE ACROSS THE PAGES',
    shelf:1, slot:1, edge:'#e8e2cc',
    blurb:'Stamp text or a picture across the pages of a copy.' },
  { id:'protect', title:'Protect', group:'Protect', g:'protect',
    sub:'ADD A PASSWORD, OR TAKE ONE OFF',
    shelf:1, slot:2, edge:'#e6dcc2',
    blurb:'Add a password, or make a copy that opens without one.' },
  { id:'to-pdf', title:'To PDF', group:'Convert', g:'convert',
    sub:'TURN DOCUMENTS AND IMAGES INTO PDFS',
    shelf:1, slot:3, edge:'#e3dbc6',
    blurb:'Turn Word, Excel, PowerPoint, image and a few other files into PDFs.' },
  { id:'info', title:'Info', group:'Inspect', g:'inspect',
    sub:'FILE DETAILS: PAGES, SIZE, VERSION, METADATA',
    shelf:1, slot:4, edge:'#ded9c9',
    blurb:'File details: pages, size, version, title and metadata.' },
];
const GROUP_SPINE = id => GROUPS[id].spine;
const GROUP_CLOTH = id => GROUPS[id].cloth;

/* ════════════════════════════════════════════════════════════════════════
   2 · CANVAS HELPERS
   ════════════════════════════════════════════════════════════════════════ */
const TAU = Math.PI*2;
const SANS  = 'Inter,-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif';
const SERIF = '"EB Garamond",Didot,"Bodoni 72",Georgia,"Times New Roman",serif';
const MONO  = 'ui-monospace,"SF Mono",Menlo,Monaco,Consolas,monospace';

const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const lerp  = (a,b,t)=>a+(b-a)*t;
const smooth= t=>t<=0?0:t>=1?1:t*t*(3-2*t);
function mulberry(seed){let a=seed>>>0;return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function C(w,h){const c=document.createElement('canvas');c.width=w;c.height=h===undefined?w:h;return c;}
function rr(g,x,y,w,h,r){r=Math.min(r,w/2,h/2);g.beginPath();g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath();}
function lg(g,x0,y0,x1,y1,stops){const t=g.createLinearGradient(x0,y0,x1,y1);for(const s of stops)t.addColorStop(s[0],s[1]);return t;}
function rg(g,x,y,r0,r1,stops,x1,y1){const t=g.createRadialGradient(x,y,r0,x1===undefined?x:x1,y1===undefined?y:y1,r1);for(const s of stops)t.addColorStop(s[0],s[1]);return t;}
function tracked(g,text,x,y,track,align){
  let w=0;for(const ch of text)w+=g.measureText(ch).width+track;w-=track;
  let cx = align==='center'? x-w/2 : align==='right'? x-w : x;
  const prev=g.textAlign;g.textAlign='left';
  for(const ch of text){g.fillText(ch,cx,y);cx+=g.measureText(ch).width+track;}
  g.textAlign=prev;return w;
}
function fitTracked(g,text,w,weight,family,track){
  let lo=4,hi=3000;
  const meas=px=>{g.font=`${weight} ${px}px ${family}`;let t=0;for(const ch of text)t+=g.measureText(ch).width+track*px;return t-track*px;};
  for(let i=0;i<26;i++){const m=(lo+hi)/2;if(meas(m)>w)hi=m;else lo=m;}
  g.font=`${weight} ${lo}px ${family}`;return lo;
}
function grain(g,W,H,amount,seed){
  const r=mulberry(seed||7);const img=g.getImageData(0,0,W,H),d=img.data;
  for(let i=0;i<d.length;i+=4){const n=(r()-0.5)*amount;d[i]+=n;d[i+1]+=n;d[i+2]+=n;}
  g.putImageData(img,0,0);
}
function cloth(g,W,H,seed,amt){
  const r=mulberry(seed||3);
  g.save();g.globalAlpha=amt===undefined?.05:amt;
  for(let y=0;y<H;y+=3){g.fillStyle=r()>.5?'#fff':'#000';g.fillRect(0,y,W,1);}
  for(let x=0;x<W;x+=3){g.fillStyle=r()>.5?'#fff':'#000';g.fillRect(x,0,1,H);}
  g.restore();
}
function rule(g,x0,y0,x1,y1,col,w){g.strokeStyle=col;g.lineWidth=w;g.beginPath();g.moveTo(x0,y0);g.lineTo(x1,y1);g.stroke();}

/* Folio: the game plates and publisher stamps are gone. The covers are
   painted here with the same canvas approach the plates used: cloth from
   the group colour, a hairline foil frame, one geometric emblem per tool
   and the embossed tool name. Nothing is loaded; every stroke is local. */

const FOIL = '#efe4cc';

/* ---- one geometric emblem per tool, drawn as line art ----
   The glyph is centred on (cx,cy) inside a box of size s. */
function emblem(g, id, cx, cy, s, ink, lw){
  g.save();
  g.strokeStyle=ink; g.fillStyle=ink; g.lineWidth=lw;
  g.lineCap='round'; g.lineJoin='round';
  const u=s/100, X=x=>cx+x*u, Y=y=>cy+y*u;
  const line=(a,b,c,d)=>{g.beginPath();g.moveTo(X(a),Y(b));g.lineTo(X(c),Y(d));g.stroke();};
  const box=(x,y,w,h)=>{g.beginPath();g.rect(X(x),Y(y),w*u,h*u);g.stroke();};
  const arc=(x,y,r,a0,a1)=>{g.beginPath();g.arc(X(x),Y(y),r*u,a0,a1);g.stroke();};
  const dot=(x,y,r)=>{g.beginPath();g.arc(X(x),Y(y),r*u,0,TAU);g.fill();};
  switch(id){
    case 'merge':       // two sheets meeting on a seam
      box(-46,-32,38,64); box(8,-32,38,64);
      line(0,-44,0,44);
      break;
    case 'split':       // a page and a cut line through it
      box(-30,-42,60,84);
      g.setLineDash([lw*2.4,lw*2.4]);
      line(-50,0,50,0);
      g.setLineDash([]);
      break;
    case 'pages':       // two sheets, one pulled out in front
      box(-40,-42,56,84);
      box(-2,-14,46,56);
      break;
    case 'rotate':      // a page with a turn arrow
      box(-26,-40,52,80);
      arc(0,0,62,Math.PI*0.85,Math.PI*2.15);
      g.beginPath();
      g.moveTo(X(66),Y(-26)); g.lineTo(X(52),Y(-34)); g.lineTo(X(52),Y(-16));
      g.closePath(); g.fill();
      break;
    case 'compress':    // arrows squeezing a sheet
      box(-22,-42,44,84);
      line(-64,0,-34,0); line(-44,-10,-34,0); line(-44,10,-34,0);
      line(64,0,34,0);  line(44,-10,34,0);   line(44,10,34,0);
      break;
    case 'text':        // a pen nib
      g.beginPath();
      g.moveTo(X(0),Y(-44));
      g.lineTo(X(30),Y(4));
      g.lineTo(X(0),Y(40));
      g.lineTo(X(-30),Y(4));
      g.closePath(); g.stroke();
      dot(0,0,5);
      line(0,5,0,34);
      break;
    case 'watermark':   // a rubber stamp and its mark
      arc(0,-30,18,Math.PI,0);
      line(-18,-30,-18,-6); line(18,-30,18,-6);
      box(-44,-6,88,16);
      line(-52,30,-22,30); line(22,30,52,30);
      break;
    case 'protect':     // padlock
      arc(0,-16,24,Math.PI,0);
      line(-24,-16,-24,6); line(24,-16,24,6);
      box(-38,6,76,44);
      dot(0,26,7);
      break;
    case 'to-pdf':      // a document feeding an arrow
      box(-46,-30,44,60);
      line(2,0,44,0); line(32,-11,44,0); line(32,11,44,0);
      break;
    case 'info':        // a circled i
      arc(0,0,56,0,TAU);
      dot(0,-26,5);
      line(0,-10,0,26);
      break;
  }
  g.restore();
}

function paintCover(b,W,H){
  const c=C(W,H),g=c.getContext('2d');
  g.fillStyle=GROUP_CLOTH(b.g);g.fillRect(0,0,W,H);
  // soft sheen from above, like light off the shelf plank
  g.fillStyle=rg(g,W*.5,-H*.12,W*.04,W*1.15,[[0,'rgba(255,255,255,.09)'],[1,'rgba(0,0,0,0)']]);
  g.fillRect(0,0,W,H);
  cloth(g,W,H,(b.id.length*13+7),.05);
  // hairline foil frame
  g.strokeStyle='rgba(239,228,204,.30)';g.lineWidth=W*.0032;
  g.strokeRect(W*.052,H*.038,W*.896,H*.924);
  // group label
  g.textAlign='center';g.textBaseline='alphabetic';
  g.font=`500 ${W*.0215}px ${SANS}`;g.fillStyle='rgba(240,231,212,.60)';
  tracked(g,b.group.toUpperCase(),W*.5,H*.098,W*.0215*.24,'center');
  // emblem
  emblem(g,b.id,W*.5,H*.40,W*.44,'rgba(239,228,204,.85)',W*.0075);
  // embossed title
  const fam='"EB Garamond",Georgia,serif';
  const t=b.title.toUpperCase();
  const ts=fitTracked(g,t,W*.78,'500',fam,0.075);
  const ty=H*.745;
  g.fillStyle='rgba(0,0,0,.50)';      tracked(g,t,W*.5,ty+ts*.05,ts*0.075,'center');
  g.fillStyle='rgba(255,255,255,.10)';tracked(g,t,W*.5,ty-ts*.04,ts*0.075,'center');
  g.fillStyle=FOIL;                   tracked(g,t,W*.5,ty,ts*0.075,'center');
  rule(g,W*.32,H*.782,W*.68,H*.782,'rgba(239,228,204,.42)',W*.0026);
  // foot
  g.font=`400 ${W*.0195}px ${SANS}`;g.fillStyle='rgba(240,231,212,.62)';
  tracked(g,'FOLIO',W*.5,H*.902,W*.0195*.42,'center');
  grain(g,W,H,6,b.id.length*37+5);
  return c;
}

/* ---------- back cover, spine, page block ---------- */
function isLight(hex){
  const n=parseInt(hex.slice(1),16);
  return (((n>>16&255)*.299+(n>>8&255)*.587+(n&255)*.114))>150;
}
function artBack(b,W,H){
  const c=C(W,H),g=c.getContext('2d'),r=mulberry(b.id.length*911+7);
  const light=isLight(GROUP_CLOTH(b.g));
  const ink = light? '#26221c' : '#efe8da';
  g.fillStyle=GROUP_CLOTH(b.g);g.fillRect(0,0,W,H);
  g.fillStyle=rg(g,W*.5,H*.34,W*.05,W*.95,
    [[0,light?'rgba(255,255,255,.55)':'rgba(255,255,255,.10)'],[1,'rgba(0,0,0,0)']]);
  g.fillRect(0,0,W,H);
  // three figures of the same subject, like plates out of a book
  const scales=[1.00,0.70,1.22];
  for(let i=0;i<3;i++){
    const x=W*(.10+i*.28), y=H*.115, w=W*.24, h=w*1.14;
    g.fillStyle=light?'#e7dfca':'#e9e2cf';g.fillRect(x,y,w,h);
    g.fillStyle='rgba(0,0,0,.05)';g.fillRect(x,y+h-h*.05,w,h*.05);
    emblem(g,b.id,x+w/2,y+h/2,w*scales[i]*0.62,'#2a251d',Math.max(1,w*.016));
    g.globalAlpha=.16;g.fillStyle=GROUP_CLOTH(b.g);g.fillRect(x,y,w,h);g.globalAlpha=1;
    g.strokeStyle=light?'rgba(40,34,28,.35)':'rgba(240,232,218,.28)';g.lineWidth=W*.0025;
    g.strokeRect(x,y,w,h);
  }
  g.fillStyle=ink;g.globalAlpha=.55;g.font=`400 ${W*.017}px ${MONO}`;g.textAlign='left';
  g.fillText('FIG. '+(21+22*b.title.length)+'–'+(180+31*b.title.length),W*.10,H*.415);
  g.globalAlpha=1;
  // the one line from the README table
  g.font=`400 ${W*.030}px ${SERIF}`;g.fillStyle=ink;
  const words=b.blurb.split(' ');let line='',y=H*.505;
  for(const w0 of words){
    const t=line?line+' '+w0:w0;
    if(g.measureText(t).width>W*.80){g.fillText(line,W*.10,y);line=w0;y+=W*.042;}
    else line=t;
  }
  g.fillText(line,W*.10,y);
  g.globalAlpha=.7;g.font=`400 ${W*.020}px ${SANS}`;
  tracked(g,`${b.group.toUpperCase()} · FOLIO`,W*.10,y+W*.075,W*.020*.18,'left');
  g.globalAlpha=1;
  // house roundel
  g.save();g.translate(W*.13,H*.855);
  g.strokeStyle=ink;g.globalAlpha=.55;g.lineWidth=W*.0035;
  g.beginPath();g.arc(0,0,W*.058,0,TAU);g.stroke();
  g.globalAlpha=1;g.fillStyle=ink;
  g.font=`500 ${W*.030}px ${SERIF}`;g.textAlign='center';g.textBaseline='middle';
  g.fillText('F',0,W*.002);g.restore();
  g.textAlign='left';g.textBaseline='alphabetic';
  g.fillStyle=ink;g.font=`500 ${W*.022}px ${SANS}`;
  tracked(g,'FOLIO',W*.215,H*.845,W*.022*.30,'left');
  g.globalAlpha=.6;g.font=`400 ${W*.020}px ${SANS}`;
  g.fillText('PDF tools, kept offline',W*.215,H*.875);
  g.globalAlpha=1;
  // barcode
  const bx=W*.60,by=H*.815,bw=W*.30,bh=H*.085;
  g.fillStyle=light?'#ffffff':'#f2ece0';g.fillRect(bx,by,bw,bh);
  g.fillStyle='#15120f';
  let px=bx+bw*.04;
  while(px<bx+bw*.96){const w=W*(.002+ (r()<.3?.006:.002)*r()*3);g.fillRect(px,by+bh*.10,w,bh*.66);px+=w+W*(.002+r()*.004);}
  g.font=`400 ${W*.017}px ${MONO}`;g.textAlign='center';
  g.fillText('9 7'+(100000000+((r()*899999999)|0)),bx+bw/2,by+bh*.93);
  grain(g,W,H,8,5);
  return c;
}
function artSpine(b,W,H){
  const c=C(W,H),g=c.getContext('2d');
  const spineCol=GROUP_SPINE(b.g);
  const light=isLight(spineCol);
  const ink=light?'#26221c':'#f3ece0';
  g.fillStyle=spineCol;g.fillRect(0,0,W,H);
  g.strokeStyle=ink;g.globalAlpha=.5;g.lineWidth=W*.035;
  g.beginPath();g.moveTo(W*.22,H*.052);g.lineTo(W*.78,H*.052);g.stroke();
  g.beginPath();g.moveTo(W*.22,H*.912);g.lineTo(W*.78,H*.912);g.stroke();
  g.globalAlpha=1;
  g.save();g.translate(W*.52,H*.085);g.rotate(Math.PI/2);
  g.textAlign='left';g.textBaseline='middle';
  const t=b.title.toUpperCase();
  const ts=fitTracked(g,t,H*.56,'500','"EB Garamond",Georgia,serif',0.07);
  g.fillStyle='rgba(0,0,0,.50)';      tracked(g,t,0,ts*.05,ts*0.07,'left');
  g.fillStyle='rgba(255,255,255,.10)';tracked(g,t,0,-ts*.04,ts*0.07,'left');
  g.fillStyle=ink;                    tracked(g,t,0,0,ts*0.07,'left');
  g.globalAlpha=.72;g.font=`400 ${W*.16}px ${SANS}`;
  tracked(g,b.group.toUpperCase(),H*.64,0,W*.16*.2,'left');
  g.restore();
  g.globalAlpha=1;g.fillStyle=ink;
  g.textAlign='center';g.textBaseline='middle';
  g.font=`500 ${W*.30}px ${SERIF}`;
  g.fillText('F',W*.52,H*.955);
  return c;
}

/* ---------- oak ---------- */
function woodTexture(px){
  const W=px, Hh=Math.round(px*0.5);
  const c=C(W,Hh),g=c.getContext('2d'),r=mulberry(909);
  g.fillStyle='#7d5228';g.fillRect(0,0,W,Hh);
  // sapwood/heartwood drift, kept low-contrast so it never reads as plywood
  for(let i=0;i<14;i++){
    g.fillStyle=`rgba(${146+r()*40|0},${98+r()*26|0},${48+r()*22|0},${.06+r()*.09})`;
    g.beginPath();g.ellipse(r()*W,r()*Hh,W*(.10+r()*.30),Hh*(.06+r()*.20),0,0,TAU);g.fill();
  }
  // the grain itself: many tight, slightly wandering lines
  for(let i=0;i<430;i++){
    const y0=r()*Hh, amp=Hh*(.004+r()*.020), f=0.6+r()*2.2, ph=r()*TAU;
    const dark=r()<.34;
    g.strokeStyle=dark
      ? `rgba(${38+r()*26|0},${22+r()*16|0},${9+r()*10|0},${.36+r()*.55})`
      : `rgba(${186+r()*40|0},${138+r()*32|0},${80+r()*26|0},${.14+r()*.32})`;
    g.lineWidth=dark?(0.8+r()*1.8):(0.8+r()*2.6);
    g.beginPath();
    for(let x=0;x<=W;x+=8){
      const y=y0+Math.sin(x/W*TAU*f+ph)*amp+Math.sin(x/W*TAU*f*2.7+ph*2)*amp*.4;
      x?g.lineTo(x,y):g.moveTo(x,y);
    }
    g.stroke();
  }
  // cathedral figure — a few nested arcs, low contrast
  for(let k=0;k<4;k++){
    const cx=W*(.1+r()*.8), cy=Hh*(.15+r()*.7), sw=W*(.02+r()*.05);
    for(let i=0;i<14;i++){
      g.strokeStyle=`rgba(${62+r()*26|0},${38+r()*18|0},${16+r()*12|0},${.12+r()*.20})`;
      g.lineWidth=0.8+r()*1.6;
      g.beginPath();
      g.moveTo(cx-sw*(1+i*.30),cy+Hh*.5);
      g.quadraticCurveTo(cx,cy-Hh*(.12+i*.05),cx+sw*(1+i*.30),cy+Hh*.5);
      g.stroke();
    }
  }
  // medullary rays + open pores
  for(let i=0;i<520;i++){
    g.fillStyle=`rgba(${208+r()*26|0},${172+r()*28|0},${118+r()*28|0},${.05+r()*.15})`;
    g.fillRect(r()*W,r()*Hh,1+r()*2,Hh*(.01+r()*.05));
  }
  for(let i=0;i<9000;i++){
    g.fillStyle=`rgba(${44+r()*28|0},${26+r()*16|0},${10+r()*10|0},${.12+r()*.34})`;
    g.fillRect(r()*W,r()*Hh,1+r()*4,1);
  }
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;
  return t;
}

/* ---------- limewashed wall, baked ---------- */
const WALL = {x0:-9.15,x1:9.15,y0:-9.67,y1:8.63};
const WT = {
  peak:231, bell:15, bellR:4.6, rightLift:4,
  vFall:20, vStart:0.70, vRange:3.2,
  bounce:38, bounceR:2.70, bouncePow:2.6,
  shTop:0.45, shTopR:2.40, shPow:2.3, shRightMul:0.68,
  shBot:0.50, shBotR:2.70, shBotRightMul:0.90,
  plankHalf:3.34, plankFeather:1.70,
  shLeft:-5.20, shLeftFeather:2.60, shRight:2.40, shRightFeather:2.40,
  tint:[1.0,0.876,0.726],       // kraft paper
};
/* tiling paper tooth — fibres, mottle and a fine grain */
function paperTexture(px){
  const c=C(px,px),g=c.getContext('2d'),r=mulberry(2027);
  g.fillStyle='#808080';g.fillRect(0,0,px,px);
  for(let i=0;i<70;i++){
    g.fillStyle=`rgba(${r()<.5?255:0},${r()<.5?255:0},${r()<.5?255:0},${.012+r()*.03})`;
    g.beginPath();g.ellipse(r()*px,r()*px,px*(.05+r()*.28),px*(.04+r()*.22),r()*TAU,0,TAU);g.fill();
  }
  for(let i=0;i<5200;i++){
    const x=r()*px,y=r()*px,l=1+r()*px*0.035,a=r()*TAU;
    g.strokeStyle=r()<.5?`rgba(255,255,255,${.03+r()*.11})`:`rgba(0,0,0,${.03+r()*.13})`;
    g.lineWidth=r()<.85?1:2;
    g.beginPath();g.moveTo(x,y);g.lineTo(x+Math.cos(a)*l,y+Math.sin(a)*l);g.stroke();
  }
  const img=g.getImageData(0,0,px,px),d=img.data;
  for(let i=0;i<d.length;i+=4){const n=(r()-0.5)*40;d[i]+=n;d[i+1]+=n;d[i+2]+=n;}
  g.putImageData(img,0,0);
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;
  t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;
  return t;
}
function wallTexture(px){
  const c=C(px,px),g=c.getContext('2d');
  const Ww=WALL.x1-WALL.x0, Hh=WALL.y1-WALL.y0;
  const img=g.createImageData(px,px), d=img.data;
  const PT=K.shelfTop, PB=[K.shelfTop[0]-K.plankThick, K.shelfTop[1]-K.plankThick];
  const sm=t=>t<=0?0:t>=1?1:t*t*(3-2*t);
  const r=mulberry(5);
  for(let j=0;j<px;j++){
    const y = WALL.y1 - (j+0.5)/px*Hh;
    for(let i=0;i<px;i++){
      const x = WALL.x0 + (i+0.5)/px*Ww;
      const ax=Math.abs(x)/WT.bellR;
      let L = WT.peak - WT.bell*ax*ax + WT.rightLift*clamp(x/4,0,1);
      L -= WT.vFall*sm((WT.vStart-y)/WT.vRange)*sm((-x+2.8)/8.6);
      const inPlank = 1-sm((Math.abs(x)-WT.plankHalf)/WT.plankFeather);
      const inShadow = sm((x-WT.shLeft)/WT.shLeftFeather)*(1-sm((x-WT.shRight)/WT.shRightFeather));
      for(const pt of PT){
        const dy=y-pt; if(dy<0||dy>WT.bounceR) continue;
        L += WT.bounce*Math.pow(1-dy/WT.bounceR,WT.bouncePow)*inPlank;
      }
      const rb=sm((x+4.8)/9.6);
      let dy=PB[0]-y;
      if(dy>0&&dy<WT.shTopR) L *= 1-WT.shTop*(1-(1-WT.shRightMul)*rb)*Math.pow(1-dy/WT.shTopR,WT.shPow)*inShadow;
      dy=PB[1]-y;
      if(dy>0&&dy<WT.shBotR) L *= 1-WT.shBot*(1-(1-WT.shBotRightMul)*rb)*Math.pow(1-dy/WT.shBotR,WT.shPow)*inShadow;
      // the uprights sit proud of the wall and drop a soft edge shadow
      for(const ux of [-3.40,3.40]){
        const dx=x-ux;
        const s=Math.exp(-Math.pow((dx+ (ux<0?0.30:-0.06))/0.40,2));
        const band=sm((y+3.6)/1.6)*(1-sm((y-1.9)/1.7));   // no hard ends
        L *= 1-0.30*s*band;
      }
      const o=(j*px+i)*4;
      const n=(r()-0.5)*5;            // limewash tooth
      d[o]  =clamp((L+n)*WT.tint[0],0,255);
      d[o+1]=clamp((L+n)*WT.tint[1],0,255);
      d[o+2]=clamp((L+n)*WT.tint[2],0,255);
      d[o+3]=255;
    }
  }
  g.putImageData(img,0,0);
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;
  t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;
  return t;
}

/* ════════════════════════════════════════════════════════════════════════
   4 · THE ROOM
   ════════════════════════════════════════════════════════════════════════ */
const canvas   = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({canvas,antialias:false,alpha:false,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setClearColor(0xc6ae8e,1);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(K.fov,1,0.2,100);
const LAY_BG = 0, LAY_FG = 1;
const books = [];

/* ---- wall ---- */
const wallMat = new THREE.ShaderMaterial({
  transparent:true,
  uniforms:{uBake:{value:wallTexture(1024)},uPaper:{value:paperTexture(512)},uOpacity:{value:0}},
  vertexShader:`varying vec2 vUv; void main(){vUv=uv;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader:`
    uniform sampler2D uBake; uniform sampler2D uPaper; uniform float uOpacity;
    varying vec2 vUv;
    void main(){
      vec3 bake=texture2D(uBake,vUv).rgb;
      float fine=texture2D(uPaper,vUv*13.0).r;
      float mid =texture2D(uPaper,vUv*3.1+vec2(0.37,0.19)).r;
      vec3 col=bake*(0.86+0.28*fine)*(0.93+0.14*mid);
      gl_FragColor=vec4(col,uOpacity);
      #include <colorspace_fragment>
    }`});
const wall = new THREE.Mesh(new THREE.PlaneGeometry(WALL.x1-WALL.x0,WALL.y1-WALL.y0),wallMat);
wall.position.set(0,(WALL.y0+WALL.y1)/2,K.wallZ);
scene.add(wall);

/* ---- oak ---- */
const WOOD_TEX = woodTexture(1024);
function oakMaterial(axis){
  return new THREE.ShaderMaterial({
    transparent:true,
    uniforms:{uWood:{value:WOOD_TEX},uOpacity:{value:0},uAxis:{value:axis||0}},
    vertexShader:`
      varying vec3 vP; varying vec3 vN;
      void main(){ vP=position; vN=normalize(normalMatrix*normal);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader:`
      uniform sampler2D uWood; uniform float uOpacity; uniform float uAxis;
      varying vec3 vP; varying vec3 vN;
      void main(){
        vec3 n=normalize(vN), an=abs(n);
        vec2 uvH, uvV, uvE;
        if(uAxis<0.5){                       // grain runs along X (shelves)
          uvH=vec2(vP.x*0.140, vP.z*0.30);
          uvV=vec2(vP.x*0.140, vP.y*0.44);
          uvE=vec2(vP.z*0.30,  vP.y*0.44);
        } else {                             // grain runs along Y (uprights)
          uvH=vec2(vP.y*0.100, vP.z*0.30);
          uvV=vec2(vP.y*0.100, vP.x*0.55);
          uvE=vec2(vP.z*0.30,  vP.x*0.55);
        }
        vec2 uv=mix(mix(uvV,uvH,an.y),uvE,an.x);
        vec3 wood=texture2D(uWood,uv).rgb;
        float up=max(n.y,0.0), dn=max(-n.y,0.0), fwd=max(n.z,0.0), side=abs(n.x);
        float t = 1.22*up + 0.14*dn + 0.86*fwd + 0.48*side;
        float ao = mix(0.66,1.0, clamp((vP.z+0.42)/0.66,0.0,1.0));
        t *= mix(1.0, ao, up);
        t *= mix(0.88,1.0, 1.0-pow(clamp(abs(vP.x)/3.34,0.0,1.0),8.0));
        vec3 col = wood*t;
        // planed arris catching the light along the front top edge
        float arris = smoothstep(0.30,0.50,vP.z*2.0+0.5)*pow(clamp(n.z,0.0,1.0),1.5);
        col += vec3(0.10,0.082,0.055)*arris;
        col += vec3(0.05,0.040,0.026)*pow(clamp(n.z,0.0,1.0),5.0);    // satin sheen
        gl_FragColor=vec4(col,uOpacity);
        #include <colorspace_fragment>
      }`});
}
const oakH = oakMaterial(0), oakV = oakMaterial(1);
const furniture = new THREE.Group();
scene.add(furniture);
function plank(yTop){
  const m=new THREE.Mesh(new THREE.BoxGeometry(K.plankHalf*2,K.plankThick,K.plankDepth),oakH);
  m.position.set(0,yTop-K.plankThick/2,K.wallZ+K.plankDepth/2);
  return m;
}
function upright(x){
  const h=3.72;
  const m=new THREE.Mesh(new THREE.BoxGeometry(0.095,h,K.plankDepth),oakV);
  m.position.set(x,-0.10,K.wallZ+K.plankDepth/2);
  return m;
}
furniture.add(plank(K.shelfTop[0]),plank(K.shelfTop[1]),upright(-3.385),upright(3.385));

/* ---- shadow sprites ---- */
function shadowTex(){
  const P=256,c=C(P),g=c.getContext('2d');
  g.fillStyle='#000';g.filter=`blur(${P*0.135}px)`;
  const pad=P*0.225;g.fillRect(pad,pad,P-pad*2,P-pad*2);g.filter='none';
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
}
function contactTex(){
  const W=256,H=96,c=C(W,H),g=c.getContext('2d');
  const gr=lg(g,0,0,0,H,[[0,'rgba(0,0,0,1)'],[.06,'rgba(0,0,0,.98)'],[.16,'rgba(0,0,0,.80)'],
                         [.38,'rgba(0,0,0,.42)'],[.70,'rgba(0,0,0,.13)'],[1,'rgba(0,0,0,0)']]);
  g.fillStyle=gr;g.fillRect(0,0,W,H);
  g.globalCompositeOperation='destination-out';
  g.fillStyle=lg(g,0,0,W,0,[[0,'rgba(0,0,0,1)'],[.05,'rgba(0,0,0,.70)'],[.11,'rgba(0,0,0,.24)'],
                            [.18,'rgba(0,0,0,0)'],[.82,'rgba(0,0,0,0)'],[.89,'rgba(0,0,0,.24)'],
                            [.95,'rgba(0,0,0,.70)'],[1,'rgba(0,0,0,1)']]);
  g.fillRect(0,0,W,H);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
}
function creaseTex(){
  const W=256,H=64,c=C(W,H),g=c.getContext('2d');
  g.fillStyle=lg(g,0,H,0,0,[[0,'rgba(0,0,0,1)'],[.22,'rgba(0,0,0,.66)'],
                            [.55,'rgba(0,0,0,.22)'],[1,'rgba(0,0,0,0)']]);
  g.fillRect(0,0,W,H);
  g.globalCompositeOperation='destination-out';
  g.fillStyle=lg(g,0,0,W,0,[[0,'rgba(0,0,0,1)'],[.14,'rgba(0,0,0,.35)'],[.30,'rgba(0,0,0,0)'],
                            [.70,'rgba(0,0,0,0)'],[.86,'rgba(0,0,0,.35)'],[1,'rgba(0,0,0,1)']]);
  g.fillRect(0,0,W,H);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
}
const SHADOW_TEX=shadowTex(), CONTACT_TEX=contactTex(), CREASE_TEX=creaseTex();

/* ---- cover surface: printed board under a satin varnish ---- */
const BOARD_FN = `
  // height field of a bound board: a shallow bulge that falls into a crisp chamfer
  float board(vec2 t){
    vec2 c=t*2.0-1.0;
    float bulge=(1.0-c.x*c.x)*(1.0-0.55*c.y*c.y);
    float e=clamp(min(min(t.x,1.0-t.x),min(t.y,1.0-t.y))/uER,0.0,1.0);
    float roll=sqrt(max(1.0-(1.0-e)*(1.0-e),0.0));   // quarter round, sharp at the lip
    return uBow*bulge*roll-uChamf*(1.0-roll);
  }`;
const COVER_VS = `
  uniform float uBow, uChamf, uER, uW, uH;
  varying vec2 vUv; varying vec3 vT, vB2, vNf; varying vec3 vWV;
  ${BOARD_FN}
  void main(){
    vUv=uv;
    vec3 pos=position; pos.z+=board(uv);
    mat3 M=mat3(modelMatrix);
    vT=normalize(M*vec3(1.0,0.0,0.0));
    vB2=normalize(M*vec3(0.0,1.0,0.0));
    vNf=normalize(M*vec3(0.0,0.0,1.0));
    vec4 wp=modelMatrix*vec4(pos,1.0);
    vWV=cameraPosition-wp.xyz;
    gl_Position=projectionMatrix*viewMatrix*wp; }`;
const COVER_FS = `
  uniform sampler2D uTex; uniform float uSatin; uniform float uOpacity; uniform float uSeed;
  uniform float uBow, uChamf, uER, uW, uH;
  varying vec2 vUv; varying vec3 vT, vB2, vNf; varying vec3 vWV;
  ${BOARD_FN}
  float hash(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
    p3+=dot(p3,p3.yxz+33.33); return fract((p3.x+p3.y)*p3.z); }
  float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
  void main(){
    vec2 uv=clamp(vUv,0.0008,0.9992);
    vec4 tex=texture2D(uTex,uv);

    // the board normal is evaluated per pixel, so the chamfer stays crisp
    // however coarse the mesh is
    float d=0.0016;
    float hx=(board(uv+vec2(d,0.0))-board(uv-vec2(d,0.0)))/(2.0*d*uW);
    float hy=(board(uv+vec2(0.0,d))-board(uv-vec2(0.0,d)))/(2.0*d*uH);

    // linen tooth, as a small extra slope
    vec2 q=uv*vec2(58.0,78.0)+uSeed;
    float tooth=vnoise(q)*0.6+vnoise(q*2.7)*0.4;
    vec2 g2=uv*9.0+uSeed;
    float n1=vnoise(g2), e=0.02;
    vec2 grain=vec2(vnoise(g2+vec2(e,0.0))-n1, vnoise(g2+vec2(0.0,e))-n1)/e;

    vec3 N=normalize(vNf
      - vT*(hx + (grain.x*0.0022+(tooth-0.5)*0.009)*uSatin)
      - vB2*(hy + (grain.y*0.0022+(tooth-0.5)*0.009)*uSatin));
    vec3 V=normalize(vWV);

    // one key from above and to the right, a broad fill bounced off the paper wall
    vec3 L=normalize(vec3(0.52,0.70,0.55));
    vec3 F=normalize(vec3(-0.35,-0.18,0.92));
    float key=max(dot(N,L),0.0);
    float fill=max(dot(N,F),0.0);
    float shade=0.70+0.34*key+0.14*fill;
    vec3 col=tex.rgb*shade;

    // a tight specular that only fires on the chamfer, plus a broad satin lobe
    vec3 Hv=normalize(L+V);
    float nh=max(dot(N,Hv),0.0);
    col+=vec3(pow(nh,110.0)*0.85*uSatin);
    col+=vec3(pow(nh,14.0)*0.045*uSatin);
    float fres=pow(1.0-max(dot(N,V),0.0),3.4);
    col+=vec3(fres*0.055*uSatin);
    col+=vec3((tooth-0.5)*0.010*uSatin);

    gl_FragColor=vec4(min(col,vec3(1.0)),uOpacity);
    #include <colorspace_fragment>
  }`;
const SPINE_VS = `
  uniform float uHD;
  varying vec2 vUv; varying vec3 vNw, vTw, vBw, vWV; varying float vZ;
  void main(){
    vUv=uv;
    mat3 M=mat3(modelMatrix);
    vNw=normalize(M*normal);
    vTw=normalize(M*vec3(0.0,0.0,1.0));   // across the back
    vBw=normalize(M*vec3(0.0,1.0,0.0));   // head to tail
    vZ=position.z/uHD;
    vec4 wp=modelMatrix*vec4(position,1.0);
    vWV=cameraPosition-wp.xyz;
    gl_Position=projectionMatrix*viewMatrix*wp; }`;
const SPINE_FS = `
  uniform sampler2D uTex; uniform float uOpacity; uniform float uSeed; uniform float uSatin;
  varying vec2 vUv; varying vec3 vNw, vTw, vBw, vWV; varying float vZ;
  float hash(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
    p3+=dot(p3,p3.yxz+33.33); return fract((p3.x+p3.y)*p3.z); }
  float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
  void main(){
    vec4 tex=texture2D(uTex,clamp(vUv,0.0015,0.9985));
    float t=clamp(vZ,-1.0,1.0);
    // a hollow back: nearly flat down the middle, turning hard into the joints.
    // swept as an angle rather than a slope so the normal can reach the joints
    float ang=1.15*sign(t)*pow(abs(t),1.25);

    vec2 q=vUv*vec2(11.0,78.0)+uSeed;
    float tooth=vnoise(q)*0.6+vnoise(q*2.7)*0.4;
    vec3 N=normalize(vNw*cos(ang) + vTw*sin(ang)
                     + (vTw*0.009+vBw*0.009)*(tooth-0.5)*uSatin);
    vec3 V=normalize(vWV);

    vec3 L=normalize(vec3(0.52,0.70,0.55));
    vec3 F=normalize(vec3(-0.35,-0.18,0.92));
    float shade=0.70+0.34*max(dot(N,L),0.0)+0.14*max(dot(N,F),0.0);
    shade*=1.0-0.16*smoothstep(0.78,1.0,abs(t));      // the joint grooves
    vec3 col=tex.rgb*shade;

    // the key sits off to the right, so on the back it only ever grazes the
    // front joint — the bounce off the paper wall is what rakes the round
    vec3 Hv=normalize(L+V), Hf=normalize(F+V);
    float nh=max(dot(N,Hv),0.0), nf=max(dot(N,Hf),0.0);
    col+=vec3(pow(nh,110.0)*0.55*uSatin);
    col+=vec3(pow(nh,14.0)*0.045*uSatin);
    col+=vec3(pow(nf,46.0)*0.150*uSatin);
    col+=vec3(pow(nf,9.0)*0.032*uSatin);
    col+=vec3(pow(1.0-max(dot(N,V),0.0),3.4)*0.055*uSatin);
    col+=vec3((tooth-0.5)*0.010*uSatin);

    gl_FragColor=vec4(min(col,vec3(1.0)),uOpacity);
    #include <colorspace_fragment>
  }`;
function spineMaterial(tex,seed){
  return new THREE.ShaderMaterial({transparent:true,
    uniforms:{uTex:{value:tex},uOpacity:{value:0},uSeed:{value:seed},
              uSatin:{value:1.0},uHD:{value:K.bookD*0.5}},
    vertexShader:SPINE_VS,fragmentShader:SPINE_FS});
}
function pagesMaterial(col){
  return new THREE.ShaderMaterial({
    transparent:true,
    uniforms:{uCol:{value:new THREE.Color(col)},uOpacity:{value:0},uH:{value:K.bookH*0.5}},
    vertexShader:`
      varying vec3 vP; varying vec3 vNw; varying vec3 vWV;
      void main(){ vP=position; vNw=normalize(mat3(modelMatrix)*normal);
        vec4 wp=modelMatrix*vec4(position,1.0);
        vWV=cameraPosition-wp.xyz;
        gl_Position=projectionMatrix*viewMatrix*wp; }`,
    fragmentShader:`
      uniform vec3 uCol; uniform float uOpacity; uniform float uH;
      varying vec3 vP; varying vec3 vNw; varying vec3 vWV;
      void main(){
        float f=vP.z*210.0;
        float w=fwidth(f);
        float line=0.5+0.5*cos(f*6.2831853);
        line=mix(0.5,line,clamp(1.0-w*1.6,0.0,1.0));
        vec3 col=uCol*0.88*mix(0.76,1.04,line);
        col*=1.0-0.16*smoothstep(0.25,1.0,abs(vP.y)/uH);
        col*=0.90+0.10*smoothstep(-0.09,0.09,vP.z);

        // the same rig as the boards, so the block turns with the volume
        vec3 N=normalize(vNw), V=normalize(vWV);
        vec3 L=normalize(vec3(0.52,0.70,0.55));
        vec3 F=normalize(vec3(-0.35,-0.18,0.92));
        float shade=0.70+0.34*max(dot(N,L),0.0)+0.14*max(dot(N,F),0.0);
        shade*=1.0-0.36*max(-N.y,0.0);      // the tail sits in its own shadow
        col*=shade/0.871;                   // 0.871 holds the fore-edge at its old tone
        // paper carries no real specular, only a graze
        col+=uCol*pow(1.0-max(dot(N,V),0.0),3.2)*max(dot(N,L),0.0)*0.11;
        gl_FragColor=vec4(min(col,vec3(1.0)),uOpacity);
        #include <colorspace_fragment>
      }`});
}

/* ---- tweens ---- */
const easeOutQuart=t=>1-Math.pow(1-t,4);
const easeSettle  =t=>t<0.5? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
const activeEase  =t=>t<0.3? 0.3*Math.pow(t/0.3,3) : 0.3+0.7*(1-Math.pow(1-(t-0.3)/0.7,3));
let NOW=0;
class Tw{
  constructor(v){this.v=v.slice();this.from=v.slice();this.to=v.slice();this.t0=0;this.d=0;this.e=easeOutQuart;}
  start(to,d,e,delay){this.from=this.v.slice();this.to=to.slice();this.t0=NOW+(delay||0);this.d=Math.max(d,1);this.e=e||easeOutQuart;}
  set(to){this.v=to.slice();this.from=to.slice();this.to=to.slice();this.d=0;}
  update(){ if(this.d<=0)return;
    let t=(NOW-this.t0)/this.d; if(t<0)return; if(t>=1){t=1;this.d=0;}
    const k=this.e(t); for(let i=0;i<this.v.length;i++)this.v[i]=this.from[i]+(this.to[i]-this.from[i])*k; }
}
class Spring{
  constructor(v,tension,friction,mass){this.v=v.slice();this.tgt=v.slice();this.vel=v.map(()=>0);
    this.k=tension;this.c=friction;this.m=mass||1;}
  start(t){this.tgt=t.slice();}
  update(dt){dt=Math.min(dt,1/30);
    for(let i=0;i<this.v.length;i++){
      const a=(this.k*(this.tgt[i]-this.v[i])-this.c*this.vel[i])/this.m;
      this.vel[i]+=a*dt;this.v[i]+=this.vel[i]*dt;}}
}

/* ---- one volume ---- */
const SZW=K.bookW, SZH=K.bookH, SZD=K.bookD;
const bodyGeo=new THREE.BoxGeometry(SZW,SZH,SZD);
const faceGeo=new THREE.PlaneGeometry(SZW,SZH,44,44);
const hitGeo =new THREE.PlaneGeometry(SZW*1.06,SZH*0.98);
const mPos=(i,scroll)=>{
  const k=i-(scroll||0);
  if(k>=0) return [0, K.mY + k*K.mStepY, K.mZ0 - k*K.mStepZ];
  return [0, K.mY + k*0.86, K.mZ0 - k*0.14];
};
const slotX=i=>(i-2)*K.slot;
function bookBase(b){
  if(MOBILE) return mPos(b.index,0);
  return [slotX(b.data.slot), K.shelfTop[b.data.shelf]+(SZH/2)*Math.cos(b._lean), K.bookZ];
}

function buildBook(data,index){
  const rnd=mulberry(index*7919+13);
  const B={data,index,flipped:false};
  B._lean=K.lean+(rnd()-0.5)*0.075;
  B._yaw = K.yaw+(rnd()-0.5)*0.045;
  B._roll=(rnd()-0.5)*0.018;
  B.rest=[B._lean,B._yaw,B._roll];
  B.restTilt=MOBILE?K.mTilt:B._lean;
  B.base=[0,0,0.01];
  B.basePos=bookBase(B);

  const gRoot=new THREE.Group(); gRoot.position.set(...B.basePos);
  const gHover=new THREE.Group(); gHover.position.set(...B.base);
  const gWob=new THREE.Group();
  const gTilt=new THREE.Group(); gTilt.rotation.set(...(MOBILE?[K.mTilt,0,0]:B.rest));
  const gScl=new THREE.Group(); gScl.scale.setScalar(0);
  gRoot.add(gHover); gHover.add(gWob); gWob.add(gTilt); gTilt.add(gScl);
  scene.add(gRoot);

  const coverTex=new THREE.CanvasTexture(paintCover(data,768,1152));
  coverTex.colorSpace=THREE.SRGBColorSpace; coverTex.anisotropy=8;
  const spineTex=new THREE.CanvasTexture(artSpine(data,142,1152));
  spineTex.colorSpace=THREE.SRGBColorSpace; spineTex.anisotropy=8;

  const pages=pagesMaterial(data.edge);
  const spineMat=spineMaterial(spineTex,index*5.7);
  const clothMat=new THREE.MeshBasicMaterial({color:new THREE.Color(GROUP_CLOTH(data.g)),transparent:true,opacity:0});   /* Folio */
  const body=new THREE.Mesh(bodyGeo,[pages,spineMat,pages,pages,clothMat,clothMat]);
  gScl.add(body);

  const mk=(tex,satin,seed)=>new THREE.ShaderMaterial({transparent:true,
    uniforms:{uTex:{value:tex},uSatin:{value:satin},uOpacity:{value:0},uSeed:{value:seed},
              uBow:{value:K.bow},uChamf:{value:K.chamf},uER:{value:K.chamfR},
              uW:{value:SZW},uH:{value:SZH}},
    vertexShader:COVER_VS,fragmentShader:COVER_FS});
  const coverMat=mk(coverTex,1.0,index*7.3);
  const cover=new THREE.Mesh(faceGeo,coverMat);
  cover.position.z=SZD/2+K.chamf+0.0008; gScl.add(cover);
  const backMat=mk(coverTex,0.55,index*3.1+11);
  const back=new THREE.Mesh(faceGeo,backMat);
  back.position.z=-SZD/2-K.chamf-0.0008; back.rotation.y=Math.PI; gScl.add(back);
  B.backLoaded=false;
  B.loadBack=()=>{ if(B.backLoaded)return; B.backLoaded=true;
    const t=new THREE.CanvasTexture(artBack(data,768,1152));
    t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;backMat.uniforms.uTex.value=t; };

  const hit=new THREE.Mesh(hitGeo,new THREE.MeshBasicMaterial({visible:false}));
  hit.position.set(B.basePos[0],B.basePos[1],B.basePos[2]-0.04);
  hit.rotation.x=MOBILE?K.mTilt:B._lean;
  hit.rotation.y=MOBILE?0:B._yaw;
  hit.userData.book=B;
  scene.add(hit);

  const wallSh=new THREE.Mesh(new THREE.PlaneGeometry(2.20,2.70),
    new THREE.MeshBasicMaterial({map:SHADOW_TEX,transparent:true,opacity:0,depthWrite:false,color:0x241c12}));
  wallSh.position.set(B.basePos[0]-0.05,B.basePos[1]-0.04,K.wallZ+0.004);
  scene.add(wallSh);

  const footZ=K.bookZ+(SZH/2)*Math.sin(-B._lean);            // where the boards meet the plank
  const csBack=footZ-SZD*0.5-0.045;                          // just behind the boards
  const csFront=K.wallZ+K.plankDepth-0.035;                   // stops short of the plank's nose
  const csDepth=csFront-csBack;
  const cs=new THREE.Mesh(new THREE.PlaneGeometry(SZW*1.42,csDepth),
    new THREE.MeshBasicMaterial({map:CONTACT_TEX,transparent:true,opacity:0,depthWrite:false,color:0x241a10}));
  cs.rotation.x=-Math.PI/2;
  cs.position.set(B.basePos[0],K.shelfTop[data.shelf]+0.0022,csBack+csDepth*0.5);
  scene.add(cs);
  const crease=new THREE.Mesh(new THREE.PlaneGeometry(SZW*1.16,0.075),
    new THREE.MeshBasicMaterial({map:CREASE_TEX,color:0x1a1208,transparent:true,opacity:0,depthWrite:false}));
  crease.position.set(B.basePos[0],K.shelfTop[data.shelf]+0.030,footZ+SZD*0.5+0.004);
  scene.add(crease);

  let refl=null;
  const reflMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,
    uniforms:{uTex:{value:coverTex},uOpacity:{value:0}},
    vertexShader:`varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`
      uniform sampler2D uTex; uniform float uOpacity; varying vec2 vUv;
      float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
        p3+=dot(p3,p3.yxz+33.33);return fract((p3.x+p3.y)*p3.z);}
      void main(){
        float mappedY=mix(0.0,0.22,1.0-vUv.y);
        float edge=min(min(smoothstep(0.0,0.06,vUv.y),smoothstep(0.0,0.12,1.0-vUv.y)),
                       min(smoothstep(0.0,0.06,vUv.x),smoothstep(0.0,0.06,1.0-vUv.x)));
        float b=0.004+0.02*(1.0-edge);
        vec4 col=(texture2D(uTex,vec2(vUv.x+b,mappedY))+texture2D(uTex,vec2(vUv.x-b,mappedY))
                 +texture2D(uTex,vec2(vUv.x,mappedY+b*0.5))+texture2D(uTex,vec2(vUv.x,mappedY-b*0.5)))*0.25;
        float fade=vUv.y*vUv.y*1.7;
        float sp=hash(vUv*220.0);
        gl_FragColor=vec4(col.rgb,uOpacity*fade*(1.0-sp*0.34)*edge);
        #include <colorspace_fragment>
      }`});
  refl=new THREE.Mesh(new THREE.PlaneGeometry(SZW,0.60),reflMat);
  refl.rotation.x=-Math.PI/2;
  refl.position.set(B.basePos[0],K.shelfTop[data.shelf]+0.0012,footZ+0.24);
  scene.add(refl);

  Object.assign(B,{gRoot,gHover,gWob,gTilt,gScl,body,cover,back,coverMat,backMat,spineMat,
    clothMat,pages,hit,wallSh,cs,crease,refl,reflMat,
    tHover:new Tw([...B.base]), tTilt:new Tw(MOBILE?[K.mTilt,0,0]:[...B.rest]),
    sWob:new Spring([0,0,0],80,6,1),
    tActiveP:new Tw([...B.basePos]), tActiveR:new Tw([0,0,0]),
    tScale:new Tw([0]), tRefl:new Tw([0.34]), tFade:new Tw([0]), tSeat:new Tw([1])});
  if(MOBILE){wallSh.visible=false;cs.visible=false;crease.visible=false;refl.visible=false;
             gRoot.renderOrder=100-index;}
  return B;
}

/* ---- state ---- */
const S={anim:'intro',active:null,lifted:null};
function hoverIn(B,dur){
  const d=dur===undefined?K.hoverLift:dur;
  B.tHover.start([B.base[0],B.base[1]+0.085,B.base[2]+0.075],d,easeOutQuart);
  B.tTilt.start([0,0,0],d,easeOutQuart);
  B.sWob.start([0,0,0]);
  B.tRefl.start([0],d*0.45,easeOutQuart);
  B.loadBack();
}
function hoverOut(B){
  const d=K.hoverDrop;
  B.tHover.start([...B.base],d,easeSettle);
  B.tTilt.start(MOBILE?[B.restTilt,0,0]:[...B.rest],d,easeSettle,d*0.22);
  B.tRefl.start([0.34],d,easeSettle);
  B.sWob.start([0,0,0]);
}
function activeZ(){
  const camZ=camera.position.z;
  const fill=MOBILE?0.86:0.60;
  const halfH=(SZH*0.5)/fill;
  const dv=halfH/Math.tan(K.fov*Math.PI/360);
  const halfW=(SZW*0.5)/fill;
  const dh=halfW/(Math.tan(K.fov*Math.PI/360)*camera.aspect);
  return camZ-Math.max(dv,dh);
}
function toActive(B){
  S.anim='animatingForward'; hoverIn(B);
  B.tSeat.start([0],K.activeDuration*0.55,easeSettle,K.activeDuration*0.12);
  const ay = MOBILE ? mobileTargetY() : K.boxCY-0.02;
  B.tActiveP.start([MOBILE?0:K.activeX,ay,activeZ()],K.activeDuration,activeEase);
  B.tActiveR.start([...K.activeRot],K.activeDuration,activeEase);
  B.gRoot.renderOrder=10; setLayer(B,LAY_FG);
  tSet(()=>{ if(S.active===B) S.anim='active'; },K.activeDuration);
}
function toInactive(B){
  S.anim='animatingBackward'; B.flipped=false;
  B.tSeat.start([1],K.activeDuration*0.62,easeSettle,K.activeDuration*0.38);
  B.tHover.start([B.base[0],B.base[1]+0.06,B.base[2]],K.activeDuration,easeOutQuart);
  B.tActiveP.start([...B.basePos],K.activeDuration,activeEase);
  B.tActiveR.start([...K.activeRot],K.activeDuration,activeEase);
  tSet(()=>hoverOut(B),K.activeDuration);
  tSet(()=>{ S.anim='inactive'; setLayer(B,LAY_BG);
                   B.gRoot.renderOrder=MOBILE?100-B.index:0;
                   if(S.lifted===B)S.lifted=null; },K.activeDuration+20);
}
function setLayer(B,l){ B.gRoot.traverse(o=>o.layers.set(l)); }
function setActive(B){
  if(S.anim==='intro'||S.anim==='animatingForward'||S.anim==='animatingBackward')return;
  if(S.active===B)return;
  if(S.active){toInactive(S.active);S.active=null;detailEl.classList.remove('on');SHELF.classList.remove('reading');WASH.target=0;return;}
  S.active=B;S.lifted=B;toActive(B);
  showDetail(B);
}
function clearActive(){
  if(!S.active)return;
  const B=S.active;S.active=null;
  detailEl.classList.remove('on');SHELF.classList.remove('reading');WASH.target=0;hintEl.classList.remove('on');
  mDetails.textContent='Details';
  dragReset();
  toInactive(B);
}
function flipActive(){
  const B=S.active; if(!B||S.anim!=='active')return;
  B.flipped=!B.flipped; B.loadBack();
  B.tActiveR.start([K.activeRot[0],K.activeRot[1]+(B.flipped?Math.PI:0),K.activeRot[2]],
                   K.activeDuration,activeEase);
}
/* Folio: the "Look inside" button is now "Open <Tool>" — it hands the
   volume's tool to the app, which routes to that tool view. The back
   cover is still reachable by drag, Space or Enter while a volume is out. */
function openVolume(B){
  if(S.active===B){openTool(B.data.id);return;}
  setActive(B);
}

/* ════════════════════════════════════════════════════════════════════════
   5 · CAMERA (orbits toward the pointer) + BLUR COMPOSITE
   ════════════════════════════════════════════════════════════════════════ */
let VW=1,VH=1,DIST=12;
const ORB={tx:0,ty:0,x:0,y:0};
const TGT=new THREE.Vector3();
function mobileTargetY(){
  const tan=Math.tan(K.fov*Math.PI/360);
  const D=DIST-K.mZ0;
  const stackTop=K.mY+(BOOKS.length-1)*K.mStepY+SZH*0.5*Math.cos(K.mTilt);
  return Math.max(K.mY+K.mDrop*D*tan, stackTop-0.80*D*tan);
}
function applyCamera(){
  const damp=MOBILE?0:(S.active?0.42:1);
  const az=ORB.x*K.orbitAz*damp;
  const el=0.0025-ORB.y*K.orbitEl*damp;
  TGT.set(0, MOBILE?mobileTargetY():K.boxCY, 0);
  camera.position.set(
    TGT.x+Math.sin(az)*Math.cos(el)*DIST,
    TGT.y+Math.sin(el)*DIST,
    TGT.z+Math.cos(az)*Math.cos(el)*DIST);
  camera.lookAt(TGT);
}
function frameCamera(){
  const aspect=VW/VH, tan=Math.tan(K.fov*Math.PI/360);
  camera.aspect=aspect;
  if(MOBILE){
    const a=clamp(aspect,0.40,0.95);
    DIST=(SZW*0.5)/(K.mFill*tan*a)+K.mZ0;
    camera.near=Math.max(DIST-9,0.1); camera.far=DIST+26;
  } else {
    const distV=K.boxY/(2*tan), distH=K.boxX/(2*tan*aspect);
    let d=K.offset*Math.max(distV,distH);
    const projW=VW*K.boxX/(2*d*tan*aspect);
    if(projW>K.maxWidthPx) d=VW*K.boxX/(2*K.maxWidthPx*tan*aspect);
    DIST=d;
    const maxDim=Math.max(K.boxX,K.boxY);
    camera.near=Math.max(DIST-maxDim*2-2,0.1); camera.far=DIST+maxDim*2+16;
  }
  applyCamera();
  camera.updateProjectionMatrix();
}

const rt=new THREE.WebGLRenderTarget(2,2,{
  type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,
  depthBuffer:true,stencilBuffer:false,samples:4});
const NOISE_N=256, noiseData=new Uint8Array(NOISE_N*NOISE_N*4);
{ const r=mulberry(4242);
  for(let i=0;i<NOISE_N*NOISE_N;i++){noiseData[i*4]=(r()*255)|0;noiseData[i*4+1]=(r()*255)|0;
    noiseData[i*4+2]=(r()*255)|0;noiseData[i*4+3]=255;} }
const noiseTex=new THREE.DataTexture(noiseData,NOISE_N,NOISE_N);
noiseTex.wrapS=noiseTex.wrapT=THREE.RepeatWrapping;
noiseTex.minFilter=noiseTex.magFilter=THREE.LinearFilter;noiseTex.needsUpdate=true;

const passMat=new THREE.ShaderMaterial({
  depthTest:false,depthWrite:false,
  uniforms:{backgroundTexture:{value:rt.texture},noiseTexture:{value:noiseTex},
    noiseScale:{value:6},intensity:{value:0},ignoreBlur:{value:true},
    samples:{value:30},resolution:{value:new THREE.Vector2(1,1)}},
  vertexShader:`varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
  fragmentShader:`
    uniform sampler2D backgroundTexture; uniform sampler2D noiseTexture;
    uniform float noiseScale; uniform float intensity; uniform bool ignoreBlur;
    uniform float samples; uniform vec2 resolution;
    varying vec2 vUv;
    const float pi=3.14159265359;
    const float goldenAngle=pi*(3.0-sqrt(5.0));
    vec4 goldenBlur(vec2 uv,sampler2D tex){
      float noise=texture2D(noiseTexture,uv*noiseScale).r;
      float angle=pi+(noise-0.5)*2.0*pi*2.0;
      vec2 polar=vec2(cos(angle),sin(angle));
      vec4 sum=vec4(0.0);
      vec2 a=vec2(1024.)*vec2(1.,resolution.x/resolution.y);
      for(int i=1;i<=32;i++){
        if(float(i)>samples)break;
        float r=intensity*sqrt(float(i)/samples);
        float theta=float(i)*goldenAngle;
        vec2 off=vec2(polar.x*cos(theta)-polar.y*sin(theta),
                      polar.y*cos(theta)+polar.x*sin(theta));
        sum+=texture2D(tex,uv+(off*r/a));
      }
      return sum/samples;
    }
    void main(){
      gl_FragColor=texture2D(backgroundTexture,vUv);
      if(!ignoreBlur) gl_FragColor=goldenBlur(vUv,backgroundTexture);
      gl_FragColor.a=1.0;
      #include <colorspace_fragment>
    }`});
const quadGeo=new THREE.BufferGeometry();
quadGeo.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
quadGeo.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,2,0,0,2],2));
const quad=new THREE.Mesh(quadGeo,passMat); quad.frustumCulled=false;
const quadScene=new THREE.Scene(); quadScene.add(quad);
const quadCam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
const blurTw={i:new Tw([0]),n:new Tw([1])};

function resize(){
  VW=Math.max(1,STAGE.clientWidth); VH=Math.max(1,STAGE.clientHeight);  /* Folio: the scene fills the shelf frame, not the window */
  renderer.setSize(VW,VH,false);
  const pr=renderer.getPixelRatio();
  rt.setSize(Math.round(VW*pr),Math.round(VH*pr));
  passMat.uniforms.resolution.value.set(VW*pr,VH*pr);
  frameCamera();
}
addEventListener('resize',()=>{ if(!LIVE||PAUSED)return; resize();washResize(); });   /* Folio: resume() resizes on return */

/* ════════════════════════════════════════════════════════════════════════
   6 · UI
   ════════════════════════════════════════════════════════════════════════ */
const detailEl=document.getElementById('detail');
const dMeta=document.getElementById('detail-meta'), dTitle=document.getElementById('detail-title');
const dDesc=document.getElementById('detail-desc');
const dLook=document.getElementById('detail-look'), dClose=document.getElementById('detail-close');
const hintEl=document.getElementById('hint');
/* ---- a torn sheet that slides in from the left to carry the copy ---- */
const washEl=document.getElementById('wash');
const wctx=washEl.getContext('2d');
const WASH={t:0,target:0,w:1,h:1,sheet:null,travel:1,dirty:true};

function hash1(i){ let x=Math.sin(i*127.1+311.7)*43758.5453; return x-Math.floor(x); }
function vnoise1(t,seed){
  const i=Math.floor(t), f=t-i, u=f*f*(3-2*f);
  return lerp(hash1(i+seed*97.3), hash1(i+1+seed*97.3), u);
}
function hash2(x,y){ let v=Math.sin(x*12.9898+y*78.233)*43758.5453; return v-Math.floor(v); }

/* the torn band: solid on the left, breaking into fibres on the right */
function buildTearBand(TW,h){
  const oct=[[1/430,44],[1/170,21],[1/74,10.5],[1/31,5.0],[1/13,2.4],[1/6,1.2]];
  const edge=new Float32Array(h);
  for(let y=0;y<h;y++){
    let e=TW*0.42;
    for(let k=0;k<oct.length;k++) e+=(vnoise1(y*oct[k][0],k+1)-0.5)*2*oct[k][1];
    edge[y]=e;
  }
  const a=new Float32Array(TW*h);
  for(let y=0;y<h;y++){
    const e=edge[y];
    const fib=5+17*vnoise1(y/8.5,11);          // fibre length varies down the tear
    for(let x=0;x<TW;x++){
      const t=(x-e)/fib;
      let v;
      if(t<=0) v=1;
      else if(t>=1.35) v=0;
      else {
        // break the falloff up so it reads as fibres rather than a soft cut
        const n=hash2(Math.floor(x*0.9),Math.floor(y*0.75))*0.62
               +hash2(Math.floor(x*2.4)+37,Math.floor(y*2.1)+11)*0.38;
        v=clamp(1.18-t-(n-0.5)*0.95,0,1);
        v=v*v*(3-2*v);
      }
      a[y*TW+x]=v;
    }
  }
  return a;
}
function tintBand(a,TW,h,r,g0,b0,edgeDark){
  const c=C(TW,h), g=c.getContext('2d');
  const img=g.createImageData(TW,h), d=img.data;
  for(let i=0;i<TW*h;i++){
    const v=a[i];
    let k=1;
    if(edgeDark&&v>0.02&&v<0.97) k=0.86+0.14*v;   // compressed fibres at the tear
    d[i*4]=r*k; d[i*4+1]=g0*k; d[i*4+2]=b0*k;
    d[i*4+3]=v*255;
  }
  g.putImageData(img,0,0);
  return c;
}
function buildSheet(){
  const w=WASH.w,h=WASH.h;
  if(w<8||h<8) return;
  const TW=Math.min(210,Math.round(w*0.34));
  const X0=Math.max(0,w-TW-46);
  const a=buildTearBand(TW,h);
  const paper=tintBand(a,TW,h,219,202,175,true);
  const dark =tintBand(a,TW,h,86,68,46,false);
  const cv=C(w,h), g=cv.getContext('2d');
  // the sheet casts a soft shadow onto the scene behind it
  const BL=40;                       // the sheet bleeds past the left edge of the canvas
  g.save(); g.globalAlpha=0.34; g.filter=`blur(${Math.round(h*0.020)}px)`;
  g.fillStyle='#56432e'; g.fillRect(-BL,0,X0+16+BL,h);
  g.drawImage(dark,X0+16,0);
  g.restore();
  // the sheet itself
  const pg=g.createLinearGradient(0,0,w,0);
  pg.addColorStop(0,'rgb(222,206,180)');
  pg.addColorStop(0.72,'rgb(219,202,175)');
  pg.addColorStop(1,'rgb(213,195,167)');
  g.fillStyle=pg; g.fillRect(-BL,0,X0+1+BL,h);
  g.drawImage(paper,X0,0);
  // fibre grain, only where there is paper
  g.globalCompositeOperation='source-atop';
  const r=mulberry(913);
  for(let i=0;i<2600;i++){
    const x=r()*w, y=r()*h, l=2+r()*26, ang=(r()-0.5)*0.5;
    g.strokeStyle=r()<0.5?`rgba(255,250,240,${0.02+r()*0.05})`:`rgba(120,98,70,${0.02+r()*0.05})`;
    g.lineWidth=r()<0.85?1:2;
    g.beginPath(); g.moveTo(x,y); g.lineTo(x+Math.cos(ang)*l,y+Math.sin(ang)*l); g.stroke();
  }
  g.fillStyle='rgba(255,252,244,0.05)';
  g.fillRect(-BL,0,w+BL,h*0.5);
  g.globalCompositeOperation='source-over';
  WASH.sheet=cv; WASH.travel=X0+TW+60;
}
function washResize(){
  const w=Math.max(1,washEl.clientWidth), h=Math.max(1,washEl.clientHeight);
  washEl.width=w; washEl.height=h; WASH.w=w; WASH.h=h;
  buildSheet(); WASH.dirty=true;
}
function drawWash(){
  const w=WASH.w,h=WASH.h,t=WASH.t;
  wctx.clearRect(0,0,w,h);
  if(t<=0.002||!WASH.sheet) return;
  wctx.drawImage(WASH.sheet,-(1-t)*WASH.travel,0);
}

const mbar=document.getElementById('mbar'), mMeta=document.getElementById('mbar-meta'),
      mTitle=document.getElementById('mbar-title'), mDetails=document.getElementById('mbar-details'),
      mLook=document.getElementById('mbar-look'), menuBtn=document.getElementById('menubtn'),
      menu=document.getElementById('menu');
      menu.innerHTML='';  /* Folio: rebuilt on every mount */
const M={scroll:0,target:0,index:0,dragging:false,lastY:0};

function showDetail(B){
  const d=B.data;
  dMeta.textContent=`Folio · ${d.group}`;                       /* Folio */
  dTitle.textContent=d.title; dDesc.textContent=d.blurb;
  dLook.textContent=`Open ${d.title}`;                          /* Folio */
  detailEl.classList.add('on'); SHELF.classList.add('reading'); WASH.target=1;
  if(MOBILE){ mMeta.textContent=`Folio · ${d.group}`; mTitle.textContent=d.title;
              mDetails.textContent='Close'; mLook.textContent=`Open ${d.title}`; }
}
dClose.addEventListener('click',e=>{e.stopPropagation();clearActive();});
/* Folio: "Open <Tool>" routes to the tool; the app pauses this scene. */
dLook.addEventListener('click',e=>{e.stopPropagation();if(S.active)openTool(S.active.data.id);});

const tl=document.getElementById('tl'); tl.innerHTML='';  /* Folio: rebuilt on every mount */
BOOKS.forEach((d,i)=>{
  const b=document.createElement('button');
  b.className='tli rise';
  b.dataset.d=400+i*40;
  b.setAttribute('aria-label',`${d.title}, ${d.group} group. Takes the volume down; the panel then offers Open ${d.title}.`);
  b.innerHTML=`<span class="tltxt"><p class="studio">${d.group}</p><h2>${d.title}</h2></span>`;
  b.addEventListener('pointerenter',()=>{ if(S.anim==='inactive'&&!MOBILE)setLifted(books[i]); });
  b.addEventListener('pointerleave',()=>{ if(S.anim==='inactive'&&!MOBILE)setLifted(null); });
  b.addEventListener('click',e=>{e.stopPropagation(); if(S.active)clearActive(); else setActive(books[i]);});
  tl.appendChild(b);
});
BOOKS.forEach((d,i)=>{
  const b=document.createElement('button');
  b.innerHTML=`<span>${d.group}</span>${d.title}`;      /* Folio: group name, no year */
  b.addEventListener('click',()=>{menu.hidden=true;M.target=i;if(S.active)clearActive();});
  menu.appendChild(b);
});
menuBtn.addEventListener('click',()=>{menu.hidden=!menu.hidden;});

function setLifted(B){
  if(S.lifted===B)return;
  if(S.lifted&&S.lifted!==S.active)hoverOut(S.lifted);
  S.lifted=B;
  if(B)hoverIn(B);
}
function setMobileIndex(i,force){
  i=clamp(i,0,BOOKS.length-1);
  if(!force&&i===M.index)return;
  M.index=i; const d=BOOKS[i];
  mMeta.textContent=`Folio · ${d.group}`; mTitle.textContent=d.title;
}
let snapTimer=null;
function mobileSnap(delay){clearTimeout(snapTimer);
  snapTimer=tSet(()=>{M.target=clamp(Math.round(M.target),0,BOOKS.length-1);},delay);}
function mobileScrollBy(dv){M.target=clamp(M.target+dv,0,BOOKS.length-1);mobileSnap(170);}
addEventListener('wheel',e=>{ if(!LIVE||PAUSED||!MOBILE||S.active)return; mobileScrollBy(e.deltaY/420); },{passive:true});
canvas.addEventListener('touchstart',e=>{ if(!MOBILE)return; M.dragging=true; M.lastY=e.touches[0].clientY; },{passive:true});
canvas.addEventListener('touchmove',e=>{
  if(!MOBILE||!M.dragging||S.active)return;
  const y=e.touches[0].clientY; mobileScrollBy((M.lastY-y)/190); M.lastY=y; },{passive:true});
addEventListener('touchend',()=>{ if(!LIVE||PAUSED)return; M.dragging=false;if(MOBILE&&!S.active)mobileSnap(60); },{passive:true});
mDetails.addEventListener('click',e=>{e.stopPropagation();if(S.active)clearActive();else setActive(books[M.index]);});
mLook.addEventListener('click',e=>{e.stopPropagation();openVolume(books[M.index]);});

/* ---- pointer ---- */
const ray=new THREE.Raycaster();
ray.layers.enable(LAY_BG); ray.layers.enable(LAY_FG);
const ptr=new THREE.Vector2();
const DRAG={on:false,moved:0,lx:0,ly:0,rx:0,ry:0};
function dragReset(){DRAG.on=false;DRAG.moved=0;DRAG.rx=0;DRAG.ry=0;}
addEventListener('pointermove',e=>{
  if(!LIVE||PAUSED)return;                                            /* Folio */
  const hr=stageRect();                                               /* Folio: pointer maths are frame-relative */
  ORB.tx=clamp((e.clientX-hr.left)/VW-0.5,-.5,.5)*2; ORB.ty=clamp((e.clientY-hr.top)/VH-0.5,-.5,.5)*2;
  hintEl.style.transform=`translate(${e.clientX-hr.left+12}px,${e.clientY-hr.top+12}px)`;
  if(S.anim==='intro'||MOBILE)return;
  ptr.x=((e.clientX-hr.left)/VW)*2-1; ptr.y=-(((e.clientY-hr.top)/VH)*2-1);
  ray.setFromCamera(ptr,camera);
  const hits=ray.intersectObjects(books.map(b=>b.hit),false);
  const B=hits.length?hits[0].object.userData.book:null;
  if(S.active){
    if(DRAG.on){                                   // turning the volume in the hand
      const dx=e.clientX-DRAG.lx, dy=e.clientY-DRAG.ly;
      DRAG.lx=e.clientX; DRAG.ly=e.clientY;
      DRAG.moved+=Math.abs(dx)+Math.abs(dy);
      DRAG.ry+=dx*0.0090;
      DRAG.rx=clamp(DRAG.rx+dy*0.0062,-0.62,0.62);
      S.active.sWob.start([DRAG.rx,DRAG.ry,0]);
      document.body.style.cursor='grabbing';
      return;
    }
    if(B===S.active&&S.anim==='active'){
      if(!REDUCED&&hits[0].uv){                    // a light parallax when the hand is off
        const uv=hits[0].uv;
        S.active.sWob.start([DRAG.rx+Math.PI/46*(uv.y-.5)*2*(S.active.flipped?-1:1),
                             DRAG.ry+Math.PI/36*((S.active.flipped?1-uv.x:uv.x)-.5)*2,0]);
      }
      hintEl.classList.add('on'); document.body.style.cursor='grab';
    } else { hintEl.classList.remove('on'); document.body.style.cursor='default';
             S.active.sWob.start([DRAG.rx,DRAG.ry,0]); }
    return;
  }
  if(S.anim!=='inactive')return;
  setLifted(B);
  document.body.style.cursor=B?'pointer':'default';
  if(B&&hits[0].uv&&!REDUCED){
    const uv=hits[0].uv;
    B.sWob.start([Math.PI/50*(uv.y-.5)*2, Math.PI/40*(uv.x-.5)*2, 0]);
  }
});
addEventListener('pointerleave',()=>{ if(!LIVE||PAUSED)return; ORB.tx=0;ORB.ty=0;
  if(!MOBILE&&!S.active&&S.anim==='inactive')setLifted(null); });
addEventListener('blur',()=>{ if(!LIVE||PAUSED)return; ORB.tx=0;ORB.ty=0; });
addEventListener('pointerdown',e=>{
  if(!LIVE||PAUSED)return;                                            /* Folio */
  if(e.target.closest('header')||e.target.closest('footer')||
     e.target.closest('.detail')||e.target.closest('.mbar')||e.target.closest('.menu'))return;
  const hr=stageRect();                                              /* Folio */
  ptr.x=((e.clientX-hr.left)/VW)*2-1; ptr.y=-(((e.clientY-hr.top)/VH)*2-1);
  ray.setFromCamera(ptr,camera);
  if(S.active){
    const h=ray.intersectObject(S.active.body,false);
    if(h.length){
      DRAG.on=true; DRAG.moved=0; DRAG.lx=e.clientX; DRAG.ly=e.clientY;
      document.body.style.cursor='grabbing';
      try{ canvas.setPointerCapture(e.pointerId); }catch(err){}
      e.preventDefault();
    } else clearActive();
    return;
  }
  const hits=ray.intersectObjects(books.map(b=>b.hit),false);
  if(hits.length) setActive(MOBILE?books[M.index]:hits[0].object.userData.book);
});
addEventListener('pointerup',e=>{
  if(!LIVE||PAUSED)return;                                            /* Folio */
  if(!DRAG.on)return;
  DRAG.on=false;
  try{ canvas.releasePointerCapture(e.pointerId); }catch(err){}
  document.body.style.cursor='grab';
  if(DRAG.moved<10) flipActive();               // a tap still turns the volume over
});
addEventListener('pointercancel',()=>{ if(!LIVE||PAUSED)return; DRAG.on=false; });
/* Folio: keyboard layer - Escape and Space are authored; the arrow keys
   and Enter were added so the shelf can be used without a pointer.
   The PAUSED guard matters: Space in a tool view must never flip the
   hidden scene. */
addEventListener('keydown',e=>{
  if(!LIVE||PAUSED)return;
  if(!SHELF.contains(e.target)&&e.target!==document.body)return;
  if(e.key==='Escape'&&S.active)clearActive();
  if((e.key===' '||e.code==='Space')&&S.active){e.preventDefault();flipActive();}
  if(e.key==='ArrowRight'||e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='ArrowDown'){
    kbMove(e.key==='ArrowDown'?5:e.key==='ArrowUp'?-5:e.key==='ArrowRight'?1:-1);
    e.preventDefault();
  } else if(e.key==='Enter'){
    e.preventDefault();
    if(S.active)flipActive();
    else if(KB.i>=0&&S.anim==='inactive')setActive(books[KB.i]);
  }
});
function kbMove(step){
  if(!books.length||S.active||S.anim!=='inactive')return;
  KB.i=KB.i<0?(step>0?0:books.length-1):clamp(KB.i+step,0,books.length-1);
  setLifted(books[KB.i]);
  SHELF.querySelectorAll('.tli.kbd').forEach(b=>b.classList.remove('kbd'));
  if(tl.children[KB.i])tl.children[KB.i].classList.add('kbd');
}

/* ════════════════════════════════════════════════════════════════════════
   7 · MODE, INTRO, RENDER LOOP
   ════════════════════════════════════════════════════════════════════════ */
function applyMode(){
  SHELF.classList.toggle('mobile',MOBILE);
  furniture.visible=!MOBILE;
  wall.visible=true;
  for(const B of books){
    B.basePos=bookBase(B);
    B.restTilt=MOBILE?K.mTilt:B._lean;
    if(B!==S.active){
      B.tActiveP.set([...B.basePos]);
      B.tTilt.set(MOBILE?[K.mTilt,0,0]:[...B.rest]);
      B.tHover.set([...B.base]);
    }
    B.hit.position.set(B.basePos[0],B.basePos[1],B.basePos[2]-0.04);
    B.hit.rotation.x=MOBILE?K.mTilt:B._lean; B.hit.rotation.y=MOBILE?0:B._yaw;
    B.wallSh.visible=!MOBILE; B.cs.visible=!MOBILE; B.crease.visible=!MOBILE; B.refl.visible=!MOBILE;
    B.gRoot.renderOrder=MOBILE?100-B.index:0;
  }
  if(MOBILE)setMobileIndex(M.index,true);
  frameCamera();
}
const MODE_CHANGE=e=>{MOBILE=e.matches;if(!LIVE||PAUSED)return;applyMode();};   /* Folio: resume() applies the mode */
MOBILE_Q.addEventListener('change',MODE_CHANGE);

const wallFade=new Tw([0]);
function revealChrome(){
  const step=REDUCED?0:1;
  for(const el of SHELF.querySelectorAll('.rise')){
    el.style.setProperty('--d',(+el.dataset.d||0)*step+'ms');
  }
  // one reflow so the delays are in place before the class that plays them
  void document.body.offsetHeight;
  for(const el of SHELF.querySelectorAll('.rise')) el.classList.add('in');
}
function startIntro(){
  // the volumes are already shelved — they only fade up, no tipping or settling
  S.anim='intro';
  wallFade.start([1],K.introWallFade,easeOutQuart);
  books.forEach((B,i)=>{
    B.tScale.set([1]);
    B.tHover.set([...B.base]);
    B.tTilt.set(MOBILE?[B.restTilt,0,0]:[...B.rest]);
    B.tFade.set([0]);
    B.tFade.start([1],K.introFade,easeOutQuart,i*K.introStagger);
  });
  tSet(()=>{ if(S.anim==='intro')S.anim='inactive'; },
             K.introWallFade+books.length*K.introStagger);
}


let last=performance.now();
function tick(now){
  if(!LIVE||PAUSED)return; FOLIO_RAF=requestAnimationFrame(tick);   /* Folio: paused = no frame scheduled */
  NOW=now; const dt=Math.min((now-last)/1000,0.05); last=now;

  // during the intro the camera snaps to the pointer instead of easing, so the
  // shelf never swings into place on load
  {
    const tg=WASH.target, k2=Math.min(1,dt*(tg>WASH.t?5.2:8.5));
    if(Math.abs(tg-WASH.t)>0.0009||WASH.dirty){ WASH.t+=(tg-WASH.t)*k2; WASH.dirty=false; drawWash(); }
  }
  const k=(S.anim==='intro')?1:Math.min(1,dt*3.4);
  ORB.x+=(ORB.tx-ORB.x)*k; ORB.y+=(ORB.ty-ORB.y)*k;
  applyCamera();

  wallFade.update();
  const wf=wallFade.v[0];
  wallMat.uniforms.uOpacity.value=wf; oakH.uniforms.uOpacity.value=wf; oakV.uniforms.uOpacity.value=wf;

  if(MOBILE){
    if(!S.active) M.scroll+=(M.target-M.scroll)*Math.min(1,dt*9);
    setMobileIndex(Math.round(M.scroll));
    for(const B of books){
      B.basePos=mPos(B.index,M.scroll);
      if(B===S.active||S.anim==='animatingBackward')continue;
      B.tActiveP.v[0]=B.basePos[0];B.tActiveP.v[1]=B.basePos[1];B.tActiveP.v[2]=B.basePos[2];
      B.tActiveP.d=0;
      const u=clamp(M.scroll-B.index,0,1.6);
      B.tTilt.v[0]=lerp(K.mTilt,K.mFlat,smooth(Math.min(u,1))); B.tTilt.d=0;
      B.mFade=1-smooth(clamp((u-0.28)/0.5,0,1));
      B.gRoot.visible=B.mFade>0.01 && B.index-M.scroll<9.5;
    }
  }

  for(const B of books){
    B.tHover.update();B.tTilt.update();B.tActiveP.update();B.tActiveR.update();
    B.tScale.update();B.tRefl.update();B.tFade.update();B.tSeat.update();B.sWob.update(dt);
    B.gHover.position.set(B.tHover.v[0],B.tHover.v[1],B.tHover.v[2]);
    B.gTilt.rotation.set(B.tTilt.v[0],B.tTilt.v[1],B.tTilt.v[2]);
    B.gWob.rotation.set(B.sWob.v[0],B.sWob.v[1],B.sWob.v[2]);
    B.gRoot.position.set(B.tActiveP.v[0],B.tActiveP.v[1],B.tActiveP.v[2]);
    B.gRoot.rotation.set(B.tActiveR.v[0],B.tActiveR.v[1],B.tActiveR.v[2]);
    B.gScl.scale.setScalar(B.tScale.v[0]);
    const op=B.tFade.v[0]*wf*(MOBILE&&B.mFade!==undefined&&B!==S.active?B.mFade:1);
    B.clothMat.opacity=op; B.spineMat.uniforms.uOpacity.value=op;
    B.pages.uniforms.uOpacity.value=op;
    B.coverMat.uniforms.uOpacity.value=op;
    B.backMat.uniforms.uOpacity.value=op;
    if(!MOBILE){
      const lift=B.tHover.v[1], away=clamp((B.tHover.v[2]-B.base[2])/0.075,0,1);
      B.wallSh.position.x=B.basePos[0]-0.09-away*0.05;
      B.wallSh.position.y=B.basePos[1]+lift-0.04+away*0.02;
      B.wallSh.scale.setScalar((1+away*0.13)*(B.tScale.v[0]||0.0001));
      const seat=B.tSeat.v[0];                                   // 1 on the shelf, 0 in the hand
      B.wallSh.material.opacity=(0.50-away*0.15)*op*seat;
      B.cs.material.opacity=(0.92*(1-away*0.55))*op*seat;
      B.crease.material.opacity=(0.55*(1-away))*op*seat;
      B.reflMat.uniforms.uOpacity.value=B.tRefl.v[0]*op*seat;
      B.refl.position.z=K.bookZ+(SZH/2)*Math.sin(-B._lean)+0.24+B.tHover.v[2]*2;
    }
  }

  const wantBlur=(S.anim==='animatingForward'||S.anim==='active');
  if(blurTw._w!==wantBlur){blurTw._w=wantBlur;
    blurTw.i.start([wantBlur?16:0],460,t=>t,100);
    blurTw.n.start([wantBlur?6:1],400,t=>t,100);}
  blurTw.i.update();blurTw.n.update();

  const act=(S.anim==='animatingForward'||S.anim==='active'||S.anim==='animatingBackward');
  camera.layers.set(LAY_BG);
  renderer.setRenderTarget(rt);
  renderer.clear(true,true,false);
  renderer.render(scene,camera);
  renderer.setRenderTarget(null);
  passMat.uniforms.ignoreBlur.value=!act;
  passMat.uniforms.intensity.value=blurTw.i.v[0];
  passMat.uniforms.noiseScale.value=blurTw.n.v[0];
  renderer.clear(true,true,false);
  renderer.render(quadScene,quadCam);
  if(act){
    renderer.clearDepth();
    camera.layers.set(LAY_FG);
    renderer.render(scene,camera);
  }
}

/* Folio: full teardown, kept for the error path (if building the scene
   throws, the app falls back and this releases everything). The normal
   leave path is pause/resume — the scene stays in memory for an instant
   return, so the canvas node is never replaced while cycling views. */
function disposeShelf(){
  for(const id of FOLIO_TIMERS)clearTimeout(id);
  FOLIO_TIMERS.clear();
  if(FOLIO_RAF)cancelAnimationFrame(FOLIO_RAF);
  MOBILE_Q.removeEventListener('change',MODE_CHANGE);
  DRAG.on=false;
  S.active=null;S.lifted=null;S.anim='disposed';
  PAUSED=false;
  document.body.style.cursor='';
  SHELF.classList.remove('reading','mobile');
  detailEl.classList.remove('on');hintEl.classList.remove('on');
  SHELF.querySelector('footer').classList.remove('on');
  mbar.classList.remove('on');menu.hidden=true;
  canvas.classList.remove('on');
  const reap=root=>root.traverse(o=>{
    if(o.geometry)o.geometry.dispose();
    const ms=Array.isArray(o.material)?o.material:(o.material?[o.material]:[]);
    for(const m of ms){
      if(m.uniforms)for(const k in m.uniforms){
        const u=m.uniforms[k]; if(u&&u.value&&u.value.isTexture)u.value.dispose(); }
      if(m.map&&m.map.isTexture)m.map.dispose();
      m.dispose();
    }
  });
  reap(scene);reap(quadScene);
  WOOD_TEX.dispose();SHADOW_TEX.dispose();CONTACT_TEX.dispose();CREASE_TEX.dispose();
  noiseTex.dispose();rt.dispose();
  renderer.dispose();
  try{renderer.forceContextLoss();}catch(err){}
  books.length=0;
  if(wctx)wctx.clearRect(0,0,WASH.w,WASH.h);
  WASH.sheet=null;WASH.t=0;WASH.target=0;
  const fresh=canvas.cloneNode(false);fresh.className='';
  canvas.replaceWith(fresh);   /* Folio: a clean canvas for the next mount */
}
/* Folio: pause stops the loop and every event path; resume resizes to the
   (possibly changed) frame, resettles the clock and restarts the loop. */
function pauseShelfInt(){
  if(FOLIO_RAF){cancelAnimationFrame(FOLIO_RAF);FOLIO_RAF=0;}
  DRAG.on=false;
  ORB.tx=0;ORB.ty=0;
  document.body.style.cursor='';
  hintEl.classList.remove('on');
}
function resumeShelfInt(){
  if(FOLIO_RAF)cancelAnimationFrame(FOLIO_RAF);
  resize();washResize();
  last=performance.now();
  FOLIO_RAF=requestAnimationFrame(tick);
}
BOOT_API={pause:pauseShelfInt,resume:resumeShelfInt,dispose:disposeShelf};
window.__SHELF__=()=>({live:LIVE,paused:PAUSED});   /* Folio: debug hook for drive */

/* ---- boot ---- */
const loader=document.getElementById('loader'), barfill=document.getElementById('barfill');
loader.classList.remove('gone');  /* Folio: the loader shows again on a fresh mount */
const setProgress=p=>barfill.style.transform=`scaleX(${p})`;
setProgress(0.06);
const frame=()=>new Promise(r=>{let done=false;const go=()=>{if(!done){done=true;r();}};
  requestAnimationFrame(go);tSet(go,34);});

(async function boot(){
  try{ await Promise.race([document.fonts.ready,new Promise(r=>tSet(r,2200))]); }catch(e){}
  setProgress(0.10);
  setProgress(0.16);   /* Folio: no plates to load — covers are painted */
  if(!document.hidden) await frame();
  for(let i=0;i<BOOKS.length;i++){ if(!LIVE)return;  /* Folio */
    books.push(buildBook(BOOKS[i],i));
    setProgress(0.16+0.80*(i+1)/BOOKS.length);
    if(!document.hidden) await frame();
  }
  applyMode();
  resize(); washResize();
  setProgress(1);
  if(!LIVE)return;  /* Folio */
  requestAnimationFrame(tick);
  await frame(); await frame();
  loader.classList.add('gone');
  canvas.classList.add('on');
  revealChrome();
  SHELF.querySelector('footer').classList.add('on');
  mbar.classList.add('on');
  startIntro();
})();
}
