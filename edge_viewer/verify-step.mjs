import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createSTEPGeometry} from './step-view.mjs';
const require=createRequire(import.meta.url);
const mesh={attributes:{position:{array:[10,0,0,12,0,0,10,2,0]}},index:{array:[0,1,2]},color:[1,0,0],brep_faces:[]};
const built=createSTEPGeometry({success:true,meshes:[mesh,{...mesh,color:[0,1,0]}]});
assert.equal(built.partCount,2);
assert.equal(built.geometry.attributes.position.count,6);
built.geometry.computeBoundingBox();
assert.deepEqual(built.geometry.boundingBox.min.toArray(),[-1,-1,0]);
assert.deepEqual(built.geometry.boundingBox.max.toArray(),[1,1,0]);
assert.deepEqual(Array.from(built.geometry.attributes.color.array.slice(0,3)),[1,0,0]);
assert.deepEqual(Array.from(built.geometry.attributes.color.array.slice(9,12)),[0,1,0]);
assert.equal(built.outline.attributes.position.count,12);
built.geometry.dispose();built.outline.dispose();
assert.throws(()=>createSTEPGeometry({success:false}));
assert.throws(()=>createSTEPGeometry({success:true,meshes:[{...mesh,index:{array:[0,1,99]}}]}));
const colored=createSTEPGeometry({success:true,meshes:[{...mesh,brep_faces:[{first:0,last:0,color:[0,0,1]}]}]});
assert.deepEqual(Array.from(colored.geometry.attributes.color.array.slice(0,3)),[0,0,1]);
colored.geometry.dispose();colored.outline.dispose();
// Two triangles in one CAD face stay one color; the adjacent CAD face differs.
const faceMesh={attributes:{position:{array:[0,0,0,1,0,0,0,1,0,1,1,0,2,0,0]}},index:{array:[0,1,2,1,3,2,1,4,3]},brep_faces:[{first:0,last:1},{first:2,last:2}]};
const faceView=createSTEPGeometry({success:true,meshes:[faceMesh,faceMesh]});
const faceData=faceView.geometry.userData,faceColor=triangle=>Array.from(faceData.brepColors.array.slice(triangle*9,triangle*9+3));
assert.equal(faceData.brepFaceCount,4);
assert.deepEqual(faceColor(0),faceColor(1));
assert.notDeepEqual(faceColor(1),faceColor(2));
assert.notDeepEqual(faceColor(0),faceColor(3));
assert.equal(faceData.originalColors,faceView.geometry.getAttribute('color'));
faceView.geometry.setAttribute('color',faceData.brepColors);
faceView.geometry.setAttribute('color',faceData.originalColors);
assert.equal(faceView.geometry.getAttribute('color'),faceData.originalColors);
faceView.geometry.dispose();faceView.outline.dispose();
const incomplete=createSTEPGeometry({success:true,meshes:[{...faceMesh,brep_faces:[{first:0,last:0}]}]});
assert.equal(incomplete.geometry.userData.brepColors,undefined);
incomplete.geometry.dispose();incomplete.outline.dispose();
const occt=await require('./vendor/occt-import-js.js')();
assert.equal(occt.ReadStepFile(new TextEncoder().encode('invalid STEP'),null).success,false);
for(const file of process.argv.slice(2)){
  const result=occt.ReadStepFile(fs.readFileSync(file),null),geometry=createSTEPGeometry(result);
  assert.ok(geometry.geometry.attributes.position.count>0);
  assert.ok(geometry.geometry.attributes.position.array.every(Number.isFinite));
  assert.ok(geometry.geometry.userData.brepFaceCount>0,'Real STEP must retain CAD face ranges');
  const data=geometry.geometry.userData,unique=new Set();
  let triangleOffset=0;
  for(const mesh of result.meshes){
    for(const face of mesh.brep_faces){
      const start=(triangleOffset+face.first)*9,color=Array.from(data.brepColors.array.slice(start,start+3));
      unique.add(color.join(','));
      for(let i=start;i<(triangleOffset+face.last+1)*9;i+=3)assert.deepEqual(Array.from(data.brepColors.array.slice(i,i+3)),color);
    }
    triangleOffset+=mesh.index.array.length/3;
  }
  assert.equal(unique.size,data.brepFaceCount,'Every CAD face must have a distinct color');
  console.log(`PASS ${data.brepFaceCount} BREP faces: uniform per-face colors, all faces distinct`);
  console.log(`PASS ${file}: ${geometry.partCount} meshes, ${geometry.geometry.attributes.position.count/3} triangles`);
  geometry.geometry.dispose();geometry.outline.dispose();
}
console.log('PASS STEP normalization, multiple meshes, face colors, outline, invalid geometry and parser failure');
