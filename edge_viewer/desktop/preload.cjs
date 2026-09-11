const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('edgeDesktop',Object.freeze({
  setTheme:value=>ipcRenderer.invoke('set-theme',value),
  chooseStep:()=>ipcRenderer.invoke('choose-step'),
  chooseStepDirectory:()=>ipcRenderer.invoke('choose-step-directory'),
  chooseModel:()=>ipcRenderer.invoke('choose-model'),
  clearReadout:()=>ipcRenderer.invoke('clear-readout'),
  downloadReadout:()=>ipcRenderer.invoke('download-readout'),
  chooseDirectory:()=>ipcRenderer.invoke('choose-directory'),
  saveImage:(url,name,view)=>ipcRenderer.invoke('save-image',url,name,view),
  saveMerged:options=>ipcRenderer.invoke('save-merged-readout',options),
  runReadout:options=>ipcRenderer.invoke('run-readout',options),
  cancelReadout:()=>ipcRenderer.invoke('cancel-readout'),
  chooseSegmentation:()=>ipcRenderer.invoke('choose-segmentation'),
  onReadoutProgress:callback=>ipcRenderer.on('readout-progress',(_event,text)=>callback(text)),
  onCommand:callback=>ipcRenderer.on('viewer-command',(_event,command)=>callback(command)),
}));
