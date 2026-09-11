export function mergePatchLabels(segmentation,selected){
  const chosen=new Set(selected),present=new Set(segmentation.labels);
  if(chosen.size<2)throw Error('请至少选择两个几何分片。');
  if([...chosen].some(id=>!present.has(id)))throw Error('所选分片已变化，请重新选择。');
  const target=Math.min(...chosen),mapping=new Map();
  const labels=segmentation.labels.map(id=>{
    const merged=chosen.has(id)?target:id;
    if(!mapping.has(merged))mapping.set(merged,mapping.size+1);
    return mapping.get(merged);
  });
  return {...segmentation,labels,patch_count:mapping.size,manual_merge_count:(segmentation.manual_merge_count||0)+1};
}

export function incidentFaces(mesh,edges,rows){
  if(mesh.kind==='ply')return rows.map(row=>String(row.incident_triangle_ids||'').split(';').filter(Boolean).map(x=>Number(x)-1));
  const map=new Map();
  mesh.faces.forEach((face,t)=>{for(let i=0;i<3;i++){
    const a=face[i],b=face[(i+1)%3],key=a<b?a+','+b:b+','+a;
    if(!map.has(key))map.set(key,[]);map.get(key).push(t);
  }});
  return edges.map(edge=>map.get([edge.va-1,edge.vb-1].sort((a,b)=>a-b).join(','))||[]);
}

export function patchColor(id){
  const h=((id-1)*.61803398875)%1,s=.58,l=.66;
  const a=s*Math.min(l,1-l);
  return [0,8,4].map(n=>{const k=(n+h*12)%12;return l-a*Math.max(-1,Math.min(k-3,9-k,1));});
}
