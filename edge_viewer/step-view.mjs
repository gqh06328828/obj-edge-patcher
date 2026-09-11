import * as THREE from './vendor/three.module.js';

export function parseSTEP(buffer){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./step-worker.js',import.meta.url));
    const finish=(error,result)=>{clearTimeout(timer);worker.terminate();error?reject(Error(error)):resolve(result);};
    const timer=setTimeout(()=>finish('STEP 解析超过 3 分钟，请尝试较小的模型。'),180000);
    worker.onmessage=({data})=>finish(data.error,data.result);
    worker.onerror=()=>finish('STEP 解析器启动失败，请检查本地解析库是否完整。');
    worker.onmessageerror=()=>finish('STEP 解析结果传输失败。');
    worker.postMessage(buffer,[buffer]);
  });
}

export function createSTEPGeometry(result){
  if(!result.success||!result.meshes?.length)throw Error('STEP 中没有可显示的模型。');
  const box=new THREE.Box3(),point=new THREE.Vector3();let count=0;
  for(const mesh of result.meshes){
    const p=mesh.attributes?.position?.array,indices=mesh.index?.array;
    if(!p?.length||p.length%3||!indices?.length||indices.length%3||p.some(v=>!Number.isFinite(v))||indices.some(i=>!Number.isInteger(i)||i<0||i>=p.length/3))throw Error('STEP 网格数据无效。');
    for(let i=0;i<p.length;i+=3)box.expandByPoint(point.fromArray(p,i));
    count+=indices.length;
  }
  const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),scale=2/Math.max(size.x,size.y,size.z);
  if(!Number.isFinite(scale))throw Error('STEP 模型尺寸无效。');
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3),colors=new Float32Array(count*3);
  const linePositions=[],brepRanges=[];let offset=0,completeBREP=true;
  for(const mesh of result.meshes){
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(mesh.attributes.position.array,3));
    geometry.setIndex(mesh.index.array);
    if(mesh.attributes.normal?.array?.length===mesh.attributes.position.array.length)geometry.setAttribute('normal',new THREE.Float32BufferAttribute(mesh.attributes.normal.array,3));
    else geometry.computeVertexNormals();
    geometry.translate(-center.x,-center.y,-center.z);geometry.scale(scale,scale,scale);
    const outline=new THREE.EdgesGeometry(geometry,25);
    for(const v of outline.attributes.position.array)linePositions.push(v);
    outline.dispose();
    const flat=geometry.toNonIndexed(),base=new THREE.Color('#cad6e4');
    if(mesh.color)base.setRGB(...mesh.color,THREE.SRGBColorSpace);
    const faceColors=new Float32Array(flat.attributes.position.count*3);
    const triangleCount=flat.attributes.position.count/3,covered=new Uint8Array(triangleCount);
    for(const face of mesh.brep_faces||[]){
      // These ranges come from the CAD importer, not inferred triangle normals.
      if(!Number.isInteger(face.first)||!Number.isInteger(face.last)||face.first<0||face.last<face.first||face.last>=triangleCount){completeBREP=false;continue;}
      for(let t=face.first;t<=face.last;t++){if(covered[t])completeBREP=false;covered[t]=1;}
      brepRanges.push({first:offset+face.first*9,end:offset+(face.last+1)*9});
    }
    if(covered.some(value=>!value))completeBREP=false;
    for(let i=0;i<faceColors.length;i+=3)base.toArray(faceColors,i);
    for(const face of mesh.brep_faces||[]){
      if(!face.color)continue;
      const color=new THREE.Color().setRGB(...face.color,THREE.SRGBColorSpace);
      for(let t=Math.max(0,face.first);t<=face.last&&t<flat.attributes.position.count/3;t++)for(let v=0;v<3;v++)color.toArray(faceColors,t*9+v*3);
    }
    positions.set(flat.attributes.position.array,offset);normals.set(flat.attributes.normal.array,offset);colors.set(faceColors,offset);
    offset+=flat.attributes.position.array.length;flat.dispose();geometry.dispose();
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));
  geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  if(completeBREP&&brepRanges.length){
    const brepColors=new Float32Array(colors.length);
    // Give every BREP face its own hue, including faces in separate mesh parts.
    // This keeps neighboring faces different even when tessellations do not share vertices.
    brepRanges.forEach(({first,end},id)=>{
      const color=new THREE.Color().setHSL((.07+id*.618033988749895)%1,.65,.58);
      for(let i=first;i<end;i+=3)color.toArray(brepColors,i);
    });
    geometry.userData.brepColors=new THREE.BufferAttribute(brepColors,3);
    geometry.userData.originalColors=geometry.getAttribute('color');
    geometry.userData.brepFaceCount=brepRanges.length;
  }
  const outline=new THREE.BufferGeometry();outline.setAttribute('position',new THREE.Float32BufferAttribute(linePositions,3));
  return {geometry,outline,partCount:result.meshes.length};
}
