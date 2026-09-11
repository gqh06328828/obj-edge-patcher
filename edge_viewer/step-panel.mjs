import * as THREE from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {registerView,updateView} from './view-settings.mjs';
import {parseSTEP,createSTEPGeometry} from './step-view.mjs';

// The CAD panel owns its renderer, model, camera, controls and loading state.
// It never clears or modifies the probability panel's readout results.
const $=id=>document.getElementById(id),desktop=window.edgeDesktop,fmt=n=>n.toLocaleString('en-US');
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0xf3f5f8);
$('stepStage').appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,.01,100);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.autoRotateSpeed=.65;
scene.add(new THREE.HemisphereLight(0xffffff,0x8b96ac,2.2));
const light=new THREE.DirectionalLight(0xffffff,2.5);light.position.set(3,5,4);scene.add(light);
let meshObject,lineObject,files=[],busy=false,currentIndex=-1;
function status(text,error=false){$('stepStatus').textContent=text;$('stepStatus').classList.toggle('error',error);}
function reset(){camera.position.set(2.6,1.9,3.1).setLength(1.9/Math.sin(Math.atan(Math.tan(camera.fov*Math.PI/360)*Math.min(1,Math.max(.3,camera.aspect)))));controls.target.set(0,0,0);controls.update();}reset();
new ResizeObserver(()=>{
  const {width,height}=$('stepStage').getBoundingClientRect();if(!width||!height)return;
  renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();
}).observe($('stepStage'));
registerView('step',{camera,controls,renderer,autoInput:$('stepAuto')});
renderer.setAnimationLoop(()=>{updateView('step');renderer.render(scene,camera);});
function dispose(object){if(object){scene.remove(object);object.geometry.dispose();object.material.dispose();}}
function setBusy(value){
  busy=value;for(const id of ['chooseStep','chooseStepDirectory','stepModels'])$(id).disabled=value;
  $('previousStep').disabled=value||currentIndex<=0;$('nextStep').disabled=value||currentIndex<0||currentIndex>=files.length-1;
  $('colorBrep').disabled=value||!meshObject?.geometry.userData.brepColors;
}
function appearance(){
  controls.autoRotate=$('stepAuto').checked;
  if(meshObject)meshObject.visible=$('stepSurface').checked;
  if(lineObject){lineObject.material.color.set($('stepColor').value);lineObject.material.depthTest=true;}
}
async function run(action){
  if(busy)return;setBusy(true);
  try{await action();}catch(error){console.error(error);status(error.message,true);}finally{setBusy(false);}
}
async function open(file){
  status('正在读取 STEP 文件…');
  let buffer;
  if(file.url){const response=await fetch(file.url);if(!response.ok)throw Error('STEP 文件读取失败，请重新选择。');buffer=await response.arrayBuffer();}
  else buffer=await file.arrayBuffer();
  status('正在解析 STEP 曲面…');
  const built=createSTEPGeometry(await parseSTEP(buffer));
  dispose(meshObject);dispose(lineObject);
  meshObject=new THREE.Mesh(built.geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.65,metalness:.1,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));
  lineObject=new THREE.LineSegments(built.outline,new THREE.LineBasicMaterial({color:$('stepColor').value}));lineObject.renderOrder=1;
  scene.add(meshObject,lineObject);
  $('stepModelName').textContent=file.name;$('stepModelName').title=file.name;
  $('stepFaceCount').textContent=fmt(built.geometry.attributes.position.count/3);
  $('stepBrepCount').textContent=built.geometry.userData.brepFaceCount?fmt(built.geometry.userData.brepFaceCount):'—';
  $('stepPartCount').textContent=fmt(built.partCount);
  $('colorBrep').textContent='按 BREP 面着色';$('colorBrep').setAttribute('aria-pressed','false');
  $('brepInfo').textContent=built.geometry.userData.brepFaceCount?`共 ${fmt(built.geometry.userData.brepFaceCount)} 个 BREP 面，可为每个面单独着色。`:'此 STEP 没有完整的 BREP 面信息，无法按面着色。';
  appearance();reset();status('已加载 STEP · '+built.partCount+' 个网格部件');
}
function populate(items,directory){
  $('stepModelsLabel').hidden=false;files=items;$('stepModels').replaceChildren();
  files.forEach((file,i)=>{const option=document.createElement('option');option.value=i;option.textContent=file.name;$('stepModels').appendChild(option);});
  currentIndex=files.length?0:-1;$('stepNavigation').hidden=!files.length;
  if(!files.length){const option=document.createElement('option');option.textContent='此文件夹没有 STEP / STP 文件';$('stepModels').appendChild(option);}
  $('stepDirectoryInfo').textContent=directory;setBusy(busy);
  $('stepPosition').textContent=files.length?'1 / '+files.length:'';status(files.length?'找到 '+files.length+' 个 STEP 文件。':'此文件夹当前层没有 STEP / STP 文件。');
}
$('chooseStep').onclick=()=>{
  if(busy)return;if(!desktop){$('stepFile').click();return;}
  run(async()=>{const file=await desktop.chooseStep();if(file){await open(file);files=[];currentIndex=-1;$('stepModelsLabel').hidden=true;$('stepModels').replaceChildren();$('stepNavigation').hidden=true;$('stepPosition').textContent='单文件模式';$('stepDirectoryInfo').textContent=file.name;}});
};
$('chooseStepDirectory').onclick=()=>{
  if(busy)return;if(!desktop){$('stepDirectory').click();return;}
  run(async()=>{const result=await desktop.chooseStepDirectory();if(result){populate(result.files,result.directory);if(files.length)await navigate(0);}});
};
$('stepFile').onchange=()=>{const file=$('stepFile').files[0];$('stepFile').value='';if(file)run(async()=>{await open(file);files=[];currentIndex=-1;$('stepModelsLabel').hidden=true;$('stepModels').replaceChildren();$('stepNavigation').hidden=true;$('stepPosition').textContent='单文件模式';$('stepDirectoryInfo').textContent=file.name;});};
$('stepDirectory').onchange=()=>{
  const items=Array.from($('stepDirectory').files),folder=items[0]?.webkitRelativePath.split('/')[0]||'所选文件夹';
  populate(items.filter(f=>/\.(step|stp)$/i.test(f.name)&&f.webkitRelativePath.split('/').length===2).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true})),folder);$('stepDirectory').value='';if(files.length)run(()=>navigate(0));
};
async function navigate(index){
  if(index<0||index>=files.length)return;
  try{await open(files[index]);currentIndex=index;}finally{$('stepModels').value=String(currentIndex);$('stepPosition').textContent=(currentIndex+1)+' / '+files.length;}
}
$('stepModels').onchange=()=>run(()=>navigate(Number($('stepModels').value)));
$('previousStep').onclick=()=>run(()=>navigate(currentIndex-1));
$('nextStep').onclick=()=>run(()=>navigate(currentIndex+1));
$('colorBrep').onclick=()=>{
  if(busy||!meshObject?.geometry.userData.brepColors)return;
  const geometry=meshObject.geometry,enabled=$('colorBrep').getAttribute('aria-pressed')!=='true';
  geometry.setAttribute('color',enabled?geometry.userData.brepColors:geometry.userData.originalColors);
  $('colorBrep').setAttribute('aria-pressed',String(enabled));$('colorBrep').textContent=enabled?'恢复 STEP 原始颜色':'按 BREP 面着色';
  status(enabled?`已按 ${fmt(geometry.userData.brepFaceCount)} 个 BREP 面着色`:'已恢复 STEP 原始颜色');
};
for(const id of ['stepColor','stepSurface','stepAuto'])$(id).addEventListener('input',appearance);
$('stepReset').onclick=reset;
$('stepCapture').onclick=async()=>{
  if(!meshObject){status('请先加载 STEP。',true);return;}
  renderer.render(scene,camera);const url=renderer.domElement.toDataURL('image/png'),name=$('stepModelName').textContent;
  if(desktop){try{const saved=await desktop.saveImage(url,name,'step');if(saved)status('STEP 图片已保存：'+saved);}catch(error){status(error.message,true);}return;}
  const a=document.createElement('a');a.download=name+'__step.png';a.href=url;a.click();
};
setBusy(false);
