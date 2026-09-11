import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {parseOBJ,parsePLY,mapEdges} from './mesh-data.mjs';
const $=id=>document.getElementById(id),fmt=n=>n.toLocaleString('en-US');
const desktop=window.edgeDesktop;let desktopMesh=null,desktopProbability=null,busy=false,activePair=null,currentMeshSHA='',patchLabels=null;
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0xf3f5f8);$('stage').appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,.01,100);const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.autoRotateSpeed=.65;
scene.add(new THREE.HemisphereLight(0xffffff,0x8b96ac,2.2));const light=new THREE.DirectionalLight(0xffffff,2.5);light.position.set(3,5,4);scene.add(light);
let meshObject,lineObject,edges=[],normalized=[],shown=[],selected=null,modelList=[],loadVersion=0;
const highlight=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xff9c1b,depthTest:false}));highlight.renderOrder=5;scene.add(highlight);
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function reset(){camera.position.set(2.6,1.9,3.1);controls.target.set(0,0,0);controls.update();}reset();
new ResizeObserver(()=>{const r=$('stage').getBoundingClientRect();renderer.setSize(r.width,r.height);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();}).observe($('stage'));
renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
function dispose(object){if(object){scene.remove(object);object.geometry.dispose();object.material.dispose();}}
function updateAppearance(){
  const color=new THREE.Color($('color').value),pale=new THREE.Color('#f0f3fa'),gamma=Number($('contrast').value),threshold=Number($('threshold').value);
  $('contrastValue').value=gamma.toFixed(2);$('thresholdValue').value=threshold.toFixed(2);
  const stops=Array.from({length:11},(_,i)=>'#'+pale.clone().lerp(color,(i/10)**gamma).getHexString());$('gradient').style.background=`linear-gradient(90deg,${stops.join(',')})`;
  if(!lineObject)return;
  const patchMode=patchLabels&&$('displayMode').value==='patches';
  for(const id of ['color','contrast','threshold'])$(id).disabled=!!patchMode;
  document.querySelectorAll('[data-color]').forEach(b=>b.disabled=!!patchMode);
  $('modeHint').textContent=patchMode?'不同面色代表不同分片，深色线为实际分片边界；此视图不按概率筛选。':'';
  meshObject.material.vertexColors=!!patchMode;meshObject.material.color.set(patchMode?0xffffff:0xe5e9ef);meshObject.material.needsUpdate=true;
  const positions=[],colors=[];shown=[];
  edges.forEach((e,i)=>{if(patchMode){if(e.triangles.length===2&&patchLabels[e.triangles[0]]===patchLabels[e.triangles[1]])return;}else if(Number.isFinite(e.p)&&e.p<threshold)return;shown.push(i);positions.push(...normalized[i]);const c=patchMode?new THREE.Color('#26344c'):Number.isFinite(e.p)?pale.clone().lerp(color,e.p**gamma):new THREE.Color('#999999');colors.push(c.r,c.g,c.b,c.r,c.g,c.b);});
  lineObject.geometry.dispose();lineObject.geometry=new THREE.BufferGeometry();lineObject.geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));lineObject.geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));lineObject.geometry.computeBoundingSphere();
  lineObject.material.depthTest=!$('xray').checked;meshObject.visible=$('surface').checked;controls.autoRotate=$('auto').checked;$('visibleCount').textContent=fmt(shown.length);
  if(selected!==null&&!shown.includes(selected)){selected=null;highlight.geometry.dispose();highlight.geometry=new THREE.BufferGeometry();$('edgeInfo').textContent='所选边已被筛选隐藏。';}
  drawHistogram(color);
}
function drawHistogram(color){const c=$('histogram'),ctx=c.getContext('2d');c.width=c.clientWidth*2;c.height=128;ctx.clearRect(0,0,c.width,c.height);const bins=Array(32).fill(0);for(const e of edges)if(Number.isFinite(e.p))bins[Math.min(31,Math.floor(e.p*32))]++;const max=Math.max(...bins,1);bins.forEach((n,i)=>{ctx.fillStyle='#'+new THREE.Color('#dbe3fa').lerp(color,i/31).getHexString();const h=n/max*118;ctx.fillRect(i*c.width/32,128-h,c.width/32-3,h);});}
function install(mesh,rows,name){
  const mapped=mapEdges(mesh,rows);
  mapped.forEach((e,i)=>{e.triangles=String(rows[i].incident_triangle_ids||'').split(';').filter(Boolean).map(x=>Number(x)-1);});
  const box=new THREE.Box3();for(const v of mesh.vertices)box.expandByPoint(new THREE.Vector3(...v));const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),scale=2/Math.max(size.x,size.y,size.z);if(!Number.isFinite(scale))throw Error('模型尺寸无效。');
  const norm=v=>[(v[0]-center.x)*scale,(v[1]-center.y)*scale,(v[2]-center.z)*scale];
  const pos=new Float32Array(mesh.faces.length*9);let offset=0;for(const face of mesh.faces)for(const i of face){pos.set(norm(mesh.vertices[i]),offset);offset+=3;}
  dispose(meshObject);dispose(lineObject);edges=mapped;normalized=edges.map(e=>[...norm(e.a),...norm(e.b)]);
  patchLabels=null;$('displayMode').value='probability';$('displayModeLabel').hidden=true;$('readoutInfo').textContent='对当前显示的模型运行分片，或加载对应的 segmentation.json。';
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(pos,3));geo.computeVertexNormals();
  meshObject=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0xe5e9ef,roughness:.85,metalness:0,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));scene.add(meshObject);
  lineObject=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({vertexColors:true}));lineObject.renderOrder=1;scene.add(lineObject);
  selected=null;highlight.geometry.dispose();highlight.geometry=new THREE.BufferGeometry();$('edgeInfo').textContent='点击模型上的边，查看原始概率和顶点编号。';$('modelName').textContent=name;$('faceCount').textContent=fmt(mesh.faces.length);$('edgeCount').textContent=fmt(edges.length);
  const valid=edges.filter(e=>Number.isFinite(e.p)).length;$('validCount').textContent=fmt(valid)+' 条有效预测';updateAppearance();reset();status(`已加载 · ${fmt(edges.length)} 条边匹配成功${valid<edges.length?' · '+fmt(edges.length-valid)+' 条无预测（灰色）':''}`);
}
function parseTable(buffer,name){const book=XLSX.read(buffer,{type:'array',raw:true});const sheet=book.Sheets[book.SheetNames[0]];return XLSX.utils.sheet_to_json(sheet,{defval:''});}
async function load(meshBuffer,probBuffer,meshName,probName,token){status('正在解析网格并核对每条边…');await new Promise(r=>setTimeout(r,30));if(token!==loadVersion)return;const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',meshBuffer))).map(b=>b.toString(16).padStart(2,'0')).join('');const mesh=meshName.toLowerCase().endsWith('.obj')?parseOBJ(new TextDecoder().decode(meshBuffer)):parsePLY(meshBuffer);install(mesh,parseTable(probBuffer,probName),meshName.split('/').pop().replace(/__epoch09__segmented\.ply$|\.obj$/i,''));currentMeshSHA=hash;}
function setBusy(value){busy=value;for(const id of ['loadSample','loadFiles','loadDesktop','chooseModel','chooseProbability','chooseDirectory','models'])$(id).disabled=value;if(!value)$('loadSample').disabled=!modelList.length;}
async function runLoad(fn){if(busy)return;const token=++loadVersion;setBusy(true);status('正在读取模型与概率文件…');try{await fn(token);}catch(e){console.error(e);status(e.message,true);}finally{if(token===loadVersion)setBusy(false);}}
async function readLocal(url){const r=await fetch(url);if(!r.ok)throw Error('文件读取失败，请重新选择文件。');return r.arrayBuffer();}
$('loadSample').onclick=()=>runLoad(async token=>{const m=modelList[Number($('models').value)];if(!m)throw Error('请先选择模型或模型文件夹。');const buffers=await Promise.all([m.mesh,m.probability].map(readLocal));await load(...buffers,m.meshName||m.mesh,m.probabilityName||m.probability,token);if(desktop){desktopMesh={name:m.meshName,url:m.mesh};desktopProbability={name:m.probabilityName,url:m.probability};activePair={mesh:m.mesh,probability:m.probability};refreshFiles();}});
$('loadFiles').onclick=()=>runLoad(async token=>{const m=$('meshFile').files[0],p=$('probFile').files[0];if(!m||!p)throw Error('请选择一个模型和对应的概率表。');await load(await m.arrayBuffer(),await p.arrayBuffer(),m.name,p.name,token);});
for(const id of ['color','contrast','threshold','surface','xray','auto','displayMode'])$(id).addEventListener('input',updateAppearance);
document.querySelectorAll('[data-color]').forEach(b=>b.onclick=()=>{$('color').value=b.dataset.color;updateAppearance();});$('reset').onclick=reset;
$('capture').onclick=async()=>{if(!meshObject){status('请先加载模型。',true);return;}renderer.render(scene,camera);const url=renderer.domElement.toDataURL('image/png'),name=$('modelName').textContent||'model';if(desktop){try{const saved=await desktop.saveImage(url,name);if(saved)status('图片已保存：'+saved);}catch(e){status(e.message,true);}return;}const a=document.createElement('a');a.download=name+'__probability.png';a.href=url;a.click();};
let down;renderer.domElement.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});
renderer.domElement.addEventListener('click',e=>{
  if(e.button!==0||!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>4||!lineObject)return;
  const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.params.Line.threshold=controls.target.distanceTo(camera.position)*.0025;ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);
  const hits=ray.intersectObject(lineObject);const surfaceHit=meshObject.visible&&!$('xray').checked?ray.intersectObject(meshObject)[0]:null;
  const hit=hits.find(h=>!surfaceHit||h.distance<=surfaceHit.distance+ray.params.Line.threshold*2);if(!hit){$('edgeInfo').textContent='此处未选中可见边，请靠近边线点击，或放大模型后选择。';return;}
  selected=shown[Math.floor(hit.index/2)];const edge=edges[selected];highlight.geometry.dispose();highlight.geometry=new THREE.BufferGeometry();highlight.geometry.setAttribute('position',new THREE.Float32BufferAttribute(normalized[selected],3));
  $('edgeInfo').innerHTML=`边 #${edge.id}<strong>${Number.isFinite(edge.p)?(edge.p*100).toFixed(4)+'%':'无预测'}</strong>原始概率：${Number.isFinite(edge.p)?edge.p:'nan'}<br>原 OBJ 顶点：${edge.va} ↔ ${edge.vb}`;
});
function refreshFiles(){for(const [id,file,empty] of [['desktopMeshName',desktopMesh,'未选择模型'],['desktopProbabilityName',desktopProbability,'未选择概率表']]){$(id).textContent=file?.name||empty;$(id).title=file?.name||empty;}}
function applySegmentation(data){
  if(!meshObject||data.schema!=='edgescope.segmentation.v1'||data.model_sha256!==currentMeshSHA)throw Error('分片标签与当前模型文件不一致，请加载读出时使用的原始模型。');
  const n=meshObject.geometry.attributes.position.count/3;
  if(data.face_count!==n||!Array.isArray(data.labels)||data.labels.length!==n||data.labels.some(i=>!Number.isInteger(i)||i<1||i>data.patch_count))throw Error('分片标签数量或编号无效。');
  patchLabels=data.labels;const palette=Array.from({length:data.patch_count},(_,i)=>new THREE.Color().setHSL((i*.61803398875)%1,.58,.66));const colors=new Float32Array(n*9);
  data.labels.forEach((label,i)=>{const c=palette[label-1];for(let j=0;j<3;j++)colors.set([c.r,c.g,c.b],i*9+j*3);});
  meshObject.geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));$('displayModeLabel').hidden=false;$('displayMode').value='patches';$('readoutInfo').textContent=`已载入 ${data.patch_count} 个分片。可切换“网络边概率 / 几何分片结果”对照。`;updateAppearance();status(`分片结果 · ${data.patch_count} 个片 · ${fmt(n)} 个三角形`);
}
function populateModels(models){modelList=models;$('models').replaceChildren();models.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m.name;$('models').appendChild(o);});if(!models.length){const o=document.createElement('option');o.textContent='未找到同名的模型 / 概率表';$('models').appendChild(o);}$('loadSample').disabled=!models.length;}
if(desktop){
  document.body.classList.add('desktop');$('desktopFiles').hidden=false;$('browserFiles').hidden=true;document.querySelector('.local').textContent='离线桌面版 · 1.0.0';
  $('chooseModel').onclick=async()=>{if(busy)return;try{const result=await desktop.chooseModel();if(result){desktopMesh=result.mesh;desktopProbability=result.probability;refreshFiles();status(result.probability?'已自动匹配同名概率表，点击加载即可。':'模型已选择，请选择对应的概率表。');}}catch(e){status(e.message,true);}};
  $('chooseProbability').onclick=async()=>{if(busy)return;try{const result=await desktop.chooseProbability();if(result){desktopProbability=result;refreshFiles();status('概率表已选择，点击“加载模型与概率”。');}}catch(e){status(e.message,true);}};
  $('loadDesktop').onclick=()=>runLoad(async token=>{if(!desktopMesh||!desktopProbability)throw Error('请先选择模型和对应的概率表。');const buffers=await Promise.all([desktopMesh.url,desktopProbability.url].map(readLocal));await load(...buffers,desktopMesh.name,desktopProbability.name,token);activePair={mesh:desktopMesh.url,probability:desktopProbability.url};});
  $('runReadout').onclick=async()=>{if(busy)return;if(!activePair){status('请先加载要分片的模型和概率表。',true);return;}setBusy(true);$('runReadout').disabled=true;$('chooseSegmentation').disabled=true;$('cancelReadout').hidden=false;status('请选择结果保存位置…');try{const result=await desktop.runReadout({...activePair,minFaces:Number($('minFaces').value),minArea:Number($('minArea').value)/100,normalSigma:Number($('normalSigma').value)});if(result){applySegmentation(result.segmentation);$('readoutInfo').textContent=`${result.report.patch_count} 个连通片；最小 ${result.report.minimum_patch_faces} 个三角形；强制合并 ${result.report.forced_merges} 次。结果：${result.directory}`;}else status('已取消选择保存位置。');}catch(e){status(e.message,true);}finally{setBusy(false);$('runReadout').disabled=false;$('chooseSegmentation').disabled=false;$('cancelReadout').hidden=true;}};
  $('cancelReadout').onclick=()=>desktop.cancelReadout();
  $('chooseSegmentation').onclick=async()=>{if(busy)return;try{const data=await desktop.chooseSegmentation();if(data)applySegmentation(data);}catch(e){status(e.message,true);}};
  desktop.onReadoutProgress(text=>{if(text){const last=text.trim().split('\n').pop();let message='正在计算与保存分片结果…';if(last.startsWith('Reading mesh'))message='正在校验模型与边概率对应关系…';else if(last.startsWith('Connected micro-regions:'))message='已生成初始区域，正在进行几何合并…';else if(last.startsWith('Energy-based merge:'))message='几何合并完成，正在检查区域尺度…';else if(last.startsWith('Minimum-support'))message='最小片尺度检查完成，正在调整边界…';else if(last.startsWith('Validated'))message='连通性检查完成，正在保存结果…';status(message);}});
  $('chooseDirectory').onclick=async()=>{if(busy)return;try{const result=await desktop.chooseDirectory();if(result){populateModels(result.models);$('directoryInfo').textContent=result.directory;$('directoryInfo').title=result.directory;status(result.models.length?`找到 ${result.models.length} 组模型，选择后点击加载。`:'此文件夹未找到同名配对文件，可用上方按钮分别选择模型和概率表。');}}catch(e){status(e.message,true);}};
  desktop.onCommand(name=>{const button=$(name);if(button&&!button.disabled)button.click();});
}
try{const response=await fetch('/api/models');if(!response.ok)throw Error('模型目录读取失败');populateModels(await response.json());if(modelList.length){const initial=modelList.findIndex(m=>m.name.startsWith('XAA3712010'));$('models').value=Math.max(initial,0);$('loadSample').click();}else{status('请选择模型和概率表，或选择模型文件夹开始使用。');$('modelName').textContent='打开你的三维模型';}}catch(e){status(e.message,true);}
