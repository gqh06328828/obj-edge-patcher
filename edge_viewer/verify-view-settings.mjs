import assert from 'node:assert/strict';
import {PerspectiveCamera,Vector3,EventDispatcher} from './vendor/three.module.js';
const sync={checked:false},theme={value:'light'};
globalThis.document={documentElement:{dataset:{}},getElementById:id=>id==='syncViews'?sync:theme};
globalThis.window={};globalThis.localStorage={getItem:()=>null,setItem(){}};
const {registerView,updateView}=await import('./view-settings.mjs');
class Controls extends EventDispatcher{
  constructor(camera){super();this.camera=camera;this.target=new Vector3();this.enableDamping=true;this.autoRotate=false;}
  update(){this.camera.lookAt(this.target);this.dispatchEvent({type:'change'});}
}
function view(){const camera=new PerspectiveCamera(40,1,.01,100);camera.position.set(2,3,4);return {camera,controls:new Controls(camera),renderer:{setClearColor(value){this.background=value;}},autoInput:{checked:false,addEventListener(_event,callback){this.callback=callback;}}};}
const left=view(),right=view();right.camera.position.set(9,8,7);registerView('step',left);registerView('probability',right);
sync.checked=true;sync.onchange();assert.deepEqual(right.camera.position.toArray(),left.camera.position.toArray());
right.controls.dispatchEvent({type:'start'});right.camera.position.set(-4,2,6);right.controls.target.set(1,2,3);right.camera.zoom=1.7;right.controls.update();
assert.deepEqual(left.camera.position.toArray(),[-4,2,6]);assert.deepEqual(left.controls.target.toArray(),[1,2,3]);assert.equal(left.camera.zoom,1.7);
assert.deepEqual(left.camera.quaternion.toArray(),right.camera.quaternion.toArray());
right.autoInput.checked=true;right.autoInput.callback();updateView('step');updateView('probability');assert.equal(left.controls.autoRotate,false);assert.equal(right.controls.autoRotate,true);
sync.checked=false;sync.onchange();const before=left.camera.position.clone();right.camera.position.set(20,30,40);right.controls.update();assert.deepEqual(left.camera.position.toArray(),before.toArray());
assert.equal(left.controls.enableDamping,true);
theme.value='dark';theme.onchange();assert.equal(document.documentElement.dataset.theme,'dark');assert.equal(left.renderer.background,0x151c27);assert.equal(right.renderer.background,0x151c27);
theme.value='light';theme.onchange();assert.equal(left.renderer.background,0xf3f5f8);
console.log('PASS bidirectional camera/target/zoom synchronization, unlink independence, auto-rotation leadership and both themes');
