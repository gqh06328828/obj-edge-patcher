import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {parseOBJ,parsePLY,mapEdges} from './mesh-data.mjs';
import {matchProbability,modelStem} from './model-pairs.mjs';
let readoutAvailable=false;
import './step-panel.mjs';
import {registerView,updateView,isDark} from './view-settings.mjs';
import {mergePatchLabels,incidentFaces,patchColor} from './patch-edit.mjs';
let segmentationData=null,selectingPatches=false;const selectedPatches=new Set();
const $=id=>document.getElementById(id),fmt=n=>n.toLocaleString('en-US');
const desktop=window.edgeDesktop;let desktopMesh=null,desktopProbability=null,busy=false,activePair=null,currentMeshSHA='',patchLabels=null;
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0xf3f5f8);$('stage').appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,.01,100);const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.autoRotateSpeed=.65;
scene.add(new THREE.HemisphereLight(0xffffff,0x8b96ac,2.2));const light=new THREE.DirectionalLight(0xffffff,2.5);light.position.set(3,5,4);scene.add(light);
let meshObject,lineObject,edges=[],normalized=[],shown=[],selected=null,loadVersion=0;
const highlight=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xff9c1b,depthTest:false}));highlight.renderOrder=5;scene.add(highlight);
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function reset(){camera.position.set(2.6,1.9,3.1).setLength(1.9/Math.sin(Math.atan(Math.tan(camera.fov*Math.PI/360)*Math.min(1,Math.max(.3,camera.aspect)))));controls.target.set(0,0,0);controls.update();}reset();
new ResizeObserver(()=>{const r=$('stage').getBoundingClientRect();if(!r.width||!r.height)return;renderer.setSize(r.width,r.height);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();}).observe($('stage'));
registerView('probability',{camera,controls,renderer,autoInput:$('auto'),onTheme:()=>updateAppearance()});
renderer.setAnimationLoop(()=>{updateView('probability');renderer.render(scene,camera);});
function dispose(object){if(object){scene.remove(object);object.geometry.dispose();object.material.dispose();}}
function updateAppearance(){

  const color=new THREE.Color($('color').value),pale=new THREE.Color(isDark()?'#29384e':'#f0f3fa'),gamma=Number($('contrast').value),threshold=Number($('threshold').value);
  $('contrastValue').value=gamma.toFixed(2);$('thresholdValue').value=threshold.toFixed(2);
  const stops=Array.from({length:11},(_,i)=>'#'+pale.clone().lerp(color,(i/10)**gamma).getHexString());$('gradient').style.background=`linear-gradient(90deg,${stops.join(',')})`;
  if(!lineObject)return;
  const patchMode=patchLabels&&$('displayMode').value==='patches';
  $('probabilityViewLabel').textContent=patchMode?'右视图 / 几何分片':'右视图 / 边概率';
  for(const id of ['color','contrast','threshold'])$(id).disabled=!!patchMode;
  document.querySelectorAll('[data-color]').forEach(b=>b.disabled=!!patchMode);
  $('modeHint').textContent=patchMode?'不同面色代表不同分片，深色线为实际分片边界；此视图不按概率筛选。':'';
  meshObject.material.vertexColors=!!patchMode;meshObject.material.color.set(patchMode?0xffffff:(isDark()?0x7f8da3:0xe5e9ef));meshObject.material.needsUpdate=true;
  const positions=[],colors=[];shown=[];
  edges.forEach((e,i)=>{if(patchMode){if(e.triangles.length===2&&patchLabels[e.triangles[0]]===patchLabels[e.triangles[1]])return;}else if(Number.isFinite(e.p)&&e.p<threshold)return;shown.push(i);positions.push(...normalized[i]);const c=patchMode?new THREE.Color(isDark()?'#c6d4eb':'#26344c'):Number.isFinite(e.p)?pale.clone().lerp(color,e.p**gamma):new THREE.Color('#999999');colors.push(c.r,c.g,c.b,c.r,c.g,c.b);});
  lineObject.geometry.dispose();lineObject.geometry=new THREE.BufferGeometry();lineObject.geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));lineObject.geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));lineObject.geometry.computeBoundingSphere();
  lineObject.material.depthTest=true;meshObject.visible=$('surface').checked;controls.autoRotate=$('auto').checked;$('visibleCount').textContent=fmt(shown.length);
  if(selected!==null&&!shown.includes(selected)){selected=null;highlight.geometry.dispose();highlight.geometry=new THREE.BufferGeometry();$('edgeInfo').textContent='所选边已被筛选隐藏。';}
  if(patchLabels)paintPatches();updateMergeControls();drawHistogram(color);
}
function drawHistogram(color){const c=$('histogram'),ctx=c.getContext('2d');c.width=c.clientWidth*2;c.height=128;ctx.clearRect(0,0,c.width,c.height);const bins=Array(32).fill(0);for(const e of edges)if(Number.isFinite(e.p))bins[Math.min(31,Math.floor(e.p*32))]++;const max=Math.max(...bins,1);bins.forEach((n,i)=>{ctx.fillStyle='#'+new THREE.Color('#dbe3fa').lerp(color,i/31).getHexString();const h=n/max*118;ctx.fillRect(i*c.width/32,128-h,c.width/32-3,h);});}
function install(mesh,rows,name){
  const mapped=mapEdges(mesh,rows);
  const incident=incidentFaces(mesh,mapped,rows);mapped.forEach((e,i)=>{e.triangles=incident[i];});
  const box=new THREE.Box3();for(const v of mesh.vertices)box.expandByPoint(new THREE.Vector3(...v));const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),scale=2/Math.max(size.x,size.y,size.z);if(!Number.isFinite(scale))throw Error('模型尺寸无效。');
  const norm=v=>[(v[0]-center.x)*scale,(v[1]-center.y)*scale,(v[2]-center.z)*scale];
  const pos=new Float32Array(mesh.faces.length*9);let offset=0;for(const face of mesh.faces)for(const i of face){pos.set(norm(mesh.vertices[i]),offset);offset+=3;}
  activePair=null;dispose(meshObject);dispose(lineObject);edges=mapped;normalized=edges.map(e=>[...norm(e.a),...norm(e.b)]);
  patchLabels=null;segmentationData=null;selectedPatches.clear();selectingPatches=false;$('displayMode').value='probability';$('displayModeLabel').hidden=true;$('readoutInfo').textContent='对当前显示的模型运行分片，或加载对应的 segmentation.json。';
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(pos,3));geo.computeVertexNormals();
  meshObject=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0xe5e9ef,roughness:.85,metalness:0,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));scene.add(meshObject);
  lineObject=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({vertexColors:true}));lineObject.renderOrder=1;scene.add(lineObject);
  selected=null;highlight.geometry.dispose();highlight.geometry=new THREE.BufferGeometry();$('edgeInfo').textContent='点击模型上的边，查看原始概率和顶点编号。';$('modelName').textContent=name;$('modelName').title=name;$('faceCount').textContent=fmt(mesh.faces.length);$('edgeCount').textContent=fmt(edges.length);
  const valid=edges.filter(e=>Number.isFinite(e.p)).length;$('validCount').textContent=fmt(valid)+' 条有效预测';updateAppearance();reset();status(`已加载 · ${fmt(edges.length)} 条边匹配成功${valid<edges.length?' · '+fmt(edges.length-valid)+' 条无预测（灰色）':''}`);
}
function parseTable(buffer,name){const book=XLSX.read(buffer,{type:'array',raw:true});const sheet=book.Sheets[book.SheetNames[0]];return XLSX.utils.sheet_to_json(sheet,{defval:''});}
async function load(meshBuffer,probBuffer,meshName,probName,token){status('正在解析网格并核对每条边…');await new Promise(r=>setTimeout(r,30));if(token!==loadVersion)return;const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',meshBuffer))).map(b=>b.toString(16).padStart(2,'0')).join('');const mesh=meshName.toLowerCase().endsWith('.obj')?parseOBJ(new TextDecoder().decode(meshBuffer)):parsePLY(meshBuffer);install(mesh,parseTable(probBuffer,probName),meshName.split('/').pop().replace(/__epoch09__segmented\.ply$|\.obj$/i,''));currentMeshSHA=hash;await clearAfterModelChange();}
function setBusy(value){
  busy=value;for(const id of ['chooseModel','chooseBrowserDirectory','downloadReadout','deleteReadout','chooseDirectory','runReadout','chooseSegmentation','selectPatches','mergePatches'])$(id).disabled=value;
  if(!value){$('downloadReadout').disabled=!readoutAvailable;$('runReadout').disabled=!activePair;$('chooseSegmentation').disabled=!meshObject;}updateMergeControls();
}
async function runLoad(fn){if(busy)return;const token=++loadVersion;setBusy(true);status('正在读取模型与概率文件…');try{await fn(token);}catch(e){console.error(e);status(e.message,true);}finally{if(token===loadVersion)setBusy(false);}}
async function readLocal(url){const r=await fetch(url);if(!r.ok)throw Error('文件读取失败，请重新选择文件。');return r.arrayBuffer();}
async function loadPair(m,token){
  const buffers=await Promise.all([m.meshFile?m.meshFile.arrayBuffer():readLocal(m.mesh),m.probabilityFile?m.probabilityFile.arrayBuffer():readLocal(m.probability)]);
  await load(...buffers,m.meshName||m.mesh,m.probabilityName||m.probability,token);
  if(desktop){desktopMesh={name:m.meshName,url:m.mesh};desktopProbability={name:m.probabilityName,url:m.probability};activePair={mesh:m.mesh,probability:m.probability};refreshFiles();}
}
$('chooseBrowserDirectory').onclick=()=>{if(!busy)$('modelDirectory').click();};
$('modelDirectory').onchange=()=>{
  const files=Array.from($('modelDirectory').files),groups=new Map(),pairs=[],warnings=[];$('modelDirectory').value='';
  for(const file of files){const parent=file.webkitRelativePath.split('/').slice(0,-1).join('/');if(!groups.has(parent))groups.set(parent,[]);groups.get(parent).push(file);}
  for(const [folder,entries] of groups){
    if(folder.split('/').some(p=>p.startsWith('.')))continue;
    const used=new Set();
    for(const mesh of entries.filter(f=>/\.(obj|ply)$/i.test(f.name)).sort((a,b)=>Number(/\.ply$/i.test(a.name))-Number(/\.ply$/i.test(b.name)))){
      const base=modelStem(mesh.name);if(used.has(base))continue;
      try{const probability=matchProbability(mesh.name,entries.map(f=>f.name));pairs.push({name:folder+' / '+base,meshName:mesh.name,probabilityName:probability,meshFile:mesh,probabilityFile:entries.find(f=>f.name===probability)});used.add(base);}catch(e){warnings.push(e.message);}
    }
  }
  if(pairs.length===1)runLoad(token=>loadPair(pairs[0],token));else status(pairs.length>1?'文件夹包含多个模型，请选择当前模型所在的单独文件夹。':warnings[0]||'文件夹中没有可配对的模型和概率表。',true);
};
async function clearAfterModelChange(){
  readoutAvailable=false;$('downloadReadout').disabled=true;
  if(desktop)try{await desktop.clearReadout();}catch(e){status('模型已加载，但旧临时结果清理失败，可点击“删除临时结果”重试：'+e.message,true);}
}
for(const id of ['color','contrast','threshold','surface','auto','displayMode'])$(id).addEventListener('input',updateAppearance);
document.querySelectorAll('[data-color]').forEach(b=>b.onclick=()=>{$('color').value=b.dataset.color;updateAppearance();});$('reset').onclick=reset;
$('capture').onclick=async()=>{if(!meshObject){status('请先加载模型。',true);return;}renderer.render(scene,camera);const url=renderer.domElement.toDataURL('image/png'),name=$('modelName').textContent||'model';if(desktop){try{const saved=await desktop.saveImage(url,name);if(saved)status('图片已保存：'+saved);}catch(e){status(e.message,true);}return;}const a=document.createElement('a');a.download=name+'__probability.png';a.href=url;a.click();};
let down;renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});
renderer.domElement.addEventListener('click',e=>{
  if(e.button!==0||!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>4||!lineObject)return;
  const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.params.Line.threshold=controls.target.distanceTo(camera.position)*.0025;ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);
  if(selectingPatches&&patchLabels&&$('displayMode').value==='patches'){
    if(busy)return;const faceHit=ray.intersectObject(meshObject)[0];if(!faceHit)return;
    const id=patchLabels[faceHit.faceIndex];if(selectedPatches.has(id))selectedPatches.delete(id);else selectedPatches.add(id);
    paintPatches();updateMergeControls();return;
  }
  const hits=ray.intersectObject(lineObject);const surfaceHit=meshObject.visible?ray.intersectObject(meshObject)[0]:null;
  const hit=hits.find(h=>!surfaceHit||h.distance<=surfaceHit.distance+ray.params.Line.threshold*2);if(!hit){$('edgeInfo').textContent='此处未选中可见边，请靠近边线点击，或放大模型后选择。';return;}
  selected=shown[Math.floor(hit.index/2)];const edge=edges[selected];highlight.geometry.dispose();highlight.geometry=new THREE.BufferGeometry();highlight.geometry.setAttribute('position',new THREE.Float32BufferAttribute(normalized[selected],3));
  $('edgeInfo').innerHTML=`边 #${edge.id}<strong>${Number.isFinite(edge.p)?(edge.p*100).toFixed(4)+'%':'无预测'}</strong>原始概率：${Number.isFinite(edge.p)?edge.p:'nan'}<br>原 OBJ 顶点：${edge.va} ↔ ${edge.vb}`;
});
function refreshFiles(){for(const [id,file,empty] of [['desktopMeshName',desktopMesh,'未选择模型'],['desktopProbabilityName',desktopProbability,'未选择概率表']]){$(id).textContent=file?.name||empty;$(id).title=file?.name||empty;}}
function updateMergeControls(){
  const available=!!patchLabels;
  $('selectPatches').disabled=busy||!available;
  $('selectPatches').setAttribute('aria-pressed',String(selectingPatches));
  $('selectPatches').textContent=selectingPatches?'结束选择':'选择几何分片';
  $('mergePatches').disabled=busy||selectedPatches.size<2||!available;
  $('mergeInfo').textContent=selectedPatches.size?`已选 ${selectedPatches.size} 个分片：${[...selectedPatches].join('、')}。再次点击可取消。`:available?'点击“选择几何分片”，再点击右侧彩色面片进行多选。':'加载分片后，可选择两个或更多分片进行合并。';
}
function paintPatches(){
  if(!patchLabels||!meshObject)return;
  const colors=meshObject.geometry.getAttribute('color');if(!colors)return;
  const palette=new Map();
  patchLabels.forEach((id,i)=>{
    if(!palette.has(id))palette.set(id,selectingPatches&&selectedPatches.has(id)?[1,.32,.025]:patchColor(id));
    for(let j=0;j<3;j++)colors.array.set(palette.get(id),i*9+j*3);
  });colors.needsUpdate=true;
}
$('selectPatches').onclick=()=>{
  if(busy||!patchLabels)return;selectingPatches=!selectingPatches;
  if(selectingPatches){$('displayMode').value='patches';$('surface').checked=true;highlight.geometry.dispose();highlight.geometry=new THREE.BufferGeometry();}
  updateAppearance();updateMergeControls();
};
$('mergePatches').onclick=async()=>{
  if(busy||!segmentationData||selectedPatches.size<2)return;
  try{
    const merged=mergePatchLabels(segmentationData,[...selectedPatches]);setBusy(true);
    if(desktop){
      if(!activePair)throw Error('请先加载此分片对应的模型与概率。');
      const result=await desktop.saveMerged({...activePair,segmentation:merged});
      applySegmentation(result.segmentation);readoutAvailable=true;
    }else applySegmentation(merged);
    $('readoutInfo').textContent=`手动合并完成，当前 ${merged.patch_count} 个分片。下载结果包含本次合并。`;
    status(`合并完成 · ${merged.patch_count} 个分片`);
  }catch(error){status(error.message,true);}finally{setBusy(false);}
};
function applySegmentation(data){
  if(!meshObject||data.schema!=='edgescope.segmentation.v1'||data.model_sha256!==currentMeshSHA)throw Error('分片标签与当前模型文件不一致，请加载读出时使用的原始模型。');
  const n=meshObject.geometry.attributes.position.count/3;
  if(!Number.isInteger(data.patch_count)||data.patch_count<1||data.patch_count>n||data.face_count!==n||!Array.isArray(data.labels)||data.labels.length!==n||data.labels.some(i=>!Number.isInteger(i)||i<1||i>data.patch_count))throw Error('分片标签数量或编号无效。');
  segmentationData=structuredClone(data);selectedPatches.clear();selectingPatches=false;patchLabels=data.labels;const palette=Array.from({length:data.patch_count},(_,i)=>new THREE.Color().fromArray(patchColor(i+1)));const colors=new Float32Array(n*9);
  data.labels.forEach((label,i)=>{const c=palette[label-1];for(let j=0;j<3;j++)colors.set([c.r,c.g,c.b],i*9+j*3);});
  meshObject.geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));$('displayModeLabel').hidden=false;$('displayMode').value='patches';$('readoutInfo').textContent=`已载入 ${data.patch_count} 个分片。可切换“网络边概率 / 几何分片结果”对照。`;updateAppearance();updateMergeControls();$('probabilityViewLabel').textContent='右视图 / 几何分片';status(`分片结果 · ${data.patch_count} 个片 · ${fmt(n)} 个三角形`);
}
if(desktop){
  document.body.classList.add('desktop');$('desktopFiles').hidden=false;$('browserFiles').hidden=true;document.querySelector('.local').textContent='离线桌面版 · 1.0.0';
  $('chooseModel').onclick=()=>runLoad(async token=>{
    const result=await desktop.chooseModel();if(!result){status('已取消选择模型。');return;}
    await loadPair({mesh:result.mesh.url,probability:result.probability.url,meshName:result.mesh.name,probabilityName:result.probability.name},token);
  });
  $('runReadout').onclick=async()=>{if(busy)return;if(!activePair){status('请先加载要分片的模型和概率表。',true);return;}setBusy(true);$('runReadout').disabled=true;$('chooseSegmentation').disabled=true;$('cancelReadout').hidden=false;status('正在模型目录下生成临时读出结果…');try{const result=await desktop.runReadout({...activePair,minFaces:Number($('minFaces').value),minArea:Number($('minArea').value)/100,normalSigma:Number($('normalSigma').value)});if(result){readoutAvailable=true;applySegmentation(result.segmentation);$('readoutInfo').textContent=`${result.report.patch_count} 个连通片；最小 ${result.report.minimum_patch_faces} 个三角形；强制合并 ${result.report.forced_merges} 次。临时结果：${result.directory}；需要保留请点击“下载结果”。`;}else status('读出未生成结果。');}catch(e){status(e.message,true);}finally{setBusy(false);$('runReadout').disabled=!activePair;$('chooseSegmentation').disabled=!meshObject;$('cancelReadout').hidden=true;}};
  $('downloadReadout').onclick=async()=>{
    if(busy||!readoutAvailable)return;setBusy(true);
    try{const result=await desktop.downloadReadout();status(result?'结果已下载并永久保存：'+result.directory:'已取消下载，临时结果仍可查看。');}catch(e){status(e.message,true);}finally{setBusy(false);}
  };
  $('deleteReadout').onclick=async()=>{
    if(busy)return;setBusy(true);
    try{await desktop.clearReadout();readoutAvailable=false;patchLabels=null;segmentationData=null;selectingPatches=false;selectedPatches.clear();$('displayMode').value='probability';$('displayModeLabel').hidden=true;updateAppearance();$('readoutInfo').textContent='临时结果已删除，可重新运行读出。';status('临时结果已删除，已下载的副本仍保留。');}catch(e){status(e.message,true);}finally{setBusy(false);}
  };
  $('cancelReadout').onclick=()=>desktop.cancelReadout();
  $('chooseSegmentation').onclick=async()=>{if(busy)return;try{const data=await desktop.chooseSegmentation();if(data){applySegmentation(data);await clearAfterModelChange();}}catch(e){status(e.message,true);}};
  desktop.onReadoutProgress(text=>{if(text){const last=text.trim().split('\n').pop();let message='正在计算与保存分片结果…';if(last.startsWith('Reading mesh'))message='正在校验模型与边概率对应关系…';else if(last.startsWith('Connected micro-regions:'))message='已生成初始区域，正在进行几何合并…';else if(last.startsWith('Energy-based merge:'))message='几何合并完成，正在检查区域尺度…';else if(last.startsWith('Minimum-support'))message='最小片尺度检查完成，正在调整边界…';else if(last.startsWith('Validated'))message='连通性检查完成，正在保存结果…';status(message);}});
  $('chooseDirectory').onclick=()=>runLoad(async token=>{
    const result=await desktop.chooseDirectory();if(!result){status('已取消选择文件夹。');return;}
    $('directoryInfo').textContent=result.directory;$('directoryInfo').title=result.directory;
    if(result.models.length===1)await loadPair(result.models[0],token);else status(result.models.length>1?'文件夹包含多个模型，请直接点击“打开模型与概率”选择需要的模型。':'未找到可唯一配对的模型与概率表。',true);
  });
  desktop.onCommand(name=>{const button=$(name);if(button&&!button.disabled)button.click();});
}

status('打开模型即可自动加载同目录概率。');setBusy(false);
