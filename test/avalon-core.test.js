const test = require('node:test');
const assert = require('node:assert');
require('../avalon-core.js');
const C = globalThis.AvalonCore;
const L = (a,b,c,conf=false)=>({a,b,closesAt:c,confirmed:conf,n:1});

test('merge: full заменяет, since дополняет, gone удаляет', ()=>{
  let s = C.merge(new Map(), {full:true, links:[L('A','B',100), L('B','C',200)], gone:[]});
  assert.equal(s.size, 2);
  s = C.merge(s, {full:false, links:[L('C','D',300)], gone:['A|B']});
  assert.deepEqual([...s.keys()].sort(), ['B|C','C|D']);
  s = C.merge(s, {full:true, links:[L('X','Y',1)], gone:[]});
  assert.deepEqual([...s.keys()], ['X|Y']);
});

test('path: кратчайший, в обе стороны, с фильтром подтверждённых', ()=>{
  const links = [L('A','B',1,true), L('B','C',1,false), L('A','D',1,true), L('D','C',1,true)];
  assert.deepEqual(C.path(links,'C','A',false).length, 3);
  assert.deepEqual(C.path(links,'A','C',true), ['A','D','C']);
  assert.equal(C.path(links,'A','Z',false), null);
  assert.deepEqual(C.path(links,'A','A',false), ['A']);
});

test('layout: детерминирован; маленькая карта раскладывается заново, без прежних мест', ()=>{
  const nodes=['A','B','C'], edges=[['A','B'],['B','C']];
  const p1=C.layout(nodes,edges,new Map(),7), p2=C.layout(nodes,edges,new Map(),7);
  assert.deepEqual([...p1], [...p2]);
  // До 80 узлов холодная раскладка чище тёплой и быстрая: прежние места не держим.
  const far=new Map(nodes.map((n,i)=>[n,{x:1000+i*500,y:-800}]));
  assert.deepEqual([...C.layout(nodes,edges,far,7)], [...p1]);
});

// Отрезок ребра не должен проходить через чужой узел: иначе кажется, что
// дорога идёт через эту зону. Случай с живой карты: Setos связан с Xoritos,
// Giantweald, Floatshoal и Thirstwater, Xoritos — с Thunderrock.
const segDist=(p,a,b)=>{
  const dx=b.x-a.x, dy=b.y-a.y, l2=dx*dx+dy*dy||1;
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l2));
  return Math.hypot(p.x-a.x-t*dx, p.y-a.y-t*dy);
};
function farFromEdges(nodes, edges, pos, min){
  for(const n of nodes) for(const [a,b] of edges){
    if(n===a||n===b) continue;
    const d=segDist(pos.get(n),pos.get(a),pos.get(b));
    assert.ok(d>=min, `${n} в ${d.toFixed(1)} px от ребра ${a}–${b}`);
  }
}
test('layout: ребро не проходит через чужой узел (случай со скриншота)', ()=>{
  const nodes=['F','G','S','T','W','X'];
  const edges=[['S','X'],['S','G'],['X','T'],['S','F'],['S','W']];
  for(const seed of [1,7,42,1234]) farFromEdges(nodes, edges, C.layout(nodes,edges,new Map(),seed), 25);
  // На живой карте связи приходили по одной, и раскладка шла от прежних мест.
  let pos=new Map(); const got=[];
  for(const e of edges){ got.push(e); pos=C.layout([...new Set(got.flat())].sort(), got, pos, 7); }
  farFromEdges(nodes, edges, pos, 25);
});
test('layout: и на сети побольше узлы не лежат на чужих рёбрах', ()=>{
  const nodes=[], edges=[];
  for(let i=0;i<30;i++){ nodes.push('z'+i); if(i) edges.push(['z'+Math.floor(i/3),'z'+i]); }
  edges.push(['z4','z9'],['z2','z20']);
  for(let seed=1;seed<=20;seed++) farFromEdges(nodes, edges, C.layout(nodes,edges,new Map(),seed), 25);
});

