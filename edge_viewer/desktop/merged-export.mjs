import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseOBJ,parsePLY,mapEdges} from '../mesh-data.mjs';
import {incidentFaces,patchColor} from '../patch-edit.mjs';
const require=createRequire(import.meta.url),XLSX=require('../vendor/xlsx.full.min.js');
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');

export async function exportMerged(folder,meshFile,probabilityFile,data){
  const [meshBuffer,probabilityBuffer]=await Promise.all([fs.readFile(meshFile),fs.readFile(probabilityFile)]);
  const mesh=/\.obj$/i.test(meshFile)?parseOBJ(meshBuffer.toString('utf8')):parsePLY(meshBuffer.buffer.slice(meshBuffer.byteOffset,meshBuffer.byteOffset+meshBuffer.byteLength));
  if(data.schema!=='edgescope.segmentation.v1'||data.model_sha256!==hash(meshBuffer)||data.face_count!==mesh.faces.length||!Array.isArray(data.labels)||data.labels.length!==mesh.faces.length||!Number.isInteger(data.patch_count)||data.patch_count<1||data.labels.some(id=>!Number.isInteger(id)||id<1||id>data.patch_count)||new Set(data.labels).size!==data.patch_count)throw Error('合并标签与当前模型不一致。');
  const book=XLSX.read(probabilityBuffer,{type:'buffer',raw:true}),rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{defval:''});
  const mapped=mapEdges(mesh,rows),incident=incidentFaces(mesh,mapped,rows);
  if(incident.some(faces=>!faces.length||faces.some(t=>!Number.isInteger(t)||t<0||t>=mesh.faces.length)))throw Error('无法确定概率边对应的三角形，未保存合并结果。');
  const labels=data.labels,groups=Array.from({length:data.patch_count},()=>[]),areas=new Float64Array(data.patch_count),neighbors=Array.from({length:labels.length},()=>[]),topology=new Map();
  let totalArea=0;
  mesh.faces.forEach((face,t)=>{
    const id=labels[t]-1;groups[id].push(t);
    const [a,b,c]=face.map(i=>mesh.vertices[i]),u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);
    const area=Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;areas[id]+=area;totalArea+=area;
    for(let i=0;i<3;i++){
      const keys=[face[i],face[(i+1)%3]].map(j=>mesh.kind==='ply'?mesh.vertices[j].join(','):String(j)).sort(),key=keys.join('|');
      if(!topology.has(key))topology.set(key,[]);const others=topology.get(key);
      for(const other of others){neighbors[t].push(other);neighbors[other].push(t);}others.push(t);
    }
  });
  const visited=new Uint8Array(labels.length),seen=new Set();let connected=true;
  for(let seed=0;seed<labels.length;seed++)if(!visited[seed]){
    const id=labels[seed];if(seen.has(id))connected=false;seen.add(id);visited[seed]=1;const stack=[seed];
    while(stack.length){const t=stack.pop();for(const next of neighbors[t])if(!visited[next]&&labels[next]===id){visited[next]=1;stack.push(next);}}
  }
  const metadata={...data,model_file:path.basename(meshFile),probability_sha256:hash(probabilityBuffer)};
  const report={patch_count:data.patch_count,manual_edit:true,manual_merge_count:data.manual_merge_count||1,all_faces_assigned:true,all_patches_connected:connected,minimum_patch_faces:groups.reduce((n,g)=>Math.min(n,g.length),Infinity),patches:groups.map((g,i)=>({patch_id:i+1,faces:g.length,area_fraction:totalArea?areas[i]/totalArea:0})),input:{model:meshFile,probabilities:probabilityFile,model_sha256:data.model_sha256,probability_sha256:metadata.probability_sha256}};
  await fs.writeFile(path.join(folder,'segmentation.json'),JSON.stringify(metadata));
  await fs.writeFile(path.join(folder,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(folder,'face_labels.csv'),'triangle_id,patch_id\n'+labels.map((id,i)=>`${i+1},${id}`).join('\n'));
  const obj=['# Manually edited patches; original vertex geometry preserved.',...mesh.vertices.map(v=>'v '+v.join(' '))];
  groups.forEach((triangles,i)=>{obj.push('g patch_'+(i+1));for(const t of triangles)obj.push('f '+mesh.faces[t].map(v=>v+1).join(' '));});
  await fs.writeFile(path.join(folder,'patches.obj'),obj.join('\n'));
  const head=Buffer.from(`ply\nformat binary_little_endian 1.0\ncomment manually edited patches; original face order\nelement vertex ${labels.length*3}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${labels.length}\nproperty list uchar int vertex_indices\nend_header\n`);
  const ply=Buffer.alloc(labels.length*(45+13));let offset=0;
  const colors=groups.map((_,i)=>patchColor(i+1).map(v=>Math.round(255*(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055))));
  mesh.faces.forEach((face,t)=>{for(const vertex of face){for(const coordinate of mesh.vertices[vertex]){ply.writeFloatLE(coordinate,offset);offset+=4;}for(const color of colors[labels[t]-1])ply[offset++]=color;}});
  mesh.faces.forEach((_,t)=>{ply[offset++]=3;for(let j=0;j<3;j++){ply.writeInt32LE(t*3+j,offset);offset+=4;}});
  await fs.writeFile(path.join(folder,'patches.ply'),Buffer.concat([head,ply]));
  const boundary=['edge_id,vertex_1,vertex_2,triangle_1,triangle_2,boundary_probability,patch_1,patch_2,is_cut'];
  mapped.forEach((edge,i)=>{const [a,b]=incident[i],cut=b===undefined||labels[a]!==labels[b];boundary.push([edge.id,edge.va,edge.vb,a+1,b===undefined?0:b+1,Number.isFinite(edge.p)?edge.p:'nan',labels[a],b===undefined?0:labels[b],Number(cut)].join(','));});
  await fs.writeFile(path.join(folder,'boundary_edges.csv'),boundary.join('\n'));
  return {segmentation:metadata,report,directory:folder};
}
