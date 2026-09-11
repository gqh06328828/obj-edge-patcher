const views=new Map();let copying=false,leader='step';
const sync=document.getElementById('syncViews'),theme=document.getElementById('theme');
export const isDark=()=>document.documentElement.dataset.theme==='dark';
function applyTheme(value){
  document.documentElement.dataset.theme=value;theme.value=value;
  window.edgeDesktop?.setTheme?.(value)?.catch(()=>{});
  try{localStorage.setItem('edgescope-theme',value);}catch{}
  for(const view of views.values()){view.renderer.setClearColor(isDark()?0x151c27:0xf3f5f8);view.onTheme?.();}
}
let saved;try{saved=localStorage.getItem('edgescope-theme');}catch{}
applyTheme(saved==='dark'?'dark':'light');
theme.onchange=()=>applyTheme(theme.value);
function copyFrom(id){
  if(copying||!sync.checked)return;
  const source=views.get(id);if(!source)return;
  copying=true;
  try{for(const [otherId,other] of views){
    if(otherId===id)continue;
    other.controls.autoRotate=false;
    // Flush any old damping before installing the authoritative camera pose.
    other.controls.update();
    other.camera.position.copy(source.camera.position);other.camera.up.copy(source.camera.up);
    other.controls.target.copy(source.controls.target);other.camera.zoom=source.camera.zoom;
    other.camera.fov=source.camera.fov;other.camera.updateProjectionMatrix();other.controls.update();
  }}finally{copying=false;}
}
export function registerView(id,view){
  views.set(id,view);view.renderer.setClearColor(isDark()?0x151c27:0xf3f5f8);
  view.controls.addEventListener('start',()=>{leader=id;});
  view.controls.addEventListener('change',()=>copyFrom(id));
  view.autoInput.addEventListener('input',()=>{leader=id;});
}
export function updateView(id){
  const view=views.get(id);
  view.controls.autoRotate=view.autoInput.checked&&(!sync.checked||leader===id);
  if(!sync.checked||leader===id)view.controls.update();
}
sync.onchange=()=>{
  copying=true;
  for(const view of views.values()){view.controls.autoRotate=false;view.controls.enableDamping=false;view.controls.update();view.controls.enableDamping=!sync.checked;}
  copying=false;leader=views.has('step')?'step':'probability';copyFrom(leader);
};
