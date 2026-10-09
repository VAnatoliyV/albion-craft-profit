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

test('tidy: плашки не перекрываются и на каждом ребре есть место под время', ()=>{
  const names=['Peritos-Oconun','Settun-Tersom','Quaent-Qintis','Fones-Opavun','Setent-Al-Duosas','Xiros-Aiirom','Qiient-Oc-Odetum','Secent-Et-Qinsas','Cynos-Oxaeaum','Qiitun-Et-Vynsom','Settun-Al-Tersom'];
  const edges=[['Settun-Tersom','Peritos-Oconun'],['Settun-Tersom','Quaent-Qintis'],['Fones-Opavun','Setent-Al-Duosas'],['Fones-Opavun','Xiros-Aiirom'],['Fones-Opavun','Qiient-Oc-Odetum'],['Fones-Opavun','Secent-Et-Qinsas'],['Cynos-Oxaeaum','Qiitun-Et-Vynsom'],['Cynos-Oxaeaum','Settun-Al-Tersom']];
  const dims=new Map(names.map(n=>[n,{w:40+n.length*7,h:24}]));
  for(const seed of [1,7,42]){
    const pos=C.tidy(C.layout(names.slice().sort(), edges, new Map(), seed), edges, dims);
    for(let i=0;i<names.length;i++) for(let j=i+1;j<names.length;j++){
      const a=pos.get(names[i]), b=pos.get(names[j]), da=dims.get(names[i]), db=dims.get(names[j]);
      const apart=Math.abs(a.x-b.x)>=(da.w+db.w)/2 || Math.abs(a.y-b.y)>=(da.h+db.h)/2;
      assert.ok(apart, `${names[i]} и ${names[j]} налезают (зерно ${seed})`);
    }
    for(const [x,y] of edges){
      const a=pos.get(x), b=pos.get(y), dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy);
      const free=d-C.reach(dims.get(x),dx/d,dy/d)-C.reach(dims.get(y),dx/d,dy/d);
      assert.ok(free>=60, `${x}–${y}: под время только ${free.toFixed(0)} px`);
    }
  }
});

test('tidy: разные цепочки не перемешиваются — их рамки не пересекаются', ()=>{
  const edges=[['A','B'],['B','C'],['D','E'],['F','G'],['G','H'],['H','F']];
  const nodes=[...new Set(edges.flat())].sort();
  const dims=new Map(nodes.map(n=>[n,{w:120,h:24}]));
  const pos=C.tidy(C.layout(nodes, edges, new Map(), 7), edges, dims);
  const rect=g=>{ const xs=g.map(n=>pos.get(n).x), ys=g.map(n=>pos.get(n).y); return {x0:Math.min(...xs)-60,x1:Math.max(...xs)+60,y0:Math.min(...ys)-12,y1:Math.max(...ys)+12}; };
  const R=[rect(['A','B','C']), rect(['D','E']), rect(['F','G','H'])];
  for(let i=0;i<R.length;i++) for(let j=i+1;j<R.length;j++){
    const a=R[i], b=R[j];
    assert.ok(a.x1<=b.x0||b.x1<=a.x0||a.y1<=b.y0||b.y1<=a.y0, `цепочки ${i} и ${j} пересекаются`);
  }
});