// Подписи рёбер: прямоугольники с центром x,y и размером w,h.
const over=(a,b)=>Math.abs(a.x-b.x)<(a.w+b.w)/2 && Math.abs(a.y-b.y)<(a.h+b.h)/2;
const onCircle=(r,c)=>{
  const px=Math.max(r.x-r.w/2,Math.min(c.x,r.x+r.w/2)), py=Math.max(r.y-r.h/2,Math.min(c.y,r.y+r.h/2));
  return Math.hypot(px-c.x,py-c.y)<c.r;
};
test('labels: подпись отступает от линии по нормали', ()=>{
  const [p]=C.labels([{x:0,y:0,dx:1,dy:0,len:200,w:40,h:14}], []);
  assert.equal(p.x, 0);
  const gap=Math.abs(p.y)-7;
  assert.ok(gap>=8 && gap<=10, 'зазор '+gap);
});
test('labels: подписи не налезают друг на друга и на узлы', ()=>{
  const items=[
    {x:0,y:0,dx:1,dy:0,len:200,w:60,h:14},
    {x:0,y:0,dx:Math.SQRT1_2,dy:Math.SQRT1_2,len:200,w:60,h:14},
    {x:4,y:2,dx:0,dy:1,len:200,w:60,h:14},
  ];
  const obs=[{x:0,y:-16,r:12},{x:30,y:20,r:12}];
  const out=C.labels(items, obs);
  const R=out.map((p,i)=>({x:p.x,y:p.y,w:items[i].w,h:items[i].h}));
  for(let i=0;i<R.length;i++){
    for(let j=i+1;j<R.length;j++) assert.ok(!over(R[i],R[j]), `подписи ${i} и ${j} пересеклись`);
    for(const c of obs) assert.ok(!onCircle(R[i],c), `подпись ${i} на узле`);
  }
});
test('labels: прямоугольные препятствия (имена узлов) тоже обходятся', ()=>{
  const [p]=C.labels([{x:0,y:0,dx:1,dy:0,len:300,w:50,h:14}], [{x:0,y:-15,w:80,h:14},{x:0,y:15,w:80,h:14}]);
  assert.ok(!over({x:p.x,y:p.y,w:50,h:14},{x:0,y:-15,w:80,h:14}));
  assert.ok(!over({x:p.x,y:p.y,w:50,h:14},{x:0,y:15,w:80,h:14}));
});

test('left и soon', ()=>{
  assert.equal(C.left(1000+5*3600+12*60, 1000), '5 ч 12 м');
  assert.equal(C.left(1000+23*60+5, 1000), '23 м');
  assert.equal(C.left(900, 1000), 'закрыт');
  assert.equal(C.left(1000+30, 1000), '<1 м');
  const s=C.soon([L('A','B',1000+7200), L('C','D',1000+600), L('E','F',1000+90000)], 1000, 3);
  assert.deepEqual(s.map(x=>x.a), ['C','A']);
});

test('layout: на 200 узлах добавление листа не сдвигает карту', ()=>{
  let s=12345; const R=()=>((s=Math.imul(s^s>>>15,2246822507)^Math.imul(s^s>>>13,3266489909))>>>0)/4294967296;
  const nodes=['n0'], edges=[];
  for(let i=1;i<200;i++){ nodes.push('n'+i); edges.push(['n'+Math.floor(R()*i),'n'+i]); }
  const p1=C.layout(nodes,edges,new Map(),7);
  const p2=C.layout([...nodes,'leaf'],[...edges,['n77','leaf']],p1,7);
  const d=nodes.map(k=>Math.hypot(p2.get(k).x-p1.get(k).x,p2.get(k).y-p1.get(k).y)).sort((a,b)=>a-b);
  const med=d[d.length>>1], max=d[d.length-1];
  console.log('shift median',med.toFixed(2),'max',max.toFixed(2));
  assert.ok(med<10,'медиана '+med);
  assert.ok(max<40,'максимум '+max);
});

test('prune: закрывшиеся связи убираются на месте, живые остаются', ()=>{
  const s = C.merge(new Map(), {full:true, links:[L('A','B',100), L('B','C',200), L('C','D',300)], gone:[]});
  const p = C.prune(s, 200);
  assert.deepEqual([...p.keys()], ['C|D']);
  assert.equal(s.size, 3, 'исходная карта не меняется');
  assert.equal(C.prune(p, 200), p, 'ничего не закрылось — та же карта');
});

