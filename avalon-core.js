// Ядро карты Авалона: чистые функции без DOM. Подключается сайтом обычным
// <script>, а тестами — через require (test/avalon-core.test.js).
(function(g){
  const key=(a,b)=> a<b ? a+'|'+b : b+'|'+a;

  function merge(state, d){
    const s = d.full ? new Map() : new Map(state);
    for(const k of d.gone||[]) s.delete(k);
    for(const l of d.links||[]) s.set(key(l.a,l.b), l);
    return s;
  }

  function path(links, from, to, onlyConfirmed){
    if(from===to) return [from];
    const adj=new Map();
    const add=(x,y)=>{ if(!adj.has(x)) adj.set(x,[]); adj.get(x).push(y); };
    for(const l of links){ if(onlyConfirmed && !l.confirmed) continue; add(l.a,l.b); add(l.b,l.a); }
    const prev=new Map([[from,null]]), q=[from];
    while(q.length){
      const x=q.shift();
      for(const y of adj.get(x)||[]){
        if(prev.has(y)) continue;
        prev.set(y,x);
        if(y===to){ const p=[y]; let c=x; while(c!==null){ p.push(c); c=prev.get(c); } return p.reverse(); }
        q.push(y);
      }
    }
    return null;
  }

  // Псевдослучайность с зерном: одна и та же сеть раскладывается одинаково.
  function rnd(seed){ let s=seed>>>0||1; return ()=>((s=Math.imul(s^s>>>15, 2246822507)^Math.imul(s^s>>>13,3266489909))>>>0)/4294967296; }

  // Ближайшая точка отрезка a–b к точке p: доля t вдоль отрезка и расстояние.
  function toSeg(p, a, b){
    const dx=b.x-a.x, dy=b.y-a.y, l2=dx*dx+dy*dy;
    const t=l2 ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2)) : 0;
    const qx=a.x+t*dx, qy=a.y+t*dy;
    return {t, d:Math.hypot(p.x-qx, p.y-qy), qx, qy, dx, dy};
  }
  // Направление «от линии к узлу»; если узел ровно на линии — перпендикуляр.
  function away(p, s){
    let nx=p.x-s.qx, ny=p.y-s.qy, n=Math.hypot(nx,ny);
    if(n<1e-6){ nx=-s.dy; ny=s.dx; n=Math.hypot(nx,ny)||1; }
    return {x:nx/n, y:ny/n};
  }

  // До стольких узлов карту раскладываем заново на каждой смене связей:
  // это быстро и даёт чистую картинку. Большие карты держатся за прежние
  // места, иначе при каждом обновлении всё прыгает.
  const COLD=80, GAP=40;
  // Быстрый отсев: точка далеко от прямоугольника ребра — считать нечего.
  const outBox=(p,a,b,g)=>p.x<Math.min(a.x,b.x)-g || p.x>Math.max(a.x,b.x)+g || p.y<Math.min(a.y,b.y)-g || p.y>Math.max(a.y,b.y)+g;

  // Силовая раскладка: рёбра тянут, узлы расталкиваются, а чужие рёбра
  // отталкивают узел — иначе линия идёт прямо через зону, которой она не
  // касается, и кажется, что дорога ведёт через неё.
  function layout(nodes, edges, prev, seed){
    if(nodes.length<=COLD) prev=new Map();
    // list[i] всегда соответствует nodes[i]: по этой нумерации идут и силы,
    // и итог. Сначала ставим известные узлы, потом новые рядом с соседом.
    const R=rnd(seed), list=new Array(nodes.length), at=new Map(nodes.map((n,i)=>[n,i]));
    nodes.forEach((n,i)=>{ if(prev.has(n)){ const p=prev.get(n); list[i]={x:p.x,y:p.y,ax:p.x,ay:p.y}; } });
    nodes.forEach((n,i)=>{
      if(list[i]) return;
      const nb=edges.find(e=>(e[0]===n&&list[at.get(e[1])])||(e[1]===n&&list[at.get(e[0])]));
      const o=nb ? list[at.get(nb[0]===n?nb[1]:nb[0])] : {x:0,y:0};
      list[i]={x:o.x+(R()-.5)*80, y:o.y+(R()-.5)*80, ax:null, ay:null};
    });
    const E=[];
    for(const [a,b] of edges){ const i=at.get(a), j=at.get(b); if(i!=null&&j!=null&&i!==j) E.push([i,j]); }
    // Длина ребра побольше на маленькой карте: между узлами помещается подпись.
    const rest=nodes.length<=COLD ? 100 : 70;
    // Тёплый старт: если есть прежние позиции, сеть уже устоялась — мало шагов,
    // низкая температура и жёсткая привязка, чтобы карта не прыгала.
    const warm=list.some(p=>p.ax!==null), iters=warm?80:300, t0=warm?0.04:1, pull=warm?1.0:0.3;
    for(let it=0; it<iters; it++){
      const f=list.map(()=>({x:0,y:0}));
      for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++){
        let dx=list[i].x-list[j].x, dy=list[i].y-list[j].y, d2=dx*dx+dy*dy+0.01;
        if(d2>250000) continue;
        const k=2400/d2; f[i].x+=dx*k; f[i].y+=dy*k; f[j].x-=dx*k; f[j].y-=dy*k;
      }
      for(const [i,j] of E){
        const dx=list[j].x-list[i].x, dy=list[j].y-list[i].y, d=Math.hypot(dx,dy)||1, k=(d-rest)*0.04;
        f[i].x+=dx/d*k*d/10; f[i].y+=dy/d*k*d/10; f[j].x-=dx/d*k*d/10; f[j].y-=dy/d*k*d/10;
      }
      // Чужое ребро ближе GAP — узел отходит по нормали, концы ребра в другую сторону.
      if(it>iters/3) for(let k=0;k<list.length;k++) for(const [i,j] of E){
        if(k===i||k===j || outBox(list[k],list[i],list[j],GAP)) continue;
        const p=list[k], s=toSeg(p, list[i], list[j]); if(s.d>=GAP) continue;
        const n=away(p,s), push=(GAP-s.d)*0.6;
        f[k].x+=n.x*push; f[k].y+=n.y*push;
        f[i].x-=n.x*push*(1-s.t)*0.5; f[i].y-=n.y*push*(1-s.t)*0.5;
        f[j].x-=n.x*push*s.t*0.5; f[j].y-=n.y*push*s.t*0.5;
      }
      const t=t0*(1-it/iters);
      list.forEach((p,i)=>{
        if(p.ax!==null){ f[i].x+=(p.ax-p.x)*pull; f[i].y+=(p.ay-p.y)*pull; }
        p.x+=Math.max(-8,Math.min(8,f[i].x))*t; p.y+=Math.max(-8,Math.min(8,f[i].y))*t;
      });
    }
    // Дочистка: сила к концу остывает, поэтому последние нарушения правим
    // прямо сдвигом. Двигаем в основном узел, концы ребра — чуть-чуть.
    for(let it=0; it<60; it++){
      let bad=false;
      for(let k=0;k<list.length;k++) for(const [i,j] of E){
        if(k===i||k===j || outBox(list[k],list[i],list[j],GAP)) continue;
        const p=list[k], s=toSeg(p, list[i], list[j]); if(s.d>=GAP*0.8) continue;
        bad=true;
        const n=away(p,s), m=(GAP*0.8-s.d)+1;
        p.x+=n.x*m*0.7; p.y+=n.y*m*0.7;
        list[i].x-=n.x*m*0.3*(1-s.t); list[i].y-=n.y*m*0.3*(1-s.t);
        list[j].x-=n.x*m*0.3*s.t; list[j].y-=n.y*m*0.3*s.t;
      }
      if(!bad) break;
    }
    const out=new Map(); nodes.forEach((n,i)=>out.set(n,{x:list[i].x,y:list[i].y}));
    return out;
  }

  // Подписи рёбер. Каждая — у середины своего ребра: x,y середина, dx,dy
  // единичный вектор вдоль ребра, len его длина, w,h размер подписи.
  // Ставим сбоку от линии с зазором 8 px и по очереди: подпись берёт
  // ближайшее к середине место (сдвиг вдоль ребра, потом другая сторона),
  // где не накрывает узлы, имена узлов (obs: {x,y,r} круг или {x,y,w,h}
  // прямоугольник по центру) и уже поставленные подписи. Если места нет
  // вовсе — где меньше всего налезаний. Возвращает центры подписей.
  function labels(items, obs){
    const PAD=2, placed=[], out=[];
    const hitRect=(a,b)=>Math.abs(a.x-b.x)<(a.w+b.w)/2+PAD && Math.abs(a.y-b.y)<(a.h+b.h)/2+PAD;
    const hitCircle=(a,c)=>{
      const px=Math.max(a.x-a.w/2,Math.min(c.x,a.x+a.w/2)), py=Math.max(a.y-a.h/2,Math.min(c.y,a.y+a.h/2));
      return Math.hypot(px-c.x,py-c.y)<c.r+PAD;
    };
    const cost=r=>{
      let n=0;
      for(const o of obs) if(o.r!=null ? hitCircle(r,o) : hitRect(r,o)) n++;
      for(const q of placed) if(hitRect(r,q)) n++;
      return n;
    };
    for(const it of items){
      // Нормаль смотрит вверх (а у вертикали — вправо): первая попытка у всех одинаковая.
      let nx=-it.dy, ny=it.dx;
      if(ny>0 || (ny===0 && nx<0)){ nx=-nx; ny=-ny; }
      const off=8+Math.abs(nx)*it.w/2+Math.abs(ny)*it.h/2;
      const lim=Math.max(0,(it.len||0)/2-12), step=10;
      let best=null, bestCost=Infinity;
      for(let k=0; k*step<=lim+step && bestCost>0; k++){
        for(const sh of k ? [k*step,-k*step] : [0]){
          const s=Math.max(-lim,Math.min(lim,sh));
          for(const side of [1,-1]){
            const r={x:it.x+it.dx*s+nx*off*side, y:it.y+it.dy*s+ny*off*side, w:it.w, h:it.h};
            const c=cost(r);
            if(c<bestCost){ best=r; bestCost=c; if(!c) break; }
          }
          if(!bestCost) break;
        }
      }
      placed.push(best); out.push({x:best.x, y:best.y});
    }
    return out;
  }

  // Живой граф (как в Obsidian): узлы — частицы, которые расталкиваются,
  // дороги — пружины, а слабая тяга к центру собирает все цепочки в одно
  // облако. step() — один шаг: N — Map узел -> {x,y,vx,vy}, alpha —
  // «температура» (1 — только начали, к нулю всё успокаивается), held —
  // узел, который держит мышь (его не двигаем). Возвращает новую alpha.
  const SIM={charge:-700, linkDist:150, linkK:0.3, gravity:0.03, gapX:150, gapY:52, damp:0.6, decay:0.0228};
  // Препятствия зоны для чужих дорог: кружок и подпись под ним (oy — сдвиг
  // центра вверх от подписи к кружку, sx — сжатие по горизонтали).
  const AVOID=[{oy:0, sx:1, gap:26}, {oy:-24, sx:5.5, gap:15}];
  function step(N, edges, alpha, held){
    const A=[...N.entries()];
    for(let i=0;i<A.length;i++){
      const a=A[i][1];
      for(let j=i+1;j<A.length;j++){
        const b=A[j][1]; let dx=b.x-a.x, dy=b.y-a.y, d2=dx*dx+dy*dy;
        if(d2<1e-6){ dx=(i-j)*0.01; dy=0.01; d2=dx*dx+dy*dy; }
        if(d2<400*400){
          const w=SIM.charge*alpha/Math.max(d2, 30*30);
          a.vx+=dx*w; a.vy+=dy*w; b.vx-=dx*w; b.vy-=dy*w;
        }
        // Узлы не слипаются: под каждым подпись, а подписи разной длины —
        // поэтому зазор по горизонтали считаем по их ширине (w), если она
        // известна, по вертикали — кружок плюс строка.
        const gx=(a.w!=null&&b.w!=null) ? (a.w+b.w)/2+16 : SIM.gapX, gy=SIM.gapY;
        const ox=gx-Math.abs(dx), oy=gy-Math.abs(dy);
        if(ox>0 && oy>0){
          // Раздвигаем по той оси, где налезание меньше (так быстрее разойдутся).
          if(ox/gx < oy/gy){ const m=(dx>=0?1:-1)*ox*0.25; a.vx-=m; b.vx+=m; }
          else { const m=(dy>=0?1:-1)*oy*0.25; a.vy-=m; b.vy+=m; }
        }
      }
    }
    for(const [x,y] of edges){
      const a=N.get(x), b=N.get(y); if(!a||!b||a===b) continue;
      const dx=b.x+b.vx-a.x-a.vx, dy=b.y+b.vy-a.y-a.vy, d=Math.hypot(dx,dy)||1;
      const k=(d-SIM.linkDist)/d*alpha*SIM.linkK;
      a.vx+=dx*k*0.5; a.vy+=dy*k*0.5; b.vx-=dx*k*0.5; b.vy-=dy*k*0.5;
    }
    // Чужая дорога не проходит ни через зону, ни через её подпись: иначе
    // кажется, что путь ведёт через неё. Подпись — широкий прямоугольник под
    // кружком; считаем её в сжатых по горизонтали координатах, где она почти
    // квадрат. Зона отходит от линии, концы линии — в другую сторону. Без
    // alpha: правило держится и когда граф уже успокоился.
    for(const [x,y] of edges){
      const a=N.get(x), b=N.get(y); if(!a||!b||a===b) continue;
      for(const [c,p] of A){
        if(c===x||c===y || outBox(p,a,b,80)) continue;
        for(const o of AVOID){
          const P={x:p.x/o.sx, y:p.y+o.oy}, sa={x:a.x/o.sx, y:a.y}, sb={x:b.x/o.sx, y:b.y};
          const sg=toSeg(P,sa,sb); if(sg.d>=o.gap) continue;
          const n=away(P,sg), m=(o.gap-sg.d)*0.15, nx=n.x*o.sx;
          p.vx+=nx*m; p.vy+=n.y*m;
          a.vx-=nx*m*(1-sg.t)*0.5; a.vy-=n.y*m*(1-sg.t)*0.5;
          b.vx-=nx*m*sg.t*0.5; b.vy-=n.y*m*sg.t*0.5;
        }
      }
    }
    for(const [c,p] of A){
      // По вертикали тянем сильнее: экраны широкие, сеть ложится вширь.
      p.vx-=p.x*SIM.gravity*alpha; p.vy-=p.y*SIM.gravity*1.8*alpha;
      if(c===held){ p.vx=0; p.vy=0; continue; }
      p.vx*=SIM.damp; p.vy*=SIM.damp; p.x+=p.vx; p.y+=p.vy;
    }
    return alpha*(1-SIM.decay);
  }
  // Узлы для живого графа: прежние места сохраняем, новые ставим рядом с
  // соседом (или по спирали, если соседа ещё нет), чтобы граф не прыгал.
  function simNodes(nodes, edges, prev, seed, widths){
    const N=new Map(); let k=0;
    // Разные зёрна — разный порядок и поворот спирали: разные стартовые раскладки.
    if(seed){ const R=rnd(seed); nodes=nodes.map(n=>[R(),n]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]); k=Math.floor(R()*7); }
    for(const n of nodes) if(prev && prev.has(n)){ const p=prev.get(n); N.set(n,{x:p.x,y:p.y,vx:0,vy:0}); }
    for(const n of nodes){
      if(N.has(n)) continue;
      const e=edges.find(([a,b])=>(a===n&&N.has(b))||(b===n&&N.has(a)));
      const o=e ? N.get(e[0]===n?e[1]:e[0]) : null, ang=k*2.39996, r=o?40:60*Math.sqrt(++k);
      N.set(n,{x:(o?o.x:0)+Math.cos(ang)*r, y:(o?o.y:0)+Math.sin(ang)*r, vx:0, vy:0});
      if(o) k++;
    }
    if(widths) for(const [n,p] of N) p.w=widths.get(n);
    return N;
  }

  // Сколько пар дорог пересекаются (дороги с общей зоной не считаем).
  function crossings(N, edges){
    const cr=(p,q,r,s)=>{
      const d=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
      return d(p,q,r)*d(p,q,s)<0 && d(r,s,p)*d(r,s,q)<0;
    };
    let n=0;
    for(let i=0;i<edges.length;i++) for(let j=i+1;j<edges.length;j++){
      const [a,b]=edges[i], [c,e]=edges[j];
      if(a===c||a===e||b===c||b===e) continue;
      if(cr(N.get(a),N.get(b),N.get(c),N.get(e))) n++;
    }
    return n;
  }
  // Первая раскладка: несколько стартов, берём ту, где меньше всего
  // пересечений дорог (при равенстве — первую). Большие сети — один старт.
  function settle(nodes, edges, tries, steps, widths){
    let best=null, bestN=Infinity;
    const T=nodes.length<=80 ? tries : 1;
    for(let s=0;s<T;s++){
      const N=simNodes(nodes, edges, null, s, widths); let a=1;
      for(let i=0;i<steps;i++) a=step(N,edges,a,null);
      const c=crossings(N,edges);
      if(c<bestN){ best=N; bestN=c; if(!c) break; }
    }
    return best;
  }
  // Распутывание после физики: зоны, чьи дороги пересекаются, пробуют встать
  // на другие места (вместе со своими «листьями» — соседями без других
  // дорог) и остаются там, где цена меньше: пересечение дорог — дорого,
  // налезшие подписи — дешевле, далеко от прежнего места — чуть-чуть.
  // Сети дорог почти всегда деревья, у них раскладка без пересечений есть.
  function untangle(N, edges, rounds){
    const deg=new Map(), adj=new Map();
    for(const [a,b] of edges){
      for(const [x,y] of [[a,b],[b,a]]){ deg.set(x,(deg.get(x)||0)+1); if(!adj.has(x)) adj.set(x,[]); adj.get(x).push(y); }
    }
    const nodes=[...N.keys()];
    // Ветка за дорогой u–v со стороны v; null — если по кругу можно вернуться к u.
    const branch=(v,u)=>{
      const seen=new Set([v]), q=[v];
      while(q.length){ const x=q.pop(); for(const y of adj.get(x)||[]){ if(x===v&&y===u) continue; if(y===u) return null; if(!seen.has(y)){ seen.add(y); q.push(y); } } }
      return [...seen];
    };
    const overlaps=()=>{
      let n=0;
      for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
        const a=N.get(nodes[i]), b=N.get(nodes[j]);
        const gx=(a.w!=null&&b.w!=null)?(a.w+b.w)/2+8:SIM.gapX, gy=SIM.gapY-6;
        if(Math.abs(a.x-b.x)<gx && Math.abs(a.y-b.y)<gy) n++;
      }
      return n;
    };
    // Дорога, проходящая через чужую зону (ближе 16 px к кружку), выглядит
    // так, будто ведёт через неё, — почти так же плохо, как пересечение.
    const cuts=()=>{
      let n=0;
      for(const [a,b] of edges){
        const A=N.get(a), B=N.get(b);
        for(const c of nodes){
          if(c===a||c===b) continue;
          const p=N.get(c); if(outBox(p,A,B,16)) continue;
          const sg=toSeg(p,A,B); if(sg.d<16 && sg.t>0 && sg.t<1) n++;
        }
      }
      return n;
    };
    const cost=()=>crossings(N,edges)*1000+cuts()*700+overlaps()*60;
    const pairs=()=>{
      const out=[];
      const cr=(p,q,r,t)=>{ const d=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x); return d(p,q,r)*d(p,q,t)<0 && d(r,t,p)*d(r,t,q)<0; };
      for(let i=0;i<edges.length;i++) for(let j=i+1;j<edges.length;j++){
        const [a,b]=edges[i], [c,e]=edges[j];
        if(a===c||a===e||b===c||b===e) continue;
        if(cr(N.get(a),N.get(b),N.get(c),N.get(e))) out.push([edges[i],edges[j]]);
      }
      return out;
    };
    let cur=cost();
    const cutters=()=>{
      const out=new Set();
      for(const [a,b] of edges){ const A=N.get(a), B=N.get(b);
        for(const c of nodes){ if(c===a||c===b) continue; const p=N.get(c); if(outBox(p,A,B,16)) continue;
          const sg=toSeg(p,A,B); if(sg.d<16 && sg.t>0 && sg.t<1){ out.add(a); out.add(b); out.add(c); } } }
      return out;
    };
    for(let r=0; r<(rounds||40) && cur>=600; r++){
      const ps=pairs(), cs=cutters(); if(!ps.length && !cs.size) break;
      const movers=[...new Set([...ps.flat(2), ...cs])].sort((a,b)=>(deg.get(a)||0)-(deg.get(b)||0));
      let improved=false;
      for(const v of movers){
        // Ходы: (1) узел с листьями-соседями — сдвиг по кругам; (2) вся ветка
        // за дорогой u–v (то, что отвалится, если её убрать) — поворот вокруг u.
        const moves=[];
        const leafGroup=[v, ...(adj.get(v)||[]).filter(u=>deg.get(u)===1)];
        const p=N.get(v);
        if(deg.get(v)===1){
          const u=N.get(adj.get(v)[0]);
          for(let k=1;k<24;k++) moves.push({group:[v], rot:{c:u, t:k*Math.PI/12}});
        } else {
          for(const R of [90,180,280]) for(let k=0;k<16;k++){ const t=k*Math.PI/8; moves.push({group:leafGroup, dx:Math.cos(t)*R, dy:Math.sin(t)*R}); }
        }
        for(const u of adj.get(v)||[]){
          const side=branch(v,u);
          if(!side || side.length>nodes.length/2+1) continue;
          for(let k=1;k<12;k++) moves.push({group:side, rot:{c:N.get(u), t:k*Math.PI/6}});
        }
        let best=null, bestC=cur;
        for(const m of moves){
          const home=m.group.map(g=>{ const q=N.get(g); return [q, q.x, q.y]; });
          let shift=0;
          for(const [q,x,y] of home){
            if(m.rot){ const c=m.rot.c, cs=Math.cos(m.rot.t), sn=Math.sin(m.rot.t), rx=x-c.x, ry=y-c.y; q.x=c.x+rx*cs-ry*sn; q.y=c.y+rx*sn+ry*cs; }
            else { q.x=x+m.dx; q.y=y+m.dy; }
            shift+=Math.hypot(q.x-x,q.y-y);
          }
          const cc=cost()+shift*0.01/m.group.length;
          if(cc<bestC-0.5){ best=home.map(([q])=>[q,q.x,q.y]); bestC=cc; }
          for(const [q,x,y] of home){ q.x=x; q.y=y; }
        }
        if(best){ for(const [q,x,y] of best){ q.x=x; q.y=y; } cur=cost(); improved=true; }
      }
      if(!improved) break;
    }
    for(const p of N.values()){ p.vx=0; p.vy=0; }
    return N;
  }
  function left(closesAt, now){
    const s=closesAt-now; if(s<=0) return 'закрыт';
    const h=Math.floor(s/3600), m=Math.floor(s%3600/60);
    return h ? `${h} ч ${m} м` : m ? `${m} м` : '<1 м';
  }

  function soon(links, now, hours){
    return links.filter(l=>l.closesAt-now<hours*3600 && l.closesAt>now).sort((a,b)=>a.closesAt-b.closesAt);
  }

  // Связь, у которой вышло время, убираем сами, не дожидаясь сервера: вкладка
  // могла не достучаться до него, а мёртвый портал на карте хуже пустоты.
  function prune(state, now){
    let gone=false;
    for(const l of state.values()) if(l.closesAt<=now){ gone=true; break; }
    if(!gone) return state;
    const s=new Map();
    for(const [k,l] of state) if(l.closesAt>now) s.set(k,l);
    return s;
  }

  // Пауза перед следующим опросом после fails неудач подряд: 30 с, 1 мин,
  // 2 мин… но не больше 10 минут, чтобы починенный сервер подхватился сам.
  function backoff(fails){ return Math.min(600000, 15000*2**fails); }

  g.AvalonCore={key, merge, path, layout, step, simNodes, crossings, settle, untangle, labels, left, soon, prune, backoff};
})(typeof globalThis!=='undefined'?globalThis:this);
