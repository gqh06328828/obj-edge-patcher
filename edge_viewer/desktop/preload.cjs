const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('edgeDesktop',Object.freeze({
  chooseModel:()=>ipcRenderer.invoke('choose-model'),
  chooseProbability:()=>ipcRenderer.invoke('choose-probability'),
  chooseDirectory:()=>ipcRenderer.invoke('choose-directory'),
  saveImage:(url,name)=>ipcRenderer.invoke('save-image',url,name),
  runReadout:options=>ipcRenderer.invoke('run-readout',options),
  cancelReadout:()=>ipcRenderer.invoke('cancel-readout'),
  chooseSegmentation:()=>ipcRenderer.invoke('choose-segmentation'),
  onReadoutProgress:callback=>ipcRenderer.on('readout-progress',(_event,text)=>callback(text)),
  onCommand:callback=>ipcRenderer.on('viewer-command',(_event,command)=>callback(command)),
}));
