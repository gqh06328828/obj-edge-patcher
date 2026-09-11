export function parseOBJ(text) {
  const vertices=[],faces=[];
  for(const raw of text.split(/\r?\n/)){
    const p=raw.trim().split(/\s+/);
    if(p[0]==='v') vertices.push(p.slice(1,4).map(Number));
    if(p[0]==='f'){
      if(p.length!==4)throw Error('OBJ 必须是三角网格；自动三角化会改变概率对应的三角形编号。');
      faces.push(p.slice(1).map(x=>{const i=Number(x.split('/')[0]);return i<0?vertices.length+i:i-1;}));
    }
  }
  if(!vertices.length||!faces.length)throw Error('OBJ 中没有有效三角网格。');
  for(const v of vertices)if(v.length!==3||!v.every(Number.isFinite))throw Error('OBJ 顶点坐标无效。');
  for(const f of faces)for(const i of f)if(!Number.isInteger(i)||i<0||i>=vertices.length)throw Error('OBJ 顶点索引越界。');
  return {vertices,faces,kind:'obj'};
}
export function parsePLY(buffer){
  const bytes=new Uint8Array(buffer), marker=new TextEncoder().encode('end_header');
  let end=-1;
  outer:for(let i=0;i<Math.min(bytes.length,65536)-marker.length;i++){
    for(let j=0;j<marker.length;j++)if(bytes[i+j]!==marker[j])continue outer;
    end=i+marker.length;break;
  }
  if(end<0)throw Error('PLY 缺少头部。');
  if(bytes[end]===13)end++;
  if(bytes[end]===10)end++;
  const header=new TextDecoder().decode(bytes.slice(0,end));
  if(!header.includes('format binary_little_endian'))throw Error('当前 PLY 导入支持本目录的 binary_little_endian 格式。');
  const n=Number(header.match(/element vertex (\d+)/)?.[1]),nf=Number(header.match(/element face (\d+)/)?.[1]);
  const vertexSection=header.split('element vertex ')[1]?.split('element face')[0];
  const props=[...vertexSection.matchAll(/property (\w+) (\w+)/g)].map(m=>[m[1],m[2]]);
  const sizes={float:4,float32:4,double:8,float64:8,uchar:1,uint8:1,int:4,int32:4};
  if(!n||!nf||props.some(p=>!sizes[p[0]]))throw Error('不支持的 PLY 顶点格式。');
  if(!/property list (uchar|uint8) (int|int32) vertex_indices/.test(header))throw Error('不支持的 PLY 面索引格式。');
  const view=new DataView(buffer),vertices=[],faces=[];let o=end;
  for(let i=0;i<n;i++){
    const xyz={};
    for(const [type,name] of props){xyz[name]=type.startsWith('float')||type==='double'? (sizes[type]===8?view.getFloat64(o,true):view.getFloat32(o,true)):sizes[type]===1?view.getUint8(o):view.getInt32(o,true);o+=sizes[type];}
    if(![xyz.x,xyz.y,xyz.z].every(Number.isFinite))throw Error('PLY 坐标无效。');
    vertices.push([xyz.x,xyz.y,xyz.z]);
  }
  for(let i=0;i<nf;i++){
    if(view.getUint8(o++)!==3)throw Error('PLY 必须是三角网格。');
    const f=[];for(let j=0;j<3;j++){const v=view.getInt32(o,true);o+=4;if(v<0||v>=n)throw Error('PLY 面索引越界。');f.push(v);}faces.push(f);
  }
  return {vertices,faces,kind:'ply'};
}
export function mapEdges(mesh,rows){
  const required=['edge_id','vertex_1','vertex_2','boundary_probability'];
  if(!rows.length||required.some(k=>!(k in rows[0])))throw Error('概率表需包含 edge_id、vertex_1、vertex_2、boundary_probability 列。');
  const {vertices,faces}=mesh,edges=[],seen=new Set();
  const key=v=>v.join(',');
  const keys=mesh.kind==='ply'?vertices.map(key):null;
  const topology=mesh.kind==='obj'?new Set(faces.flatMap(f=>[[f[0],f[1]],[f[1],f[2]],[f[2],f[0]]].map(e=>e.sort((a,b)=>a-b).join(',')))):null;
  for(const row of rows){
    const id=Number(row.edge_id),va=Number(row.vertex_1),vb=Number(row.vertex_2);
    if(!Number.isInteger(id)||id<1||seen.has(id))throw Error('边编号缺失或重复：'+row.edge_id);seen.add(id);
    if(!Number.isInteger(va)||!Number.isInteger(vb)||va<1||vb<1||va===vb)throw Error('边端点编号无效：'+id);
    let a,b;
    if(mesh.kind==='obj'){
      a=vertices[va-1];b=vertices[vb-1];
      if(!a||!b||!topology.has([va-1,vb-1].sort((a,b)=>a-b).join(',')))throw Error('边 '+id+' 不属于此 OBJ，检查是否使用原始输入模型。');
    }else{
      const ids=String(row.incident_triangle_ids??'').split(';').map(Number);
      if(ids.length!==2||ids.some(i=>!Number.isInteger(i)||!faces[i-1]))throw Error('PLY 边 '+id+' 需要两个有效的相邻三角形编号；此类数据请使用原始 OBJ。');
      const f=faces[ids[0]-1],g=faces[ids[1]-1];
      const shared=[...new Set(f.filter(i=>g.some(j=>keys[i]===keys[j])).map(i=>keys[i]))];
      if(shared.length!==2)throw Error('边 '+id+' 的相邻 PLY 三角形没有唯一公共边，已停止以避免错配。');
      [a,b]=shared.map(k=>vertices[f.find(i=>keys[i]===k)]);
    }
    const raw=String(row.boundary_probability??'').trim();
    const p=raw===''||raw.toLowerCase()==='nan'?NaN:Number(raw);
    if((!Number.isFinite(p)&&raw!==''&&raw.toLowerCase()!=='nan')||(Number.isFinite(p)&&(p<0||p>1)))throw Error('边 '+id+' 的概率不在 0–1 范围。');
    edges.push({id,va,vb,p,a,b});
  }
  return edges;
}
