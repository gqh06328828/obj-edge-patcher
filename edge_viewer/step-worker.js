// Keep the CAD kernel off the UI thread; each import gets a fresh worker.
importScripts('./vendor/occt-import-js.js');
self.onmessage=async ({data})=>{
  try{
    const occt=await occtimportjs({locateFile:name=>new URL('./vendor/'+name,self.location.href).href});
    const result=occt.ReadStepFile(new Uint8Array(data),null);
    if(!result.success||!result.meshes?.length)throw Error('STEP 文件无法解析，或不包含可显示的曲面 / 实体。');
    self.postMessage({result});
  }catch(error){self.postMessage({error:error.message||'STEP 解析失败。'});}
};