test('backoff: после неудач ждём дольше, но не больше 10 минут', ()=>{
  assert.equal(C.backoff(1), 30000);
  assert.equal(C.backoff(2), 60000);
  assert.ok(C.backoff(5) > C.backoff(4));
  assert.equal(C.backoff(20), 600000);
});

test('step: граф успокаивается, связанные ближе несвязанных, узлы не слипаются', ()=>{
  const edges=[['A','B'],['B','C'],['C','A'],['D','E'],['F','G'],['G','H']];
  const nodes=[...new Set(edges.flat())].sort();
  const run=()=>{ const N=C.simNodes(nodes, edges, null); let a=1; for(let i=0;i<400;i++) a=C.step(N,edges,a,null); return N; };
  const N=run(), M=run();
  assert.deepEqual([...N].map(([k,p])=>[k,p.x.toFixed(6)]), [...M].map(([k,p])=>[k,p.x.toFixed(6)]), 'не детерминирован');
  const d=(a,b)=>Math.hypot(N.get(a).x-N.get(b).x, N.get(a).y-N.get(b).y);
  for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) assert.ok(d(nodes[i],nodes[j])>=34, `${nodes[i]}–${nodes[j]} слиплись: ${d(nodes[i],nodes[j]).toFixed(0)}`);
  const linked=edges.reduce((s,[a,b])=>s+d(a,b),0)/edges.length;
  assert.ok(linked<d('A','H') && linked<d('D','F'), 'связанные не ближе');
  // Все цепочки — одним облаком, а не разлетелись.
  for(const n of nodes) assert.ok(Math.hypot(N.get(n).x, N.get(n).y)<600, n+' улетел');
  // Успокоился: скорости почти нулевые.
  for(const p of N.values()) assert.ok(Math.hypot(p.vx,p.vy)<0.5);
});

test('simNodes: прежние места сохраняются, новый узел — рядом с соседом', ()=>{
  const prev=new Map([['A',{x:100,y:50}]]);
  const N=C.simNodes(['A','B'], [['A','B']], prev);
  assert.deepEqual([N.get('A').x, N.get('A').y], [100,50]);
  assert.ok(Math.hypot(N.get('B').x-100, N.get('B').y-50)<=41);
});

test('step: чужая дорога не режет ни зону, ни её подпись (карта 8 октября 2026)', ()=>{
  const edges=require('./roads-2026-10-08.json'), nodes=[...new Set(edges.flat())].sort();
  const N=C.simNodes(nodes,edges,null); let a=1;
  for(let i=0;i<700;i++) a=C.step(N,edges,a,null);
  // Кружок 28×28 и подпись 130×18 под ним (центр на 24 px ниже).
  const cuts=(A,B,r)=>{ for(let t=0;t<=1;t+=0.01){ const x=A.x+(B.x-A.x)*t, y=A.y+(B.y-A.y)*t; if(Math.abs(x-r.x)<r.w/2 && Math.abs(y-r.y)<r.h/2) return true; } return false; };
  for(const [x,y] of edges) for(const n of nodes){
    if(n===x||n===y) continue;
    const p=N.get(n);
    assert.ok(!cuts(N.get(x),N.get(y),{x:p.x,y:p.y,w:28,h:28}), `${x}–${y} проходит через зону ${n}`);
    assert.ok(!cuts(N.get(x),N.get(y),{x:p.x,y:p.y+24,w:130,h:18}), `${x}–${y} проходит через подпись ${n}`);
  }
});

test('settle: на карте 8 октября дороги не пересекаются', ()=>{
  const edges=require('./roads-2026-10-08.json'), nodes=[...new Set(edges.flat())].sort();
  const one=C.simNodes(nodes,edges,null,0); let a=1; for(let i=0;i<400;i++) a=C.step(one,edges,a,null);
  const N=C.settle(nodes, edges, 8, 400);
  assert.equal(C.crossings(N,edges), 0, `пересечений: ${C.crossings(N,edges)} (один старт: ${C.crossings(one,edges)})`);
});
test('crossings: считает только настоящие пересечения', ()=>{
  const N=new Map([['A',{x:0,y:0}],['B',{x:10,y:10}],['C',{x:0,y:10}],['D',{x:10,y:0}],['E',{x:20,y:20}]]);
  assert.equal(C.crossings(N,[['A','B'],['C','D']]),1);
  assert.equal(C.crossings(N,[['A','B'],['B','E']]),0);
});
