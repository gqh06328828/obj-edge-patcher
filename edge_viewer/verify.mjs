import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parsePLY,parseOBJ,mapEdges} from './mesh-data.mjs';
const require=createRequire(import.meta.url),XLSX=require('./vendor/xlsx.full.min.js');
const root=path.resolve(import.meta.dirname,'../manual_test/v3');
let total=0;
for(const filename of fs.readdirSync(root).filter(n=>n.endsWith('.csv'))){
  const buffer=fs.readFileSync(path.join(root,filename.replace('__edge_boundary_probability.csv','__epoch09__segmented.ply')));
  const mesh=parsePLY(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
  const book=XLSX.read(fs.readFileSync(path.join(root,filename)),{type:'buffer',raw:true});
  const rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{defval:''});
  const edges=mapEdges(mesh,rows);assert.equal(edges.length,mesh.faces.length*1.5);
  const unique=new Set(edges.map(e=>[e.a.join(','),e.b.join(',')].sort().join('|')));assert.equal(unique.size,edges.length);
  const vertexMap=new Map();for(const e of edges){for(const [id,point,other] of [[e.va,e.a,e.b],[e.vb,e.b,e.a]]){
    const previous=vertexMap.get(id),candidates=new Set([point.join(','),other.join(',')]);
    if(previous){const intersection=new Set([...previous].filter(x=>candidates.has(x)));assert.ok(intersection.size,'Inconsistent vertex mapping');vertexMap.set(id,intersection);}else vertexMap.set(id,candidates);
  }}
  assert.ok([...vertexMap.values()].every(v=>v.size===1));
  for(const e of edges)assert.ok(Number.isFinite(e.p)&&e.p>=0&&e.p<=1);
  total+=edges.length;console.log(`PASS ${filename}: ${edges.length} edges; unique geometry and original vertex mapping verified`);
}
const obj=parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1');
const row={edge_id:1,vertex_1:1,vertex_2:2,boundary_probability:.75};
assert.equal(mapEdges(obj,[row])[0].p,.75);
assert.throws(()=>mapEdges(obj,[{...row,vertex_2:4}]));
assert.throws(()=>mapEdges(obj,[{...row,boundary_probability:2}]));
assert.throws(()=>mapEdges(obj,[row,row]));
assert.ok(Number.isNaN(mapEdges(obj,[{...row,boundary_probability:'nan'}])[0].p));
assert.throws(()=>parseOBJ('v 0 0 0\nf 1 2 3 4'));
console.log(`PASS total ${total} edges; OBJ negative indices, invalid mapping/probability, duplicates and missing prediction checks`);
